import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, connectFakeExtension, waitFor, textOf, readAllFiles, tmpHome, rmHome } from '../test-support/helpers.js';
import { templateSteps, substituteSteps, findParams, createWorkflows, toRecordedStep } from '../src/workflows.js';

const SECRET = 'S3cr3t-Pa55!';

// Fake page.act: every action succeeds unless it has value "FAIL" or targets text "missing".
function fakeAct(p) {
  const steps = [];
  for (let i = 0; i < p.actions.length; i++) {
    const a = p.actions[i];
    if (a.value === 'FAIL' || a.text === 'missing' || a.locator?.name === 'missing') {
      steps.push({ i, do: a.do, ok: false, error: `no element matches text "missing"` });
      return { steps, completed: false, snapshot: 'FULL' };
    }
    const isPw = a.ref === 3 || a.locator?.role === 'password';
    const loc =
      a.locator ||
      (a.ref === 1 ? { selector: '#email', role: 'textbox', name: 'Email' }
        : a.ref === 2 ? { selector: '[name=project]', role: 'textbox', name: 'Project' }
        : a.ref === 3 ? { selector: '#pw', role: 'textbox', name: 'Mật khẩu' }
        : a.text ? { selector: 'button.save', role: a.role || 'button', name: a.text }
        : undefined);
    steps.push({ i, do: a.do, ok: true, ...(loc ? { locator: loc } : {}), ...(isPw ? { password: true } : {}) });
  }
  return { steps, completed: true, snapshot: '(no changes)' };
}

async function withApp(fn) {
  const s = await startApp();
  const ext = await connectFakeExtension(s.app.bridge.port, { handlers: { 'page.act': fakeAct, 'tabs.goto': (p) => ({ tabId: 1, snapshot: p.url }) } }).ready;
  await waitFor(() => s.app.bridge.isConnected());
  try {
    await fn(s, ext);
  } finally {
    await ext.close();
    await s.stop();
  }
}

test('templateSteps / substituteSteps / findParams', () => {
  const steps = [
    { do: 'navigate', url: 'https://app.creativeforce.io/projects/ACME-42/edit' },
    { do: 'fill', locator: { selector: '#q', role: 'textbox', name: 'Search' }, value: 'ACME-42 shoes' },
    { do: 'click', locator: { role: 'link', name: 'ACME-42' } },
    { do: 'fill', value: '{{password}}' },
    { do: 'scroll', direction: 'down' },
  ];
  const t = templateSteps(steps, { project: 'ACME-42', dir: 'down', empty: '' });
  assert.equal(t[0].url, 'https://app.creativeforce.io/projects/{{project}}/edit');
  assert.equal(t[1].value, '{{project}} shoes');
  assert.equal(t[2].locator.name, '{{project}}');
  assert.equal(t[3].value, '{{password}}');
  assert.equal(t[4].direction, 'down', 'enum fields are not templated');
  assert.equal(steps[0].url.includes('ACME-42'), true, 'input not mutated');
  assert.deepEqual(findParams(t).sort(), ['password', 'project']);
  // existing tokens are never re-templated (value "pass" inside "{{password}}")
  assert.equal(templateSteps([{ do: 'fill', value: '{{password}} pass' }], { p: 'pass' })[0].value, '{{password}} {{p}}');
  // longest value wins on overlap
  assert.equal(templateSteps([{ do: 'fill', value: 'ab abc' }], { a: 'ab', b: 'abc' })[0].value, '{{a}} {{b}}');
  // structural fields are never templated: short/numeric values must not corrupt selectors, ports, roles, keys
  const s2 = templateSteps(
    [
      { do: 'navigate', url: 'http://localhost:5173/orders?qty=5' },
      { do: 'click', locator: { selector: 'tr:nth-of-type(5) > td > button', role: 'button', name: 'Edit', nth: 5 } },
      { do: 'fill', locator: { selector: '#qty', role: 'spinbutton', name: 'Qty' }, value: '5' },
      { do: 'press', key: 'Control+a' },
      { do: 'wait', waitSelector: '.row-5', waitText: 'saved 5' },
    ],
    { qty: '5', r: 'on' },
  );
  assert.equal(s2[0].url, 'http://localhost:5173/orders?qty={{qty}}', 'host/port untouched, query templated');
  assert.equal(s2[1].locator.selector, 'tr:nth-of-type(5) > td > button');
  assert.equal(s2[1].locator.role, 'button');
  assert.equal(s2[1].locator.nth, 5);
  assert.equal(s2[2].value, '{{qty}}');
  assert.equal(s2[3].key, 'Control+a');
  assert.equal(s2[4].waitSelector, '.row-5');
  assert.equal(s2[4].waitText, 'saved {{qty}}');
  const back = substituteSteps(t, { project: 'ZED-1', password: 'pw' });
  assert.equal(back[0].url, 'https://app.creativeforce.io/projects/ZED-1/edit');
  assert.equal(back[3].value, 'pw');
});

