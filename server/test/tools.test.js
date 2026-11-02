import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startApp, connectFakeExtension, waitFor, textOf } from '../test-support/helpers.js';
import { formatActResult } from '../src/tools.js';

async function withExtension(handlers, fn, opts = {}) {
  const s = await startApp(opts);
  const ext = await connectFakeExtension(s.app.bridge.port, { handlers }).ready;
  await waitFor(() => s.app.bridge.isConnected());
  try {
    await fn(s, ext);
  } finally {
    await ext.close();
    await s.stop();
  }
}

test('exactly 7 tools and server instructions are exposed', async () => {
  const s = await startApp();
  try {
    const { tools } = await s.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'browser_act',
      'browser_eval',
      'browser_extract',
      'browser_screenshot',
      'browser_snapshot',
      'browser_tabs',
      'browser_workflow',
    ]);
    for (const t of tools) assert.ok(t.description.length < 400, `${t.name} description is short`);
    const instr = s.client.getInstructions();
    assert.match(instr, /browser_workflow/);
    assert.match(instr, /browser_eval/);
    const n = instr.split('\n').length;
    assert.ok(n >= 6 && n <= 14, `instructions ~10 lines (got ${n})`);
  } finally {
    await s.stop();
  }
});

test('browser_tabs maps to tabs.* and formats text', async () => {
  await withExtension(
    {
      'tabs.list': () => ({
        tabs: [
          { tabId: 1, title: 'A', url: 'https://a.creativeforce.io/', active: true, current: true },
          { tabId: 2, title: 'B', url: 'https://b.creativeforce.io/', active: false, current: false },
        ],
      }),
      'tabs.goto': (p) => ({ tabId: p.tabId ?? 7, snapshot: `Title\n${p.url}` }),
      'tabs.new': () => ({ tabId: 8 }),
      'tabs.select': (p) => ({ tabId: p.tabId, snapshot: 'S' }),
      'tabs.close': (p) => ({ closed: p.tabId }),
    },
    async (s, ext) => {
      const list = textOf(await s.call('browser_tabs', { action: 'list' }));
      assert.match(list, /^\* \[1\] A — https:\/\/a\.creativeforce\.io\/ \(active\)$/m);
      assert.match(list, /^ {2}\[2\] B/m);

      const goto = await s.call('browser_tabs', { action: 'goto', url: 'https://x.creativeforce.io/p' });
      assert.equal(textOf(goto), 'tab 7\nTitle\nhttps://x.creativeforce.io/p');
      const req = ext.requests.find((r) => r.method === 'tabs.goto');
      assert.deepEqual(req.params, { url: 'https://x.creativeforce.io/p' });

      assert.equal(textOf(await s.call('browser_tabs', { action: 'new' })), 'tab 8');
      assert.equal(textOf(await s.call('browser_tabs', { action: 'select', tabId: 3 })), 'tab 3\nS');
      assert.equal(textOf(await s.call('browser_tabs', { action: 'close', tabId: 3 })), 'closed tab 3');

      const bad = await s.call('browser_tabs', { action: 'goto' });
      assert.equal(bad.isError, true);
      assert.match(textOf(bad), /needs url/);

      // goto is recorded as a navigate step
      assert.deepEqual(s.app.workflows.recording, [{ do: 'navigate', url: 'https://x.creativeforce.io/p' }]);
    },
  );
});

