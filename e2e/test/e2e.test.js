// End-to-end: real MCP server (stdio) <-> real extension in Playwright Chromium <-> local fixture site.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness } from '../support/harness.js';

const SECRET = 'S3cret-pw-XYZ';
const SECRET2 = 'other-pw';
let h;

before(async () => {
  h = await startHarness();
}, { timeout: 90000 });

after(async () => {
  if (h) await h.close();
});

const T = { timeout: 60000 };

test('tabs goto returns a snapshot of the form', T, async () => {
  const r = await h.call('browser_tabs', { action: 'goto', url: `${h.origin}/form` });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /^tab \d+/);
  assert.match(r.text, /Fixture form/);
  assert.match(r.text, /textbox "Email"/);
  assert.match(r.text, /combobox "Status"/);
  assert.match(r.text, /button "Submit order"/);
});

test('act batch with navigation mid-way, then diff', T, async () => {
  const r = await h.call('browser_act', {
    actions: [
      { do: 'fill', text: 'Email', value: 'user@example.test' },
      { do: 'fill', text: 'Customer name', value: 'Alice' },
      { do: 'select', text: 'Status', value: 'Open' },
      { do: 'check', text: 'I agree' },
      { do: 'click', text: 'Submit order', role: 'button' },
      { do: 'wait', waitText: 'Saved: Alice' },
    ],
  });
  assert.ok(!r.isError, r.text);
  const lines = r.text.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('✓')).length, 6, r.text);
  assert.match(r.text, /--- snapshot ---\n\(new page\)/);
  assert.match(r.text, /Fixture done/);
  assert.match(r.text, /link "Go to table"/);

  const d = await h.call('browser_snapshot', { mode: 'diff' });
  assert.ok(!d.isError, d.text);
  assert.equal(d.text.trim(), '(no changes)');

  const t = await h.call('browser_extract', { kind: 'text' });
  assert.match(t.text, /Saved: Alice/);
  assert.match(t.text, /Status: open \/ agree: yes/);
});

test('failed step stops the batch and returns a viewport snapshot with candidates', T, async () => {
  const r = await h.call('browser_act', {
    actions: [
      { do: 'click', text: 'Go to nowhere', role: 'link' },
      { do: 'click', text: 'Go to table' },
    ],
  });
  assert.ok(r.isError);
  assert.match(r.text, /✗ 1 click .*no element matches text "Go to nowhere"/);
  assert.match(r.text, /closest:/);
  assert.match(r.text, /\(steps 2-2 not run\)/);
  assert.match(r.text, /--- snapshot ---\nFixture done/);
});

test('modal diff: only the dialog is listed', T, async () => {
  const g = await h.call('browser_tabs', { action: 'goto', url: `${h.origin}/modal` });
  assert.ok(!g.isError, g.text);
  assert.match(g.text, /button "Background button"/);
  const r = await h.call('browser_act', { actions: [{ do: 'click', text: 'Open dialog' }] });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /\[modal\]/);
  assert.match(r.text, /\+ \[\d+\] button "Delete it"/);
  const s = await h.call('browser_snapshot', {});
  assert.match(s.text, /\[modal\]/);
  assert.doesNotMatch(s.text, /Background button/);
  const r2 = await h.call('browser_act', { actions: [{ do: 'click', text: 'Delete it' }] });
  assert.ok(!r2.isError, r2.text);
  const t = await h.call('browser_extract', { kind: 'text' });
  assert.match(t.text, /deleted/);
  // Escape closes a native modal <dialog> (emulated: synthetic key events are untrusted).
  const r3 = await h.call('browser_act', { actions: [{ do: 'click', text: 'Open dialog' }, { do: 'press', key: 'Escape' }] });
  assert.ok(!r3.isError, r3.text);
  assert.match(r3.text, /--- snapshot ---\n\(no changes\)/); // opened then closed: no net change vs. the batch start
  const s2 = await h.call('browser_snapshot', {});
  assert.doesNotMatch(s2.text, /\[modal\]/);
  assert.match(s2.text, /Background button/);
});

