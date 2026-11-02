import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge, BridgeError } from '../src/bridge.js';
import { connectFakeExtension, waitFor } from '../test-support/helpers.js';

const quiet = () => {};

async function started(opts = {}) {
  const bridge = createBridge({ port: 0, log: quiet, connectWaitMs: 0, allowedDomains: ['example.com'], ...opts });
  const r = await bridge.start();
  assert.equal(r.ok, true);
  return bridge;
}

test('rejects upgrades without a chrome-extension origin', async () => {
  const bridge = await started();
  try {
    for (const origin of ['http://evil.example', 'https://localhost', '']) {
      const ext = connectFakeExtension(bridge.port, { origin });
      await assert.rejects(ext.ready, (e) => e.statusCode === 403);
    }
    assert.equal(bridge.isConnected(), false);
  } finally {
    await bridge.close();
  }
});

test('FB_EXTENSION_ID pins the exact origin', async () => {
  const bridge = await started({ extensionId: 'abc' });
  try {
    await assert.rejects(connectFakeExtension(bridge.port, { origin: 'chrome-extension://other' }).ready, (e) => e.statusCode === 403);
    const ok = await connectFakeExtension(bridge.port, { origin: 'chrome-extension://abc' }).ready;
    await waitFor(() => bridge.isConnected());
    await ok.close();
  } finally {
    await bridge.close();
  }
});

test('hello gets config with allowedDomains; ping gets pong', async () => {
  const bridge = await started();
  const ext = await connectFakeExtension(bridge.port).ready;
  try {
    await waitFor(() => ext.config);
    assert.deepEqual(ext.config, { type: 'config', allowedDomains: ['example.com'] });
    assert.deepEqual(bridge.extension, { version: '0.1.0', extensionId: 'test' });
    ext.ws.send(JSON.stringify({ type: 'ping' }));
    await waitFor(() => ext.messages.some((m) => m.type === 'pong'));
  } finally {
    await ext.close();
    await bridge.close();
  }
});

test('request/response by id, error with snapshot, timeout', async () => {
  const bridge = await started();
  const ext = await connectFakeExtension(bridge.port, {
    handlers: {
      'tabs.list': () => ({ tabs: [] }),
      'page.act': () => {
        throw { message: 'boom', snapshot: 'SNAP' };
      },
      'page.eval': 'ignore',
    },
  }).ready;
  try {
    await waitFor(() => bridge.isConnected());
    const [a, b] = await Promise.all([bridge.request('tabs.list', {}), bridge.request('tabs.list', {})]);
    assert.deepEqual(a, { tabs: [] });
    assert.deepEqual(b, { tabs: [] });
    const ids = ext.requests.map((r) => r.id);
    assert.equal(new Set(ids).size, 2);
    assert.equal(ext.requests[0].type, 'req');
    await assert.rejects(bridge.request('page.act', {}), (e) => e instanceof BridgeError && e.message === 'boom' && e.snapshot === 'SNAP');
    await assert.rejects(bridge.request('page.eval', { code: '1' }, { timeoutMs: 50 }), /did not answer page\.eval/);
  } finally {
    await ext.close();
    await bridge.close();
  }
});

test('newest connection wins; old one is closed and its pending requests fail', async () => {
  const bridge = await started();
  const first = await connectFakeExtension(bridge.port, { handlers: { 'tabs.list': 'ignore' } }).ready;
  try {
    await waitFor(() => bridge.isConnected());
    const pending = bridge.request('tabs.list', {});
    pending.catch(() => {});
    await waitFor(() => first.requests.length === 1);
    const firstClosed = new Promise((r) => first.ws.once('close', r));
    const second = await connectFakeExtension(bridge.port, { handlers: { 'tabs.list': () => ({ tabs: [{ tabId: 2 }] }) } }).ready;
    await assert.rejects(pending, /newer connection/);
    await firstClosed;
    assert.deepEqual(await bridge.request('tabs.list', {}), { tabs: [{ tabId: 2 }] });
    await second.close();
    await waitFor(() => !bridge.isConnected());
  } finally {
    await bridge.close();
  }
});

