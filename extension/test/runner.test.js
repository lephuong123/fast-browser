import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runActions, checkUrl, hostAllowed, normalizeUrl, pageCall, MAX_ACTIONS, isLoopbackHost, invokeFb, evalInPage } from '../runner.js';

const ALLOWED = ['example.com', 'localhost'];

// Fake browser tab + chrome.scripting/tabs, driven by per-test step handlers.
function makeEnv({ url = 'https://example.com/a', onStep = () => ({ ok: true }), loadDelay = 5, neverComplete = false } = {}) {
  const tab = { id: 1, url, status: 'complete' };
  const listeners = new Set();
  const env = {
    tab,
    injected: false,
    docId: 1,
    calls: [], // [method, arg]
    injects: 0,
    navigates: [],
    emit(info) {
      for (const l of [...listeners]) l(info, { ...tab });
    },
    // Simulate Chrome navigating the tab: loading + url now, complete after loadDelay.
    startNav(newUrl) {
      tab.status = 'loading';
      tab.url = newUrl;
      env.injected = false;
      env.docId++;
      env.emit({ status: 'loading', url: newUrl });
      if (!neverComplete) {
        setTimeout(() => {
          tab.status = 'complete';
          env.emit({ status: 'complete' });
        }, loadDelay);
      }
    },
  };
  env.deps = {
    getTab: async (id) => (id === tab.id ? { ...tab } : null),
    onTabUpdated: (id, cb) => {
      const l = (info, t) => {
        if (id === tab.id) cb(info, t);
      };
      listeners.add(l);
      return () => listeners.delete(l);
    },
    navigate: async (id, u) => {
      env.navigates.push(u);
      setTimeout(() => env.startNav(u), 1);
    },
    checkUrl: (u) => checkUrl(u, ALLOWED),
    injectPage: async () => {
      env.injects++;
      env.injected = true;
    },
    callPage: async (id, method, args) => {
      if (!env.injected) {
        const e = new Error('__fb missing');
        e.code = 'FB_MISSING';
        throw e;
      }
      env.calls.push([method, args[0], env.docId]);
      if (method === 'snapshot') return { text: `${args[0].mode}@${tab.url}` };
      if (method === 'waitStable') return true;
      if (method === 'step') return onStep(args[0], env);
      throw new Error('unknown method ' + method);
    },
  };
  return env;
}

const methods = (env) => env.calls.map((c) => c[0]);

test('all steps succeed: 1-based steps, locators kept, baseline + diff snapshot, injects once', async () => {
  const env = makeEnv({
    onStep: (a) => ({ ok: true, locator: { selector: `#${a.do}`, role: 'button', name: a.do } }),
  });
  const r = await runActions(env.deps, { tabId: 1, actions: [{ do: 'click', ref: 1 }, { do: 'fill', ref: 2, value: 'x' }] });
  assert.equal(r.completed, true);
  assert.deepEqual(
    r.steps.map((s) => [s.i, s.do, s.ok]),
    [
      [1, 'click', true],
      [2, 'fill', true],
    ],
  );
  assert.equal(r.steps[1].locator.selector, '#fill');
  assert.equal(r.snapshot, 'diff@https://example.com/a');
  assert.equal(env.injects, 1);
  assert.deepEqual(methods(env), ['snapshot', 'step', 'waitStable', 'step', 'waitStable', 'snapshot']);
  assert.equal(env.calls[0][1].mode, 'viewport');
});

test('navigation mid-batch: waits for load, re-injects, continues on the new document', async () => {
  const env = makeEnv({
    onStep: (a, e) => {
      if (a.do === 'click') e.startNav('https://example.com/next');
      return { ok: true };
    },
  });
  const r = await runActions(env.deps, {
    tabId: 1,
    actions: [{ do: 'fill', ref: 1, value: 'a' }, { do: 'click', ref: 2 }, { do: 'fill', ref: 3, value: 'b' }],
  });
  assert.equal(r.completed, true);
  assert.equal(r.steps.length, 3);
  assert.equal(env.injects, 2, 'page.js injected again after navigation');
  // waitStable after the click ran on the new document (docId 2), and step 3 too
  const afterClick = env.calls.slice(env.calls.findIndex((c) => c[0] === 'step' && c[1].do === 'click') + 1);
  assert.equal(afterClick[0][0], 'waitStable');
  assert.equal(afterClick[0][2], 2);
  assert.equal(afterClick[1][0], 'step');
  assert.equal(afterClick[1][2], 2);
  assert.equal(r.snapshot, 'diff@https://example.com/next');
});

