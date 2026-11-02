// WebSocket bridge to the Chrome extension: 127.0.0.1 only, origin-checked, one connection (newest wins),
// request/response by id with timeouts.
import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { logErr } from './log.js';

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
  const pending = new Map(); // id -> {resolve, reject, timer, ws}
  const waiters = new Set();
  const conns = new WeakMap(); // ws -> {nonce, authed, info, timer}

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

  httpServer.on('upgrade', (req, sock, head) => {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      log(`rejected WebSocket from origin ${JSON.stringify(origin || null)}`);
      sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      sock.destroy();
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

  function start() {
    return new Promise((resolve) => {
      const onError = (err) => {
        httpServer.off('listening', onListening);
        startError = err.code === 'EADDRINUSE' ? portInUseMessage(port) : `cannot listen on ${host}:${port}: ${err.message}`;
        log(startError);
        resolve({ ok: false, error: startError });
      };
      const onListening = () => {
        httpServer.off('error', onError);
        httpServer.on('error', (e) => log('bridge http error:', e.message));
        listeningPort = httpServer.address().port;
        log(`bridge listening on ws://${host}:${listeningPort}`);
        resolve({ ok: true, port: listeningPort });
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(port, host);
    });
  }

  async function close() {
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new BridgeError('server shutting down'));
    }
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
    get port() {
      return listeningPort;
    },
    get startError() {
      return startError;
    },
    get extension() {
      return extInfo;
    },
  };
}