test('toRecordedStep drops ref and keeps the locator; password fills become {{password}}', () => {
  assert.deepEqual(toRecordedStep({ do: 'click', ref: 4 }, { ok: true, locator: { selector: '#a', role: 'button', name: 'Go', extra: 1 } }), {
    do: 'click',
    locator: { selector: '#a', role: 'button', name: 'Go' },
  });
  assert.equal(toRecordedStep({ do: 'fill', ref: 3, value: SECRET }, { ok: true, password: true }).value, '{{password}}');
  assert.equal(toRecordedStep({ do: 'fill', ref: 3, value: SECRET }, { ok: true, locator: { selector: 'input[type=password]' } }).value, '{{password}}');
  assert.equal(toRecordedStep({ do: 'fill', ref: 3, value: SECRET }, { ok: true, locator: { role: 'textbox', name: 'Password' } }).value, '{{password}}');
  // a selector built from a controlled password input's value attribute must not persist the secret
  const leaky = toRecordedStep({ do: 'fill', ref: 3, value: SECRET }, { ok: true, locator: { selector: `input[name="password"][value="${SECRET}"]`, role: 'textbox', name: 'Password', password: true } });
  assert.equal(JSON.stringify(leaky).includes(SECRET), false);
  assert.deepEqual(leaky.locator, { role: 'textbox', name: 'Password' });
  assert.equal(toRecordedStep({ do: 'fill', text: 'Email', value: 'a@b.c' }, { ok: true }).value, 'a@b.c');
  assert.deepEqual(toRecordedStep({ do: 'click', text: 'Save', role: 'button' }, { ok: true }), { do: 'click', text: 'Save', role: 'button' });
});

test('reset / save with params / show / list / run with a new param / delete', async () => {
  await withApp(async (s, ext) => {
    await s.call('browser_workflow', { action: 'reset' });
    await s.call('browser_tabs', { action: 'goto', url: 'https://app.creativeforce.io/p/ACME-42' });
    const act = await s.call('browser_act', {
      actions: [
        { do: 'fill', ref: 2, value: 'ACME-42' },
        { do: 'click', text: 'Lưu', role: 'button' },
      ],
    });
    assert.equal(act.isError, undefined);

    const saved = await s.call('browser_workflow', { action: 'save', name: 'open-project', description: 'Open a project', params: { project: 'ACME-42' } });
    assert.match(textOf(saved), /saved workflow "open-project" \(3 steps, params: project\)/);
    const file = path.join(s.home, 'workflows', 'open-project.json');
    const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(wf.name, 'open-project');
    assert.equal(wf.description, 'Open a project');
    assert.deepEqual(wf.params, ['project']);
    assert.ok(wf.createdAt && wf.updatedAt);
    assert.deepEqual(wf.steps, [
      { do: 'navigate', url: 'https://app.creativeforce.io/p/{{project}}' },
      { do: 'fill', locator: { selector: '[name=project]', role: 'textbox', name: 'Project' }, value: '{{project}}' },
      { do: 'click', locator: { selector: 'button.save', role: 'button', name: 'Lưu' } },
    ]);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('ACME-42'));

    const list = textOf(await s.call('browser_workflow', { action: 'list' }));
    assert.equal(list, 'open-project(project) — Open a project');

    const show = textOf(await s.call('browser_workflow', { action: 'show', name: 'open-project' }));
    assert.equal(
      show,
      [
        'open-project — Open a project',
        'params: project',
        '1. navigate https://app.creativeforce.io/p/{{project}}',
        '2. fill textbox "Project" = "{{project}}"',
        '3. click button "Lưu"',
      ].join('\n'),
    );

    // run with a new param value: substituted, one page.act, record=false
    ext.requests.length = 0;
    const recBefore = structuredClone(s.app.workflows.recording);
    const run = await s.call('browser_workflow', { action: 'run', name: 'open-project', params: { project: 'ZED-7' } });
    assert.equal(run.isError, undefined);
    assert.match(textOf(run), /workflow "open-project" completed$/);
    assert.equal(ext.requests.length, 1);
    const req = ext.requests[0];
    assert.equal(req.method, 'page.act');
    assert.equal(req.params.record, false);
    assert.equal(req.params.actions[0].url, 'https://app.creativeforce.io/p/ZED-7');
    assert.equal(req.params.actions[1].value, 'ZED-7');
    assert.deepEqual(s.app.workflows.recording, recBefore, 'a run does not record');

    // missing params
    const miss = await s.call('browser_workflow', { action: 'run', name: 'open-project' });
    assert.equal(miss.isError, true);
    assert.match(textOf(miss), /needs params: project \(missing: project\)/);
    assert.equal(ext.requests.length, 1, 'nothing sent when params are missing');

    // unknown name, invalid name
    assert.match(textOf(await s.call('browser_workflow', { action: 'run', name: 'nope', params: {} })), /no workflow "nope" \(saved: open-project\)/);
    assert.match(textOf(await s.call('browser_workflow', { action: 'save', name: 'Bad Name' })), /invalid workflow name/);

    // overwrite keeps createdAt
    await s.call('browser_workflow', { action: 'save', name: 'open-project', params: { project: 'ACME-42' } });
    const wf2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(wf2.createdAt, wf.createdAt);
    assert.equal(wf2.description, 'Open a project');

    assert.equal(textOf(await s.call('browser_workflow', { action: 'delete', name: 'open-project' })), 'deleted workflow "open-project"');
    assert.equal(fs.existsSync(file), false);
    assert.equal(textOf(await s.call('browser_workflow', { action: 'list' })), 'no saved workflows');

    const reset = textOf(await s.call('browser_workflow', { action: 'reset' }));
    assert.equal(reset, 'recording reset (3 steps dropped)');
    assert.match(textOf(await s.call('browser_workflow', { action: 'save', name: 'empty' })), /nothing recorded/);
  });
});