test('stop at first failure: later steps not run, error kept, full viewport snapshot', async () => {
  const env = makeEnv({
    onStep: (a) =>
      a.text === 'Lưu'
        ? { ok: false, error: 'no element matches text "Lưu" role=button; closest: [5] button "Lưu lại"' }
        : { ok: true },
  });
  const r = await runActions(env.deps, {
    tabId: 1,
    actions: [{ do: 'click', ref: 1 }, { do: 'click', text: 'Lưu', role: 'button' }, { do: 'click', ref: 3 }],
  });
  assert.equal(r.completed, false);
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[1].ok, false);
  assert.match(r.steps[1].error, /closest: \[5\]/);
  assert.equal(methods(env).filter((m) => m === 'step').length, 2);
  assert.equal(r.snapshot, 'viewport@https://example.com/a');
});

test('navigate action: executed by the SW, waits for load, re-injects', async () => {
  const env = makeEnv();
  const r = await runActions(env.deps, {
    tabId: 1,
    actions: [{ do: 'navigate', url: 'example.com/b' }, { do: 'click', ref: 1 }],
  });
  assert.equal(r.completed, true);
  assert.deepEqual(env.navigates, ['https://example.com/b']);
  assert.equal(env.injects, 2);
  assert.ok(!env.calls.some((c) => c[0] === 'step' && c[1].do === 'navigate'), 'navigate not sent to page');
  assert.equal(r.snapshot, 'diff@https://example.com/b');
});

test('navigate action to a domain outside the allowlist fails without navigating', async () => {
  const env = makeEnv();
  const r = await runActions(env.deps, { tabId: 1, actions: [{ do: 'navigate', url: 'https://evil.test/x' }, { do: 'click', ref: 1 }] });
  assert.equal(r.completed, false);
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].error, 'domain not allowed: evil.test (add it to ~/.fast-browser/config.json allowedDomains)');
  assert.deepEqual(env.navigates, []);
});