test('extract table as markdown, and links', T, async () => {
  const g = await h.call('browser_tabs', { action: 'goto', url: `${h.origin}/table` });
  assert.ok(!g.isError, g.text);
  const r = await h.call('browser_extract', { kind: 'table' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /\| Item \| Qty \|/);
  assert.match(r.text, /\| Apple \| 3 \|/);
  assert.match(r.text, /\| Banana \| 12 \|/);
});

test('eval and screenshot', T, async () => {
  const e = await h.call('browser_eval', { code: 'return { rows: document.querySelectorAll("tbody tr").length, title: document.title };' });
  assert.ok(!e.isError, e.text);
  assert.deepEqual(JSON.parse(e.text), { rows: 2, title: 'Fixture table' });
  const s = await h.call('browser_screenshot', { maxWidth: 400 });
  assert.ok(!s.isError, s.text);
  const img = s.content.find((c) => c.type === 'image');
  assert.ok(img && img.data.length > 100);
  assert.equal(img.mimeType, 'image/jpeg');
});

test('workflow reset -> record -> save with params -> run with a new param', T, async () => {
  let r = await h.call('browser_workflow', { action: 'reset' });
  assert.ok(!r.isError, r.text);
  r = await h.call('browser_tabs', { action: 'goto', url: `${h.origin}/form` });
  assert.ok(!r.isError, r.text);
  r = await h.call('browser_act', {
    actions: [
      { do: 'fill', text: 'Customer name', value: 'Carol' },
      { do: 'fill', text: 'Password', value: SECRET },
      { do: 'select', text: 'Status', value: 'Closed' },
      { do: 'press', text: 'Customer name', key: 'Enter' },
      { do: 'wait', waitText: 'Saved: Carol' },
    ],
  });
  assert.ok(!r.isError, r.text);

  r = await h.call('browser_workflow', { action: 'save', name: 'new-order', description: 'create an order', params: { customer: 'Carol' } });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /saved workflow "new-order" \(6 steps, params: customer, password\)/);

  const file = path.join(h.home, 'workflows', 'new-order.json');
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([...wf.params].sort(), ['customer', 'password']);
  assert.equal(wf.steps[0].do, 'navigate');
  assert.ok(wf.steps.every((s) => s.ref === undefined));
  assert.equal(wf.steps.find((s) => s.do === 'fill' && s.locator?.name === 'Password')?.value, '{{password}}');
  assert.equal(wf.steps.at(-1).waitText, 'Saved: {{customer}}');

  r = await h.call('browser_workflow', { action: 'run', name: 'new-order', params: { customer: 'Dave' } });
  assert.ok(r.isError);
  assert.match(r.text, /needs params: .*missing: password/);

  r = await h.call('browser_workflow', { action: 'run', name: 'new-order', params: { customer: 'Dave', password: SECRET2 } });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /workflow "new-order" completed/);
  const t = await h.call('browser_extract', { kind: 'text' });
  assert.match(t.text, /Saved: Dave/);
  assert.match(t.text, /Status: closed/);
  assert.match(t.text, new RegExp(`pw-length: ${SECRET2.length}`));

  const l = await h.call('browser_workflow', { action: 'list' });
  assert.match(l.text, /new-order\(customer, password\) — create an order/);
});

test('password never written under FB_HOME', T, async () => {
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(h.home);
  assert.ok(files.length >= 3);
  for (const f of files) {
    const body = fs.readFileSync(f, 'utf8');
    assert.ok(!body.includes(SECRET), `secret found in ${f}`);
    assert.ok(!body.includes(SECRET2), `secret found in ${f}`);
  }
});

test('allowlist rejects other domains (goto and navigate action)', T, async () => {
  const r = await h.call('browser_tabs', { action: 'goto', url: 'http://example.com/' });
  assert.ok(r.isError);
  assert.match(r.text, /domain not allowed: example\.com \(add it to ~\/\.fast-browser\/config\.json allowedDomains\)/);
  const a = await h.call('browser_act', { actions: [{ do: 'navigate', url: 'https://evil.example.org/x' }] });
  assert.ok(a.isError);
  assert.match(a.text, /✗ 1 navigate .*domain not allowed: evil\.example\.org/);
});

test('tabs outside the allowlist are redacted in list and cannot be selected', T, async () => {
  const page = await h.context.newPage();
  try {
    await page.goto('data:text/html,<title>Very Secret Subject</title><p>x</p>');
    const l = await h.call('browser_tabs', { action: 'list' });
    assert.ok(!l.isError, l.text);
    assert.ok(!l.text.includes('Very Secret Subject'), l.text);
    assert.match(l.text, /\(not allowed/);
    const tabId = Number((l.text.split('\n').find((x) => x.includes('(not allowed')) || '').match(/\d+/)?.[0]);
    assert.ok(Number.isInteger(tabId), l.text);
    const s = await h.call('browser_tabs', { action: 'select', tabId });
    assert.ok(s.isError);
    assert.match(s.text, new RegExp(`tab ${tabId} not selected`));
    // the current tab did not move to the rejected tab
    const snap = await h.call('browser_snapshot', { mode: 'viewport' });
    assert.ok(!snap.isError, snap.text);
  } finally {
    await page.close();
  }
});

test('metrics log has one line per call', T, async () => {
  const dir = path.join(h.home, 'logs');
  const lines = fs
    .readdirSync(dir)
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
    .map((l) => JSON.parse(l));
  assert.ok(lines.length >= 20, `only ${lines.length} log lines`);
  assert.ok(lines.some((l) => l.tool === 'browser_act' && l.ok && l.steps === 6));
  assert.ok(lines.some((l) => l.tool === 'browser_act' && !l.ok && l.failedStep === 1));
});
