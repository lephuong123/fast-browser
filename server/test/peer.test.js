// Several servers (one per Claude session) sharing one extension: peer forwarding, auth, failover, per-session tabs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createBridge, BridgeError, PEER_PATH } from '../src/bridge.js';
import { createToolHandlers } from '../src/tools.js';
import { connectFakeExtension, waitFor } from '../test-support/helpers.js';

const quiet = () => {};
const TOKEN = 'b'.repeat(64);

function bridgeOn(port, opts = {}) {
  return createBridge({ port, token: TOKEN, log: quiet, connectWaitMs: 500, allowedDomains: ['example.com'], ...opts });
}

async function primaryWithExtension(handlers) {
  const primary = bridgeOn(0);
  assert.equal((await primary.start()).role, 'primary');
  const ext = await connectFakeExtension(primary.port, { token: TOKEN, handlers }).ready;
  await waitFor(() => primary.isConnected());
  return { primary, ext, port: primary.port };
}

test('second server on a busy port becomes a peer and forwards requests through the primary', async () => {
  const { primary, ext, port } = await primaryWithExtension({
    'tabs.list': () => ({ tabs: [{ tabId: 1 }] }),
    'page.eval': (p) => ({ value: p.code }),
    'page.act': () => {
      throw { message: 'boom', snapshot: 'SNAP' };
    },
  });
  const peer = bridgeOn(port);
  try {
    const r = await peer.start();
    assert.deepEqual(r, { ok: true, port, role: 'peer' });
    assert.equal(peer.role, 'peer');
    assert.equal(peer.startError, null);
    await waitFor(() => primary.peerCount === 1);
    assert.equal(primary.shared, true);
    assert.equal(peer.shared, true);

    // Both sessions at once; ids do not collide at the extension.
    const [a, b, c] = await Promise.all([
      primary.request('tabs.list', {}),
      peer.request('tabs.list', {}),
      peer.request('page.eval', { code: 'x', tabId: 7 }),
    ]);
    assert.deepEqual(a, { tabs: [{ tabId: 1 }] });
    assert.deepEqual(b, { tabs: [{ tabId: 1 }] });
    assert.deepEqual(c, { value: 'x' });
    assert.equal(new Set(ext.requests.map((q) => q.id)).size, 3);
    assert.deepEqual(ext.requests.find((q) => q.method === 'page.eval').params, { code: 'x', tabId: 7 });

    // Errors (with snapshot) come back to the peer intact.
    await assert.rejects(peer.request('page.act', {}), (e) => e instanceof BridgeError && e.message === 'boom' && e.snapshot === 'SNAP');
  } finally {
    await peer.close();
    await ext.close();
    await primary.close();
  }
});

test('peer request timeout is forwarded to the primary', async () => {
  const { primary, ext, port } = await primaryWithExtension({ 'page.eval': 'ignore' });
  const peer = bridgeOn(port);
  try {
    await peer.start();
    const t0 = Date.now();
    await assert.rejects(peer.request('page.eval', { code: '1' }, { timeoutMs: 1_000 }), /did not answer page\.eval within 1s/);
    assert.ok(Date.now() - t0 < 3_000);
  } finally {
    await peer.close();
    await ext.close();
    await primary.close();
  }
});

test('peer path refuses browsers (Origin) and wrong tokens', async () => {
  const { primary, ext, port } = await primaryWithExtension({});
  try {
    // A web page always sends an Origin header.
    const fromPage = new WebSocket(`ws://127.0.0.1:${port}${PEER_PATH}`, { headers: { Origin: 'https://evil.example' } });
    const status = await new Promise((r) => fromPage.once('unexpected-response', (req, res) => r(res.statusCode)));
    assert.equal(status, 403);

    // A server with another token cannot join, and says why.
    const stranger = createBridge({ port, token: 'c'.repeat(64), log: quiet, connectWaitMs: 0 });
    const r = await stranger.start();
    assert.equal(r.ok, false);
    assert.match(r.error, /could not share it: the server on this port did not authenticate/);
    await stranger.close();
    assert.equal(primary.peerCount, 0);
    assert.equal(primary.shared, false);
  } finally {
    await ext.close();
    await primary.close();
  }
});