test('click that leaves the allowlist: step fails and the snapshot is withheld', async () => {
  const env = makeEnv({
    onStep: (a, e) => {
      e.startNav('https://evil.test/');
      return { ok: true };
    },
  });
  const r = await runActions(env.deps, { tabId: 1, actions: [{ do: 'click', ref: 1 }] });
  assert.equal(r.completed, false);
  assert.match(r.steps[0].error, /navigated to https:\/\/evil\.test\/ — domain not allowed: evil\.test/);
  assert.match(r.snapshot, /^\(snapshot unavailable: .*domain not allowed: evil\.test/);
  assert.ok(!env.calls.some((c) => c[2] === 2), 'nothing ran on the disallowed page');
});

test('step whose frame is torn down by the navigation counts as success', async () => {
  const env = makeEnv();
  env.deps.callPage = ((orig) => async (id, method, args) => {
    if (method === 'step') {
      env.startNav('https://example.com/after');
      throw new Error('Frame with ID 0 was removed.');
    }
    return orig(id, method, args);
  })(env.deps.callPage);
  const r = await runActions(env.deps, { tabId: 1, actions: [{ do: 'press', key: 'Enter' }] });
  assert.equal(r.completed, true);
  assert.equal(r.steps[0].ok, true);
  assert.equal(r.snapshot, 'diff@https://example.com/after');
});

test('navigation that starts late (during the DOM-stable wait) is still followed', async () => {
  const env = makeEnv();
  let fired = false;
  env.deps.callPage = ((orig) => async (id, method, args) => {
    if (method === 'waitStable' && !fired && env.injected) {
      fired = true;
      env.startNav('https://example.com/late');
      throw new Error('Frame with ID 0 was removed.');
    }
    return orig(id, method, args);
  })(env.deps.callPage);
  const r = await runActions(env.deps, { tabId: 1, actions: [{ do: 'click', ref: 1 }, { do: 'click', ref: 2 }] });
  assert.equal(r.completed, true);
  assert.equal(env.injects, 2);
  const step2 = env.calls.find((c) => c[0] === 'step' && c[1].ref === 2);
  assert.equal(step2[2], 2, 'second click ran on the new document');
});

test('load timeout is not fatal: proceeds with what loaded', async () => {
  const env = makeEnv({
    neverComplete: true,
    onStep: (a, e) => {
      if (a.ref === 1) e.startNav('https://example.com/slow');
      return { ok: true };
    },
  });
  const r = await runActions(env.deps, { tabId: 1, loadTimeoutMs: 60, actions: [{ do: 'click', ref: 1 }, { do: 'click', ref: 2 }] });
  assert.equal(r.completed, true);
  assert.equal(env.injects, 2);
});

test('noWait skips the DOM-stable wait', async () => {
  const env = makeEnv();
  await runActions(env.deps, { tabId: 1, actions: [{ do: 'click', ref: 1, noWait: true }] });
  assert.deepEqual(methods(env), ['snapshot', 'step', 'snapshot']);
});

test('page step throwing a non-navigation error fails the step with that message', async () => {
  const env = makeEnv({
    onStep: () => {
      throw new Error('boom');
    },
  });
  const r = await runActions(env.deps, { tabId: 1, actions: [{ do: 'click', ref: 1 }] });
  assert.equal(r.completed, false);
  assert.equal(r.steps[0].error, 'boom');
});

test('batch limits', async () => {
  const env = makeEnv();
  await assert.rejects(runActions(env.deps, { tabId: 1, actions: [] }), /non-empty/);
  const many = Array.from({ length: MAX_ACTIONS + 1 }, () => ({ do: 'wait', ms: 1 }));
  await assert.rejects(runActions(env.deps, { tabId: 1, actions: many }), /max 50/);
});

test('pageCall injects only when __fb is missing', async () => {
  const env = makeEnv();
  await pageCall(env.deps, 1, 'waitStable');
  await pageCall(env.deps, 1, 'waitStable');
  assert.equal(env.injects, 1);
});

test('allowlist matching', () => {
  const list = ['creativeforce.io', 'atlassian.net'];
  assert.equal(hostAllowed('creativeforce.io', list), true);
  assert.equal(hostAllowed('app.creativeforce.io', list), true);
  assert.equal(hostAllowed('evilcreativeforce.io', list), false);
  assert.equal(hostAllowed('localhost', list), false);
  assert.equal(hostAllowed('localhost', ['localhost']), true);
  assert.equal(hostAllowed('anything.org', ['*']), true);
  assert.equal(hostAllowed('localhost', ['*']), false, 'localhost must be listed explicitly');
  assert.equal(hostAllowed('127.0.0.1', ['*', '127.0.0.1']), true);
  assert.equal(checkUrl('http://localhost:5173/x', ['localhost']), null);
  assert.match(checkUrl('chrome://extensions', ['*']), /browser-internal/);
  assert.match(checkUrl('https://chromewebstore.google.com/detail/x', ['*']), /Chrome Web Store/);
  assert.match(checkUrl('nonsense', ['*']), /invalid url/);
  assert.equal(normalizeUrl('example.com/a'), 'https://example.com/a');
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeUrl('http://x.y'), 'http://x.y');
});