test('browser_snapshot / extract / eval map params and results', async () => {
  await withExtension(
    {
      'page.snapshot': (p) => ({ text: `mode=${p.mode} region=${p.region ?? '-'} tab=${p.tabId ?? '-'}` }),
      'page.extract': (p) => ({ text: `kind=${p.kind} max=${p.maxChars ?? '-'}`, truncated: p.maxChars === 5 }),
      'page.eval': (p) => ({ value: p.code === 'str' ? 'hello' : p.code === 'undef' ? undefined : { a: 1, b: [2] } }),
    },
    async (s, ext) => {
      assert.equal(textOf(await s.call('browser_snapshot', {})), 'mode=viewport region=- tab=-');
      assert.equal(textOf(await s.call('browser_snapshot', { mode: 'full', region: '#main', tabId: 4 })), 'mode=full region=#main tab=4');
      assert.equal(textOf(await s.call('browser_extract', {})), 'kind=text max=-');
      assert.match(textOf(await s.call('browser_extract', { kind: 'table', maxChars: 5 })), /^kind=table max=5\n…\(truncated/);
      assert.equal(textOf(await s.call('browser_eval', { code: 'str' })), 'hello');
      assert.equal(textOf(await s.call('browser_eval', { code: 'undef' })), 'undefined');
      assert.deepEqual(JSON.parse(textOf(await s.call('browser_eval', { code: 'obj' }))), { a: 1, b: [2] });
      const ev = ext.requests.find((r) => r.method === 'page.eval');
      assert.deepEqual(ev.params, { code: 'str' });
    },
  );
});

test('browser_screenshot returns MCP image content', async () => {
  await withExtension(
    { 'page.screenshot': (p) => ({ dataBase64: 'QUJD', mimeType: 'image/jpeg', echo: p }) },
    async (s, ext) => {
      const res = await s.call('browser_screenshot', {});
      assert.deepEqual(res.content, [{ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }]);
      assert.deepEqual(ext.requests[0].params, { maxWidth: 1024, quality: 60 });
    },
  );
});

test('browser_act: success text, record flag, recording uses locators', async () => {
  await withExtension(
    {
      'page.act': (p) => ({
        steps: p.actions.map((a, i) => ({ i, do: a.do, ok: true, locator: a.do === 'press' ? undefined : { selector: `#e${i}`, role: 'textbox', name: `F${i}` } })),
        completed: true,
        snapshot: '~ [1] textbox "Email" value="a@b.c"',
      }),
    },
    async (s, ext) => {
      const res = await s.call('browser_act', {
        actions: [
          { do: 'fill', ref: 1, value: 'a@b.c' },
          { do: 'click', text: 'Lưu', role: 'button' },
          { do: 'press', key: 'Enter' },
        ],
      });
      assert.equal(res.isError, undefined);
      assert.equal(
        textOf(res),
        ['✓ 1 fill [1] textbox "F0"', '✓ 2 click textbox "F1"', '✓ 3 press Enter', '--- snapshot ---', '~ [1] textbox "Email" value="a@b.c"'].join('\n'),
      );
      assert.equal(ext.requests[0].params.record, true);
      assert.equal(ext.requests[0].params.actions.length, 3);
      assert.deepEqual(s.app.workflows.recording, [
        { do: 'fill', locator: { selector: '#e0', role: 'textbox', name: 'F0' }, value: 'a@b.c' },
        { do: 'click', locator: { selector: '#e1', role: 'textbox', name: 'F1' } },
        { do: 'press', key: 'Enter' },
      ]);
    },
  );
});

test('browser_act: failure stops, shows error + snapshot, records only successful steps, logs failedStep', async () => {
  await withExtension(
    {
      'page.act': () => ({
        steps: [
          { i: 0, do: 'fill', ok: true, locator: { selector: '[name=q]', role: 'textbox', name: 'Search' } },
          { i: 1, do: 'click', ok: false, error: 'no element matches text "Lưu" role=button; closest: [5] button "Lưu lại"' },
        ],
        completed: false,
        snapshot: 'FULL VIEWPORT',
      }),
    },
    async (s) => {
      const res = await s.call('browser_act', {
        actions: [
          { do: 'fill', ref: 2, value: 'x' },
          { do: 'click', text: 'Lưu', role: 'button' },
          { do: 'press', key: 'Enter' },
        ],
      });
      assert.equal(res.isError, true);
      const t = textOf(res);
      assert.match(t, /^✓ 1 fill \[2\] textbox "Search"$/m);
      assert.match(t, /^✗ 2 click button "Lưu": no element matches text "Lưu" role=button; closest: \[5\] button "Lưu lại"$/m);
      assert.match(t, /^\(steps 3-3 not run\)$/m);
      assert.match(t, /--- snapshot ---\nFULL VIEWPORT$/);
      assert.equal(s.app.workflows.recording.length, 1);

      const logFile = fs.readdirSync(path.join(s.home, 'logs'))[0];
      const lines = fs.readFileSync(path.join(s.home, 'logs', logFile), 'utf8').trim().split('\n').map(JSON.parse);
      const last = lines.at(-1);
      assert.equal(last.tool, 'browser_act');
      assert.equal(last.ok, false);
      assert.equal(last.steps, 2);
      assert.equal(last.failedStep, 2);
      assert.ok(last.inChars > 0 && last.outChars > 0 && typeof last.ms === 'number' && last.ts);
      assert.match(logFile, /^calls-\d{4}-\d{2}-\d{2}\.jsonl$/);
    },
  );
});

test('browser_act schema: rejects >50 actions and unknown do', async () => {
  await withExtension({}, async (s, ext) => {
    const many = Array.from({ length: 51 }, () => ({ do: 'wait', ms: 1 }));
    const r1 = await s.call('browser_act', { actions: many });
    assert.equal(r1.isError, true);
    const r2 = await s.call('browser_act', { actions: [{ do: 'dance' }] });
    assert.equal(r2.isError, true);
    assert.equal(ext.requests.length, 0);
  });
});

test('extension errors surface as tool errors with snapshot', async () => {
  await withExtension(
    {
      'page.snapshot': () => {
        throw { message: 'domain not allowed: evil.com (add it to ~/.fast-browser/config.json allowedDomains)' };
      },
      'page.act': () => {
        throw { message: 'ref 12 is stale (element removed); take a new snapshot', snapshot: 'SNAP' };
      },
    },
    async (s) => {
      const r = await s.call('browser_snapshot', {});
      assert.equal(r.isError, true);
      assert.match(textOf(r), /domain not allowed: evil\.com/);
      const a = await s.call('browser_act', { actions: [{ do: 'click', ref: 12 }] });
      assert.equal(textOf(a), 'error: ref 12 is stale (element removed); take a new snapshot\n--- snapshot ---\nSNAP');
    },
  );
});

test('not connected: clear tool error', async () => {
  const s = await startApp();
  try {
    const r = await s.call('browser_tabs', { action: 'list' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Chrome extension not connected/);
  } finally {
    await s.stop();
  }
});

test('busy port: MCP server still starts and every tool returns the port error', async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  const s = await startApp({ env: { FB_PORT: String(port) }, bridgeOptions: { log: () => {} } });
  try {
    assert.equal(s.app.bridge.startError, `port ${port} in use — another Fast Browser server is running; close it or set FB_PORT`);
    const { tools } = await s.client.listTools();
    assert.equal(tools.length, 7);
    for (const [name, args] of [
      ['browser_tabs', { action: 'list' }],
      ['browser_snapshot', {}],
      ['browser_eval', { code: '1' }],
    ]) {
      const r = await s.call(name, args);
      assert.equal(r.isError, true);
      assert.match(textOf(r), new RegExp(`port ${port} in use — another Fast Browser server is running; close it or set FB_PORT`));
    }
  } finally {
    await s.stop();
    await new Promise((r) => blocker.close(r));
  }
});

test('origin rejection through the full app', async () => {
  const s = await startApp();
  try {
    await assert.rejects(connectFakeExtension(s.app.bridge.port, { origin: 'https://evil.example' }).ready, (e) => e.statusCode === 403);
    assert.equal(s.app.bridge.isConnected(), false);
  } finally {
    await s.stop();
  }
});

test('config: defaults file created, env overrides apply and are sent to the extension', async () => {
  const s = await startApp({ env: { FB_ALLOWED_DOMAINS: 'Example.com, *' } });
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8'));
    assert.equal(cfg.port, 17890);
    assert.ok(cfg.allowedDomains.includes('creativeforce.io'));
    const ext = await connectFakeExtension(s.app.bridge.port).ready;
    await waitFor(() => ext.config);
    assert.deepEqual(ext.config.allowedDomains, ['example.com', '*']);
    await ext.close();
  } finally {
    await s.stop();
  }
});

test('formatActResult tolerates missing fields', () => {
  assert.equal(formatActResult([{ do: 'wait', ms: 5 }], {}), '--- snapshot ---\n(no snapshot)');
});