test('password is never written to disk (recording, workflow, logs) and becomes a required param', async () => {
  await withApp(async (s, ext) => {
    await s.call('browser_workflow', { action: 'reset' });
    await s.call('browser_act', {
      actions: [
        { do: 'fill', ref: 1, value: 'me@creativeforce.io' },
        { do: 'fill', ref: 3, value: SECRET },
        { do: 'click', text: 'Đăng nhập', role: 'button' },
      ],
    });
    assert.equal(s.app.workflows.recording[1].value, '{{password}}');
    const saved = await s.call('browser_workflow', { action: 'save', name: 'login', params: { email: 'me@creativeforce.io' } });
    assert.match(textOf(saved), /params: email, password/);
    assert.match(textOf(await s.call('browser_workflow', { action: 'show' })), /fill textbox "Mật khẩu" = "\{\{password\}\}"/);

    const disk = readAllFiles(s.home);
    assert.ok(disk.length > 0);
    assert.ok(!disk.includes(SECRET), 'secret must not appear anywhere under FB_HOME');

    const miss = await s.call('browser_workflow', { action: 'run', name: 'login', params: { email: 'x@y.z' } });
    assert.match(textOf(miss), /missing: password/);

    ext.requests.length = 0;
    const ok = await s.call('browser_workflow', { action: 'run', name: 'login', params: { email: 'x@y.z', password: 'other-secret' } });
    assert.match(textOf(ok), /completed/);
    assert.equal(ext.requests[0].params.actions[1].value, 'other-secret');
    assert.ok(!readAllFiles(s.home).includes('other-secret'));
  });
});

test('failed run explains how to fix and seeds the recording with the steps that worked', async () => {
  await withApp(async (s) => {
    await s.call('browser_workflow', { action: 'reset' });
    await s.call('browser_act', {
      actions: [
        { do: 'fill', ref: 2, value: 'P1' },
        { do: 'click', text: 'Next', role: 'button' },
        { do: 'click', text: 'Done', role: 'button' },
      ],
    });
    await s.call('browser_workflow', { action: 'save', name: 'flow', params: { p: 'P1' } });
    // break step 2 in the saved file to simulate a UI change
    const file = path.join(s.home, 'workflows', 'flow.json');
    const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
    wf.steps[1].locator.name = 'missing';
    fs.writeFileSync(file, JSON.stringify(wf));

    const r = await s.call('browser_workflow', { action: 'run', name: 'flow', params: { p: 'P2' } });
    assert.equal(r.isError, true);
    const t = textOf(r);
    assert.match(t, /✗ 2 click/);
    assert.match(t, /workflow "flow" failed at step 2 — finish with browser_act, then browser_workflow save name=flow/);
    assert.deepEqual(s.app.workflows.recording, [wf.steps[0]], 'templated steps that worked are kept');

    // finish by hand and re-save with the same params -> whole workflow again, still templated
    await s.call('browser_act', {
      actions: [
        { do: 'click', text: 'Next v2', role: 'button' },
        { do: 'click', text: 'Done', role: 'button' },
      ],
    });
    await s.call('browser_workflow', { action: 'save', name: 'flow', params: { p: 'P2' } });
    const fixed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(fixed.steps.length, 3);
    assert.equal(fixed.steps[0].value, '{{p}}');
    assert.equal(fixed.steps[1].locator.name, 'Next v2');
    assert.deepEqual(fixed.params, ['p']);
  });
});

test('recording is mirrored to recording.json and reloaded on restart', () => {
  const home = tmpHome();
  try {
    const opts = { workflowsDir: path.join(home, 'workflows'), recordingPath: path.join(home, 'recording.json') };
    const a = createWorkflows(opts);
    a.record([{ action: { do: 'navigate', url: 'https://x.io' }, result: { ok: true } }, { action: { do: 'click', ref: 1 }, result: { ok: false } }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(opts.recordingPath, 'utf8')).steps, [{ do: 'navigate', url: 'https://x.io' }]);
    const b = createWorkflows(opts);
    assert.deepEqual(b.recording, [{ do: 'navigate', url: 'https://x.io' }]);
  } finally {
    rmHome(home);
  }
});
