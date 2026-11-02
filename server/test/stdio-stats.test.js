import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpHome, rmHome } from '../test-support/helpers.js';
import { createCallLog } from '../src/log.js';
import { readLogs, summarize, formatStats } from '../src/stats.js';
import { loadConfig, DEFAULT_EXTENSION_ID } from '../src/config.js';

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));

test('real stdio server: initialize, 7 tools, not-connected error, stdout is protocol only', async () => {
  const home = tmpHome();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { ...process.env, FB_HOME: home, FB_PORT: '0' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d) => (stderr += d));
  const client = new Client({ name: 'stdio-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    assert.ok(client.getInstructions());
    const r = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /extension not connected/);
    assert.ok(fs.existsSync(path.join(home, 'config.json')));
    assert.match(stderr, /\[fast-browser\]/);
  } finally {
    await client.close();
    rmHome(home);
  }
});

test('config: FB_HOME isolation, env overrides, bad port rejected', () => {
  const home = tmpHome();
  try {
    const c = loadConfig({ FB_HOME: home, FB_PORT: '18000', FB_EXTENSION_ID: 'abc' });
    assert.equal(c.home, path.resolve(home));
    assert.equal(c.port, 18000);
    assert.equal(c.extensionId, 'abc');
    assert.ok(c.allowedDomains.includes('atlassian.net'));
    fs.writeFileSync(c.configPath, JSON.stringify({ port: 19000, allowedDomains: ['A.com'] }));
    const d = loadConfig({ FB_HOME: home });
    assert.equal(d.port, 19000);
    assert.deepEqual(d.allowedDomains, ['a.com']);
    assert.equal(d.extensionId, DEFAULT_EXTENSION_ID, 'pinned to the manifest-key ID by default');
    assert.match(c.token, /^[0-9a-f]{64}$/);
    assert.equal(d.token, c.token, 'token persists in FB_HOME/token');
    assert.equal(fs.readFileSync(path.join(home, 'token'), 'utf8').trim(), c.token);
    assert.equal(loadConfig({ FB_HOME: home, FB_EXTENSION_ID: '*' }).extensionId, null);
    assert.throws(() => loadConfig({ FB_HOME: home, FB_PORT: 'abc' }), /invalid port/);
  } finally {
    rmHome(home);
  }
});

test('stats: per-day counts, avg ms, failure rate', () => {
  const home = tmpHome();
  try {
    const logsDir = path.join(home, 'logs');
    let day = new Date(2026, 10, 1, 10);
    const log = createCallLog(logsDir, { now: () => day });
    log.write({ tool: 'browser_act', ms: 100, ok: true, steps: 3, inChars: 10, outChars: 20 });
    log.write({ tool: 'browser_act', ms: 300, ok: false, steps: 2, failedStep: 2, inChars: 10, outChars: 20 });
    log.write({ tool: 'browser_tabs', action: 'goto', ms: 50, ok: true, inChars: 5, outChars: 5 });
    day = new Date(2026, 10, 2, 10);
    log.write({ tool: 'browser_eval', ms: 10, ok: true, inChars: 1, outChars: 1 });
    const days = readLogs(logsDir);
    assert.deepEqual(days.map((d) => d.day), ['2026-11-01', '2026-11-02']);
    const s = summarize(days[0].entries);
    assert.equal(s.calls, 3);
    const act = s.tools.find((t) => t.tool === 'browser_act');
    assert.equal(act.calls, 2);
    assert.equal(act.avgMs, 200);
    assert.equal(act.failureRate, 0.5);
    assert.equal(act.steps, 5);
    const out = formatStats(days);
    assert.match(out, /2026-11-01 {2}calls 3/);
    assert.match(out, /browser_act +2 calls/);
    assert.equal(readLogs(logsDir, ['2026-11-02']).length, 1);
    assert.equal(formatStats([]), 'no call logs yet');
  } finally {
    rmHome(home);
  }
});

test('DEFAULT_EXTENSION_ID is the ID Chrome derives from the manifest key', async () => {
  const crypto = await import('node:crypto');
  const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension', 'manifest.json');
  const { key } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  assert.equal(id, DEFAULT_EXTENSION_ID);
});
