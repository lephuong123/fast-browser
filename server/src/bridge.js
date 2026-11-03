// WebSocket bridge to the Chrome extension: 127.0.0.1 only, origin-checked, one connection (newest wins),
// request/response by id with timeouts.
//
// Several MCP servers (one per Claude session) share ONE extension. The first server to bind the port is the
// "primary": the extension connects to it. A server that finds the port taken connects to the primary as a "peer"
// (ws://host:port/peer, token handshake) and forwards every request through it. When the primary goes away the
// peers race to bind the port; the winner becomes primary (the extension reconnects to it on its own), the others
// become its peers.
import crypto from 'node:crypto';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { logErr } from './log.js';

export const PEER_PATH = '/peer';
const PEER_MIN_TIMEOUT_MS = 1_000;
const PEER_MAX_TIMEOUT_MS = 600_000;
const PEER_HANDSHAKE_MAX_MS = 3_000;
const TAKEOVER_BACKOFF_MIN_MS = 100;
const TAKEOVER_BACKOFF_MAX_MS = 2_000;

export const DEFAULT_TIMEOUT_MS = 60_000;
export const ACT_TIMEOUT_MS = 120_000;

export class BridgeError extends Error {
  constructor(message, snapshot) {
    super(message);
    this.name = 'BridgeError';
    if (snapshot) this.snapshot = snapshot;
  }
}

export function portInUseMessage(port) {
  return `port ${port} in use — another Fast Browser server is running; close it or set FB_PORT`;
}

export const AUTH_TIMEOUT_MS = 10_000;

/** HMAC-SHA256(token, message) as lowercase hex — same as the extension's WebCrypto computation. */
export function authProof(token, message) {
  return crypto.createHmac('sha256', token).update(String(message)).digest('hex');
}

