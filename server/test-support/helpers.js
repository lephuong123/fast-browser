// Test helpers: temp FB_HOME, fake extension (ws client with chrome-extension origin), linked MCP client.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/index.js';
import { authProof } from '../src/bridge.js';

export function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fb-test-'));
}

export function rmHome(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Token of each server started by startApp, by bridge port, so fake extensions authenticate automatically.
const tokensByPort = new Map();

// handlers: { [method]: (params, req) => result | throws {message, snapshot} | Promise }
// token: shared secret; when set the fake runs the handshake (verifies the server proof, answers with its own)
// and `ready` resolves once the server says it is the active connection. Default: the startApp token for port.
export function connectFakeExtension(
  port,
  { origin = 'chrome-extension://test', handlers = {}, hello = true, token = tokensByPort.get(port) ?? null, badProof = false } = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
  const nonce = crypto.randomBytes(16).toString('hex');
  const ext = { ws, requests: [], messages: [], handlers, config: null, serverVerified: null };
  let onReady;
  const authed = new Promise((r) => (onReady = r));
  ws.on('message', async (data) => {
    const msg = JSON.parse(String(data));
    ext.messages.push(msg);
    if (msg.type === 'config') {
      ext.config = msg;
      if (token) {
        ext.serverVerified = msg.proof === authProof(token, 'server:' + nonce);
        ws.send(JSON.stringify({ type: 'auth', proof: badProof ? 'f'.repeat(64) : authProof(token, 'ext:' + msg.nonce) }));
      }
    }
    if (msg.type === 'ready') onReady();
    if (msg.type !== 'req') return;
    ext.requests.push(msg);
    const h = ext.handlers[msg.method];
    if (h === 'ignore') return;
    try {
      if (!h) throw { message: `fake: no handler for ${msg.method}` };
      const result = await h(msg.params, msg);
      ws.send(JSON.stringify({ id: msg.id, type: 'res', ok: true, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, type: 'res', ok: false, error: { message: e.message, snapshot: e.snapshot } }));
    }
  });
  ext.ready = new Promise((resolve, reject) => {
    ws.once('open', () => {
      if (hello) ws.send(JSON.stringify({ type: 'hello', version: '0.1.0', extensionId: 'test', nonce }));
      if (token && hello && !badProof) authed.then(() => resolve(ext));
      else resolve(ext);
    });
    ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error(`unexpected ${res.statusCode}`), { statusCode: res.statusCode })));
    ws.once('error', reject);
  });
  ext.close = () =>
    new Promise((r) => {
      if (ws.readyState === WebSocket.CLOSED) return r();
      ws.once('close', r);
      ws.close();
    });
  return ext;
}

export async function waitFor(fn, ms = 2000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Full server (bridge on a free port) + MCP client over a linked in-memory transport.
export async function startApp({ env = {}, bridgeOptions = {}, start = true } = {}) {
  const home = env.FB_HOME || tmpHome();
  const app = createApp({
    env: { FB_HOME: home, FB_PORT: '0', FB_EXTENSION_ID: 'test', ...env },
    bridgeOptions: { connectWaitMs: 0, ...bridgeOptions },
  });
  if (start) {
    await app.bridge.start();
    if (app.bridge.port) tokensByPort.set(app.bridge.port, app.config.token);
  }
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await app.mcp.connect(serverT);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientT);
  return {
    app,
    home,
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    async stop() {
      await client.close().catch(() => {});
      await app.close();
      tokensByPort.delete(app.bridge.port);
      rmHome(home);
    },
  };
}

export const textOf = (res) => res.content.map((c) => c.text ?? '').join('\n');

export function readAllFiles(dir) {
  let out = '';
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out += e.isDirectory() ? readAllFiles(p) : fs.readFileSync(p, 'utf8');
  }
  return out;
}