test('extension-only proofs cannot be replayed on the peer path (different prefixes)', async () => {
  const { primary, ext, port } = await primaryWithExtension({});
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PEER_PATH}`);
    await new Promise((r) => ws.once('open', r));
    const closed = new Promise((r) => ws.once('close', (code) => r(code)));
    ws.send(JSON.stringify({ type: 'peer-hello', nonce: 'n'.repeat(32) }));
    const cfg = await new Promise((r) => ws.once('message', (d) => r(JSON.parse(String(d)))));
    assert.equal(cfg.type, 'peer-config');
    const { authProof } = await import('../src/bridge.js');
    ws.send(JSON.stringify({ type: 'peer-auth', proof: authProof(TOKEN, 'ext:' + cfg.nonce) })); // extension-style proof
    assert.equal(await closed, 4003);
    assert.equal(primary.peerCount, 0);
  } finally {
    await ext.close();
    await primary.close();
  }
});

test('failover: when the primary exits a peer takes the port, the extension reconnects, another peer re-joins', async () => {
  const handlers = { 'tabs.list': () => ({ tabs: [] }) };
  const { primary, ext, port } = await primaryWithExtension(handlers);
  const p1 = bridgeOn(port);
  const p2 = bridgeOn(port);
  let ext2;
  try {
    await p1.start();
    await p2.start();
    await waitFor(() => primary.peerCount === 2);

    await primary.close();
    await ext.close();
    // One peer wins the port, the other joins it.
    await waitFor(() => [p1.role, p2.role].sort().join() === 'peer,primary', 5_000);
    const winner = p1.role === 'primary' ? p1 : p2;
    const loser = winner === p1 ? p2 : p1;
    await waitFor(() => winner.peerCount === 1, 5_000);

    // The extension reconnects to the same port on its own (here: a fresh fake).
    ext2 = await connectFakeExtension(port, { token: TOKEN, handlers }).ready;
    await waitFor(() => winner.isConnected());
    assert.deepEqual(await winner.request('tabs.list', {}), { tabs: [] });
    assert.deepEqual(await loser.request('tabs.list', {}), { tabs: [] });
  } finally {
    await ext2?.close();
    await p1.close();
    await p2.close();
  }
});

test('a peer request during re-election waits for the new route instead of failing', async () => {
  const handlers = { 'tabs.list': () => ({ tabs: ['ok'] }) };
  const { primary, ext, port } = await primaryWithExtension(handlers);
  const peer = bridgeOn(port, { connectWaitMs: 3_000 });
  let ext2;
  try {
    await peer.start();
    await primary.close();
    await ext.close();
    const pendingReq = peer.request('tabs.list', {});
    ext2 = connectFakeExtension(port, { token: TOKEN, handlers });
    await waitFor(() => peer.role === 'primary', 5_000);
    // The fake may have tried before the port was re-bound; retry it like the real extension's backoff would.
    await ext2.ready.catch(async () => {
      ext2 = connectFakeExtension(port, { token: TOKEN, handlers });
      await ext2.ready;
    });
    assert.deepEqual(await pendingReq, { tabs: ['ok'] });
  } finally {
    await ext2?.close?.();
    await peer.close();
  }
});

// ---- per-session tabs (tools layer) ------------------------------------------------------------------------

function fakeBridge({ shared = false, respond }) {
  const calls = [];
  return {
    calls,
    shared,
    async request(method, params) {
      calls.push({ method, params });
      return respond(method, params);
    },
  };
}

const noWorkflows = { record() {}, recording: [], reset: () => 0 };

test('each session remembers its own tab and sends it explicitly', async () => {
  let nextTab = 100;
  const bridge = fakeBridge({
    respond: (m, p) => (m === 'tabs.new' ? { tabId: nextTab++ } : m === 'tabs.goto' ? { tabId: p.tabId ?? 5 } : m === 'tabs.close' ? { closed: p.tabId } : { text: 'S' }),
  });
  const h = createToolHandlers({ bridge, workflows: noWorkflows, recordingOn: () => false });

  // Single session, no tab yet: old behaviour (extension default).
  await h.browser_snapshot({});
  assert.deepEqual(bridge.calls.at(-1), { method: 'page.snapshot', params: { mode: 'viewport' } });

  await h.browser_tabs({ action: 'new', url: 'https://example.com' });
  await h.browser_snapshot({});
  assert.equal(bridge.calls.at(-1).params.tabId, 100);
  await h.browser_eval({ code: '1' });
  assert.equal(bridge.calls.at(-1).params.tabId, 100);
  // Explicit tabId still wins.
  await h.browser_eval({ code: '1', tabId: 9 });
  assert.equal(bridge.calls.at(-1).params.tabId, 9);

  await h.browser_tabs({ action: 'close', tabId: 100 });
  await h.browser_snapshot({});
  assert.equal(bridge.calls.at(-1).params.tabId, undefined);
});

test('shared browser: no tab of our own → page tools refuse, goto opens a new tab instead of hijacking', async () => {
  const bridge = fakeBridge({ shared: true, respond: (m) => (m === 'tabs.new' ? { tabId: 42, snapshot: 'S' } : { text: 'S' }) });
  const h = createToolHandlers({ bridge, workflows: noWorkflows, recordingOn: () => false });

  const r = await h.browser_snapshot({});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /another session is using this browser too/);
  assert.equal(bridge.calls.length, 0);

  const g = await h.browser_tabs({ action: 'goto', url: 'https://example.com' });
  assert.equal(g.isError, undefined);
  assert.deepEqual(bridge.calls.at(-1), { method: 'tabs.new', params: { url: 'https://example.com' } });
  await h.browser_snapshot({});
  assert.equal(bridge.calls.at(-1).params.tabId, 42);
});

test('our tab closed by hand: retried once without it', async () => {
  let gone = false;
  const bridge = fakeBridge({
    respond: (m, p) => {
      if (m === 'tabs.new') return { tabId: 3 };
      if (gone && p.tabId === 3) throw new BridgeError('tab 3 not found (closed?) — list tabs with browser_tabs action=list');
      return { text: 'S' };
    },
  });
  const h = createToolHandlers({ bridge, workflows: noWorkflows, recordingOn: () => false });
  await h.browser_tabs({ action: 'new' });
  gone = true;
  const r = await h.browser_snapshot({});
  assert.equal(r.isError, undefined);
  assert.deepEqual(bridge.calls.slice(-2).map((c) => c.params.tabId), [3, undefined]);
});