test('disconnect fails pending requests; not-connected error is clear', async () => {
  const bridge = await started();
  try {
    await assert.rejects(bridge.request('tabs.list', {}), /extension not connected/);
    const ext = await connectFakeExtension(bridge.port, { handlers: { 'tabs.list': 'ignore' } }).ready;
    await waitFor(() => bridge.isConnected());
    const p = bridge.request('tabs.list', {});
    await waitFor(() => ext.requests.length === 1);
    ext.ws.terminate();
    await assert.rejects(p, /disconnected/);
  } finally {
    await bridge.close();
  }
});

test('waits briefly for the extension to connect', async () => {
  const bridge = await started({ connectWaitMs: 2000 });
  try {
    const p = bridge.request('tabs.list', {});
    const ext = await connectFakeExtension(bridge.port, { handlers: { 'tabs.list': () => ({ tabs: [] }) } }).ready;
    assert.deepEqual(await p, { tabs: [] });
    await ext.close();
  } finally {
    await bridge.close();
  }
});

test('busy port: start reports it and every request fails with the FB_PORT hint', async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  const bridge = createBridge({ port, log: quiet, connectWaitMs: 0 });
  try {
    const r = await bridge.start();
    assert.equal(r.ok, false);
    const expected = `port ${port} in use — another Fast Browser server is running; close it or set FB_PORT`;
    assert.equal(r.error, expected);
    await assert.rejects(bridge.request('tabs.list', {}), { message: expected });
  } finally {
    await bridge.close();
    await new Promise((r) => blocker.close(r));
  }
});

test('token handshake: server proves itself, extension must prove itself before it gets requests', async () => {
  const token = 'a'.repeat(64);
  const bridge = await started({ token });
  try {
    const ext = await connectFakeExtension(bridge.port, { token, handlers: { 'tabs.list': () => ({ tabs: [] }) } }).ready;
    assert.equal(ext.serverVerified, true, 'config carries a valid HMAC of the extension nonce');
    assert.ok(bridge.isConnected());
    assert.deepEqual(await bridge.request('tabs.list', {}), { tabs: [] });
    await ext.close();
  } finally {
    await bridge.close();
  }
});

test('token handshake: wrong proof is closed and never replaces the authenticated extension', async () => {
  const token = 'b'.repeat(64);
  const bridge = await started({ token });
  try {
    const real = await connectFakeExtension(bridge.port, { token, handlers: { 'tabs.list': () => ({ tabs: [{ tabId: 1 }] }) } }).ready;
    // rogue: no token at all (cannot answer), and one with a bad proof
    const silent = await connectFakeExtension(bridge.port, { token: null, handlers: { 'tabs.list': () => ({ tabs: ['rogue'] }) } }).ready;
    const bad = await connectFakeExtension(bridge.port, { token, badProof: true, handlers: { 'tabs.list': () => ({ tabs: ['rogue'] }) } }).ready;
    const closeCode = await new Promise((r) => bad.ws.once('close', (code) => r(code)));
    assert.equal(closeCode, 4003);
    assert.deepEqual(await bridge.request('tabs.list', {}), { tabs: [{ tabId: 1 }] });
    assert.equal(silent.requests.length, 0);
    assert.equal(real.ws.readyState, 1, 'real extension still open');
    await silent.close();
    await real.close();
  } finally {
    await bridge.close();
  }
});

test('token handshake: hello without nonce is rejected; silent clients time out', async () => {
  const bridge = await started({ token: 'c'.repeat(64), authTimeoutMs: 100 });
  try {
    const old = await connectFakeExtension(bridge.port, { token: null }).ready;
    old.ws.send(JSON.stringify({ type: 'hello', version: '0.0.1' })); // second hello, no nonce
    const quietExt = await connectFakeExtension(bridge.port, { token: null, hello: false }).ready;
    const [c1, c2] = await Promise.all([
      new Promise((r) => old.ws.once('close', (code) => r(code))),
      new Promise((r) => quietExt.ws.once('close', (code) => r(code))),
    ]);
    assert.equal(c1, 4002);
    assert.equal(c2, 4001);
    assert.equal(bridge.isConnected(), false);
  } finally {
    await bridge.close();
  }
});
