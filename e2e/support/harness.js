// Starts fixture site + real MCP server (stdio) + Chromium with the unpacked extension, wired together.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixtureServer, freePort } from './fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXTENSION_DIR = path.join(ROOT, 'extension');
export const SERVER_ENTRY = path.join(ROOT, 'server', 'src', 'index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchBrowser(userDataDir) {
  const args = [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`, '--no-first-run'];
  const headed = process.env.FB_E2E_HEADED === '1';
  try {
    // channel 'chromium' = full Chromium in new headless mode, which supports extensions.
    return await chromium.launchPersistentContext(userDataDir, { channel: 'chromium', headless: !headed, args });
  } catch (e) {
    if (headed) throw e;
    process.stderr.write(`[e2e] headless launch failed (${e.message.split('\n')[0]}); retrying headed\n`);
    return chromium.launchPersistentContext(userDataDir, { headless: false, args });
  }
}

export async function startHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-e2e-'));
  const home = path.join(tmp, 'home');
  const userDataDir = path.join(tmp, 'profile');
  const fixtures = await startFixtureServer();
  const port = await freePort();
  const stderr = [];
  // Pairing: the server reads $FB_HOME/token; the extension gets the same token via chrome.storage.local.
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'token'), token + '\n');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, FB_HOME: home, FB_PORT: String(port), FB_ALLOWED_DOMAINS: '127.0.0.1,localhost' },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d) => stderr.push(String(d)));
  const client = new Client({ name: 'fast-browser-e2e', version: '0.0.0' });
  await client.connect(transport);

  const context = await launchBrowser(userDataDir);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  // The extension learns the test port + token from chrome.storage.local; its onChanged listener reconnects at once.
  await sw.evaluate(([p, t]) => chrome.storage.local.set({ port: p, token: t }), [port, token]);

  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { ...r, text };
  };

  // Wait until the extension is connected and has its config.
  const deadline = Date.now() + 20000;
  for (;;) {
    const r = await call('browser_tabs', { action: 'list' });
    if (!r.isError) break;
    if (Date.now() > deadline) throw new Error(`extension never connected: ${r.text}\nserver stderr:\n${stderr.join('')}`);
    await sleep(250);
  }

  return {
    home,
    token,
    port,
    origin: fixtures.origin,
    context,
    serviceWorker: sw,
    client,
    call,
    stderr,
    async close() {
      await client.close().catch(() => {});
      await context.close().catch(() => {});
      await fixtures.close().catch(() => {});
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* Windows may still hold profile files */
      }
    },
  };
}