test('noWait step that leaves the allowlist: the next step is refused before it runs', async () => {
  const env = makeEnv({
    neverComplete: true,
    onStep: (a, e) => {
      if (a.text === 'Open Gmail') e.startNav('https://mail.google.com/');
      return { ok: true, locator: { selector: '#x', role: 'button', name: a.text } };
    },
  });
  const r = await runActions(env.deps, {
    tabId: 1,
    actions: [{ do: 'click', text: 'Open Gmail', noWait: true }, { do: 'click', text: 'Delete', noWait: true }],
  });
  assert.equal(r.completed, false);
  assert.equal(r.steps.length, 2);
  assert.match(r.steps[1].error, /the page is on https:\/\/mail\.google\.com\/ — domain not allowed: mail\.google\.com/);
  assert.equal(r.steps[1].locator, undefined);
  assert.ok(!env.calls.some((c) => c[0] === 'step' && c[1].text === 'Delete'), 'step 2 never reached the page');
  assert.match(r.snapshot, /^\(snapshot unavailable: .*domain not allowed/);
});

test('pendingUrl outside the allowlist blocks the step even while tab.url is still the old page', async () => {
  const env = makeEnv();
  env.deps.getTab = async (id) => (id === 1 ? { ...env.tab, pendingUrl: 'https://evil.test/' } : null);
  const r = await runActions(env.deps, { tabId: 1, actions: [{ do: 'click', ref: 1 }] });
  assert.equal(r.completed, false);
  assert.match(r.steps[0].error, /evil\.test/);
  assert.ok(!env.calls.some((c) => c[0] === 'step'));
});

test('a tab already stuck in "loading" (hanging subresource) does not make steps wait for the load timeout', async () => {
  const env = makeEnv();
  env.tab.status = 'loading'; // never completes, no onUpdated events
  const t0 = Date.now();
  const r = await runActions(env.deps, { tabId: 1, loadTimeoutMs: 3000, actions: [{ do: 'fill', ref: 1, value: 'a' }, { do: 'click', ref: 2 }] });
  assert.equal(r.completed, true);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
});

test('loopback aliases are local: "*" does not cover them', () => {
  for (const h of ['127.0.0.2', '127.255.0.1', '0.0.0.0', '[::]', '[::1]', '[::ffff:7f00:1]', '[::ffff:127.0.0.1]', 'foo.localhost']) {
    assert.equal(isLoopbackHost(h), true, h);
    assert.equal(hostAllowed(h, ['*']), false, h);
  }
  assert.equal(checkUrl('http://127.0.0.2:8080/admin', ['*']) !== null, true);
  assert.equal(checkUrl('http://[::ffff:127.0.0.1]/', ['*']) !== null, true);
  assert.equal(hostAllowed('127.0.0.1', ['*', '127.0.0.1']), true, 'still allowed when listed');
  assert.equal(hostAllowed('127.0.0.2', ['127.0.0.1']), false);
  assert.equal(isLoopbackHost('128.0.0.1'), false);
  assert.equal(isLoopbackHost('example.com'), false);
});

test('in-page guard (invokeFb / evalInPage) matches hostAllowed for the committed document', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const savedFb = globalThis.__fb;
  const setUrl = (u) => Object.defineProperty(globalThis, 'location', { value: new URL(u), configurable: true, writable: true });
  try {
    globalThis.__fb = { ping: async () => 'pong' };
    const lists = [['example.com'], ['*'], ['localhost'], ['127.0.0.1', '*']];
    const urls = ['https://example.com/', 'https://a.example.com/', 'https://evil.test/', 'http://localhost:3000/', 'http://127.0.0.2/', 'http://[::1]/', 'http://127.0.0.1/'];
    for (const list of lists) {
      for (const u of urls) {
        setUrl(u);
        const want = hostAllowed(new URL(u).hostname, list);
        const r = await invokeFb('ping', [], list);
        assert.equal(r.value === 'pong', want, `invokeFb ${u} ${list}`);
        if (!want) assert.match(r.__fbError, /domain not allowed/);
        const ev = await evalInPage('return 1', 1000, list);
        assert.equal(ev.json === '1', want, `evalInPage ${u} ${list}`);
        if (!want) assert.match(ev.denied, /domain not allowed/);
      }
    }
    setUrl('about:blank');
    assert.equal((await invokeFb('ping', [], ['example.com'])).value, 'pong', 'non-http documents are left to the SW checks');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'location', saved);
    else delete globalThis.location;
    globalThis.__fb = savedFb;
  }
});