function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Handshake when a token is configured (always, in the real server):
//   ext → {type:"hello", version, extensionId, nonce}
//   srv → {type:"config", allowedDomains, nonce:<srvNonce>, proof:HMAC(token,"server:"+nonce)}   (ext verifies)
//   ext → {type:"auth", proof:HMAC(token,"ext:"+srvNonce)}                                        (srv verifies)
// Only an authenticated connection becomes the active one ("newest authenticated wins"), so an unauthenticated
// client can neither receive requests nor evict the real extension.
export function createBridge({
  port = 17890,
  host = '127.0.0.1',
  extensionId = null,
  allowedDomains = [],
  token = null,
  authTimeoutMs = AUTH_TIMEOUT_MS,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  connectWaitMs = 3000,
  log = logErr,
} = {}) {
  let socket = null;
  let extInfo = null;
  let startError = null;
  let listeningPort = null;
  let nextId = 1;
  let role = null; // 'primary' (holds the port, extension connects here) | 'peer' (forwards to the primary)
  let peerWs = null; // peer mode: authenticated connection to the primary
  let closed = false;
  let takingOver = null; // promise while a lost peer is re-electing
  const pending = new Map(); // id -> {resolve, reject, timer, ws}
  const waiters = new Set(); // extension connected (primary)
  const routeWaiters = new Set(); // a route exists again (peer reconnected or became primary)
  const conns = new WeakMap(); // ws -> {nonce, authed, info, timer}
  const peers = new Set(); // primary mode: authenticated peer connections

  const httpServer = http.createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('Fast Browser bridge: WebSocket only\n');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  function originAllowed(origin) {
    if (!origin) return false;
    if (extensionId) return origin === `chrome-extension://${extensionId}`;
    return origin.startsWith('chrome-extension://');
  }

  function forbid(sock) {
    sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    sock.destroy();
  }

  httpServer.on('upgrade', (req, sock, head) => {
    const origin = req.headers.origin;
    if (req.url === PEER_PATH) {
      // Peers are local Node processes: no Origin header (a browser page always sends one, so pages cannot use
      // this path), and they must prove they hold the token file.
      if (origin || !token) {
        log(`rejected peer WebSocket (${origin ? 'has an Origin' : 'no token configured'})`);
        forbid(sock);
        return;
      }
      wss.handleUpgrade(req, sock, head, (ws) => attachPeer(ws));
      return;
    }
    if (!originAllowed(origin)) {
      log(`rejected WebSocket from origin ${JSON.stringify(origin || null)}`);
      forbid(sock);
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => attach(ws));
  });

  function send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      log('send failed:', e.message);
    }
  }

  function failPending(ws, message) {
    for (const [id, p] of pending) {
      if (p.ws !== ws) continue;
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new BridgeError(message));
    }
  }

  function attach(ws) {
    const c = { nonce: crypto.randomBytes(16).toString('hex'), authed: false, info: null, timer: null };
    conns.set(ws, c);
    ws.on('message', (data) => onMessage(ws, data));
    ws.on('close', () => {
      clearTimeout(c.timer);
      if (socket === ws) {
        socket = null;
        extInfo = null;
        log('extension disconnected');
      }
      failPending(ws, 'extension disconnected before answering; retry');
    });
    ws.on('error', (e) => log('ws error:', e.message));
    if (!token) {
      promote(ws);
      return;
    }
    c.timer = setTimeout(() => {
      if (!c.authed) {
        log('closing WebSocket that did not authenticate in time');
        try {
          ws.close(4001, 'authentication timeout');
        } catch {
          /* ignore */
        }
      }
    }, authTimeoutMs);
  }

  // Make ws the active connection; the previous one (if any) is replaced.
  function promote(ws) {
    const c = conns.get(ws);
    c.authed = true;
    clearTimeout(c.timer);
    if (socket && socket !== ws) {
      const old = socket;
      socket = null;
      failPending(old, 'extension reconnected (a newer connection replaced this one); retry');
      try {
        old.close(4000, 'replaced by newer connection');
      } catch {
        /* ignore */
      }
    }
    socket = ws;
    extInfo = c.info;
    log('extension connected');
    if (token) send(ws, { type: 'ready' });
    for (const w of [...waiters]) w();
  }

  function onMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      log('ignored non-JSON message from extension');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hello': {
        const c = conns.get(ws);
        c.info = { version: msg.version ?? null, extensionId: msg.extensionId ?? null };
        if (ws === socket) extInfo = c.info;
        if (!token) {
          send(ws, { type: 'config', allowedDomains });
          return;
        }
        if (typeof msg.nonce !== 'string' || msg.nonce.length < 16) {
          log('rejected hello without a nonce (outdated extension?)');
          try {
            ws.close(4002, 'hello must carry a nonce; update the Fast Browser extension');
          } catch {
            /* ignore */
          }
          return;
        }
        send(ws, { type: 'config', allowedDomains, nonce: c.nonce, proof: authProof(token, 'server:' + msg.nonce) });
        return;
      }
      case 'auth': {
        const c = conns.get(ws);
        if (!token || c.authed) return;
        if (sameHex(msg.proof, authProof(token, 'ext:' + c.nonce))) {
          promote(ws);
        } else {
          log('rejected WebSocket: wrong auth proof (token mismatch)');
          try {
            ws.close(4003, 'authentication failed: token mismatch');
          } catch {
            /* ignore */
          }
        }
        return;
      }
      case 'ping':
        if (token && !conns.get(ws).authed) return;
        send(ws, { type: 'pong' });
        return;
      case 'res': {
        const p = pending.get(msg.id);
        if (!p || p.ws !== ws) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new BridgeError(msg.error?.message || 'extension returned an error', msg.error?.snapshot));
        return;
      }
      default:
        return;
    }
  }

  // ---- primary side of a peer connection ------------------------------------------------------------------
  // Handshake (proof prefixes differ from the extension's so proofs cannot be replayed across the two):
  //   peer → {type:"peer-hello", nonce}
  //   prim → {type:"peer-config", nonce:<primNonce>, proof:HMAC(token,"primary:"+nonce)}   (peer verifies)
  //   peer → {type:"peer-auth", proof:HMAC(token,"peer:"+primNonce)}                     (prim verifies)
  //   prim → {type:"peer-ready"}
  // Then peer → {type:"req", id, method, params, timeoutMs}; prim → {type:"res", id, ok, result | error}.
  function attachPeer(ws) {
    const c = { nonce: crypto.randomBytes(16).toString('hex'), authed: false };
    const timer = setTimeout(() => {
      if (!c.authed) closeQuietly(ws, 4001, 'authentication timeout');
    }, authTimeoutMs);
    ws.on('error', (e) => log('peer ws error:', e.message));
    ws.on('close', () => {
      clearTimeout(timer);
      if (peers.delete(ws)) log(`peer disconnected (${peers.size} left)`);
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'peer-hello' && !c.authed) {
        if (typeof msg.nonce !== 'string' || msg.nonce.length < 16) return closeQuietly(ws, 4002, 'peer-hello needs a nonce');
        send(ws, { type: 'peer-config', nonce: c.nonce, proof: authProof(token, 'primary:' + msg.nonce) });
        return;
      }
      if (msg.type === 'peer-auth' && !c.authed) {
        if (!sameHex(msg.proof, authProof(token, 'peer:' + c.nonce))) {
          log('rejected peer: wrong auth proof (token mismatch)');
          return closeQuietly(ws, 4003, 'authentication failed: token mismatch');
        }
        c.authed = true;
        clearTimeout(timer);
        peers.add(ws);
        log(`peer connected (${peers.size} total)`);
        send(ws, { type: 'peer-ready' });
        return;
      }
      if (msg.type === 'req' && c.authed) {
        const t = Number(msg.timeoutMs);
        const timeoutMs = Number.isFinite(t) ? Math.min(Math.max(t, PEER_MIN_TIMEOUT_MS), PEER_MAX_TIMEOUT_MS) : defaultTimeoutMs;
        const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
        request(String(msg.method), params, { timeoutMs }).then(
          (result) => send(ws, { id: msg.id, type: 'res', ok: true, result }),
          (e) => send(ws, { id: msg.id, type: 'res', ok: false, error: { message: e?.message || String(e), snapshot: e?.snapshot } }),
        );
      }
    });
  }

  function closeQuietly(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  // ---- peer side ------------------------------------------------------------------------------------------
  /** Connect to the server holding the port as a peer. Resolves {ok:true} once authenticated, else {ok:false, error}. */
  function connectAsPeer() {
    return new Promise((resolve) => {
      if (!token) return resolve({ ok: false, error: 'no token configured' });
      const ws = new WebSocket(`ws://${host}:${port}${PEER_PATH}`, { maxPayload: 64 * 1024 * 1024 });
      const nonce = crypto.randomBytes(16).toString('hex');
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!r.ok) {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
        }
        resolve(r);
      };
      // Short: a real primary answers in milliseconds; this only bounds startup when the port belongs to something else.
      const timer = setTimeout(
        () => finish({ ok: false, error: 'the server on this port did not answer the peer handshake' }),
        Math.min(authTimeoutMs, PEER_HANDSHAKE_MAX_MS),
      );
      ws.on('open', () => send(ws, { type: 'peer-hello', nonce, pid: process.pid }));
      ws.on('unexpected-response', (req, res) => finish({ ok: false, error: `the server on this port refused a peer (HTTP ${res.statusCode})` }));
      ws.on('error', (e) => finish({ ok: false, error: e.message }));
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'peer-config') {
          if (!sameHex(msg.proof, authProof(token, 'primary:' + nonce))) {
            return finish({ ok: false, error: 'the server on this port did not authenticate (not Fast Browser, or a different token)' });
          }
          send(ws, { type: 'peer-auth', proof: authProof(token, 'peer:' + msg.nonce) });
          return;
        }
        if (msg.type === 'peer-ready') {
          role = 'peer';
          peerWs = ws;
          log(`port ${port} is held by another Fast Browser server; sharing its extension connection as a peer`);
          for (const w of [...routeWaiters]) w();
          finish({ ok: true });
          return;
        }
        if (msg.type === 'res' && ws === peerWs) {
          const p = pending.get(msg.id);
          if (!p || p.ws !== ws) return;
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new BridgeError(msg.error?.message || 'extension returned an error', msg.error?.snapshot));
        }
      });
      ws.on('close', () => {
        if (!done) return finish({ ok: false, error: 'the server on this port closed the peer connection' });
        if (ws !== peerWs) return;
        peerWs = null;
        failPending(ws, 'the Fast Browser server holding the port went away before answering; retry');
        if (!closed) {
          log('lost the primary Fast Browser server; taking over or re-joining');
          takeover();
        }
      });
    });
  }

  // After losing the primary: bind the port (become primary) or join whoever did. Retries until closed.
  function takeover() {
    if (takingOver) return takingOver;
    takingOver = (async () => {
      let backoff = TAKEOVER_BACKOFF_MIN_MS;
      while (!closed) {
        const l = await listen();
        if (l.ok) {
          if (closed) await new Promise((r) => httpServer.close(() => r())); // closed while we were binding
          break;
        }
        if (l.code === 'EADDRINUSE' && (await connectAsPeer()).ok) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, TAKEOVER_BACKOFF_MAX_MS);
      }
    })().finally(() => {
      takingOver = null;
    });
    return takingOver;
  }

  function waitForRoute(ms) {
    if (role === 'primary' || peerWs) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = () => {
        clearTimeout(t);
        routeWaiters.delete(w);
        resolve(true);
      };
      const t = setTimeout(() => {
        routeWaiters.delete(w);
        resolve(false);
      }, ms);
      routeWaiters.add(w);
    });
  }

  function requestViaPeer(method, params, timeoutMs) {
    const ws = peerWs;
    const id = nextId++;
    // The primary may itself wait for the extension (connectWaitMs) before its own timeout starts.
    const localTimeout = timeoutMs + connectWaitMs + 2_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BridgeError(`extension did not answer ${method} within ${Math.round(timeoutMs / 1000)}s (via the primary server)`));
      }, localTimeout);
      pending.set(id, { resolve, reject, timer, ws });
      try {
        ws.send(JSON.stringify({ id, type: 'req', method, params, timeoutMs }));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new BridgeError(`failed to send ${method} to the primary server: ${e.message}`));
      }
    });
  }

  function waitForConnection(ms) {
    if (socket) return Promise.resolve(true);
    if (!(ms > 0)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const w = () => {
        clearTimeout(t);
        waiters.delete(w);
        resolve(true);
      };
      const t = setTimeout(() => {
        waiters.delete(w);
        resolve(false);
      }, ms);
      waiters.add(w);
    });
  }

  async function request(method, params = {}, { timeoutMs = defaultTimeoutMs } = {}) {
    if (startError) throw new BridgeError(startError);
    if (role === 'peer' && !peerWs) {
      // Re-election in progress (primary went away). Peers win the port within ~a second in practice.
      await waitForRoute(Math.max(connectWaitMs, 5_000));
    }
    if (role === 'peer') {
      if (!peerWs) throw new BridgeError('lost the Fast Browser server holding the port and could not re-join yet; retry');
      return requestViaPeer(method, params, timeoutMs);
    }
    if (!socket && !(await waitForConnection(connectWaitMs))) {
      throw new BridgeError(
        `Chrome extension not connected — open Chrome with the Fast Browser extension enabled (it connects to ws://${host}:${listeningPort ?? port}; ` +
          `first time: paste the token from ~/.fast-browser/token into the extension popup)`,
      );
    }
    const ws = socket;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BridgeError(`extension did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, ws });
      try {
        ws.send(JSON.stringify({ id, type: 'req', method, params }));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new BridgeError(`failed to send ${method} to extension: ${e.message}`));
      }
    });
  }

  let httpErrorLogged = false;
  /** Try to bind the port once. {ok:true, port} → primary; {ok:false, code, error} otherwise. */
  function listen() {
    return new Promise((resolve) => {
      const onError = (err) => {
        httpServer.off('listening', onListening);
        resolve({ ok: false, code: err.code, error: err.message });
      };
      const onListening = () => {
        httpServer.off('error', onError);
        if (!httpErrorLogged) {
          httpErrorLogged = true;
          httpServer.on('error', (e) => log('bridge http error:', e.message));
        }
        role = 'primary';
        listeningPort = httpServer.address().port;
        log(`bridge listening on ws://${host}:${listeningPort}`);
        for (const w of [...routeWaiters]) w();
        resolve({ ok: true, port: listeningPort });
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(port, host);
    });
  }

  async function start() {
    const l = await listen();
    if (l.ok) return { ok: true, port: l.port, role: 'primary' };
    if (l.code === 'EADDRINUSE') {
      const p = await connectAsPeer();
      if (p.ok) return { ok: true, port, role: 'peer' };
      startError = `${portInUseMessage(port)} (could not share it: ${p.error})`;
    } else {
      startError = `cannot listen on ${host}:${port}: ${l.error}`;
    }
    log(startError);
    return { ok: false, error: startError };
  }

  async function close() {
    closed = true;
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new BridgeError('server shutting down'));
    }
    if (peerWs) peerWs.terminate();
    peerWs = null;
    for (const p of peers) closeQuietly(p, 4010, 'primary shutting down');
    peers.clear();
    if (socket) socket.terminate();
    socket = null;
    for (const c of wss.clients) c.terminate();
    wss.close();
    if (httpServer.listening) await new Promise((r) => httpServer.close(() => r()));
  }

  return {
    start,
    request,
    close,
    waitForConnection,
    isConnected: () => !!socket,
    get role() {
      return role;
    },
    get peerCount() {
      return peers.size;
    },
    /** True when another session uses the same extension (we are a peer, or we are a primary with peers). */
    get shared() {
      return role === 'peer' || peers.size > 0;
    },
    get port() {
      return role === 'peer' ? port : listeningPort;
    },
    get startError() {
      return startError;
    },
    get extension() {
      return extInfo;
    },
  };
}
