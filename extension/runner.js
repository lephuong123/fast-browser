// Fast Browser — pure step-loop logic for `page.act` (SPEC "Runner semantics").
// No chrome.* access here: everything goes through injected `deps` so it is unit-testable.
//
// deps = {
//   getTab(tabId)            -> Promise<{id, url, status} | null>        (null = tab gone)
//   onTabUpdated(tabId, cb)  -> unsubscribe fn; cb(changeInfo, tab) for that tab only
//   navigate(tabId, url)     -> Promise                                  (chrome.tabs.update)
//   checkUrl(url)            -> null | error message string              (allowlist + scriptability)
//   injectPage(tabId)        -> Promise                                  (inject page.js)
//   callPage(tabId, method, args) -> Promise<value>   calls globalThis.__fb[method](...args);
//                               rejects with err.code === 'FB_MISSING' when __fb is not defined
//   now?() / setTimeout?() / clearTimeout?()          (defaults: globals)
// }

export const MAX_ACTIONS = 50;
export const LOAD_TIMEOUT_MS = 15000;
// After an explicit navigation, how long to wait for Chrome to report "loading" before trusting tab.status.
export const NAV_START_GRACE_MS = 1000;
const POLL_MS = 250;

// ---------------------------------------------------------------------------------------------
// URL helpers (allowlist) — shared with background.js

/** Add https:// to scheme-less inputs like "example.com/x". */
export function normalizeUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|javascript|blob|mailto|view-source):/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
  return 'https://' + s;
}

/** Loopback / unspecified addresses: the whole 127.0.0.0/8, 0.0.0.0, [::], [::1], IPv4-mapped loopback, *.localhost. */
export function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0') return true;
  const v6 = h.replace(/^\[|\]$/g, '');
  return v6 === '::1' || v6 === '::' || /^::ffff:(127\.|7f[0-9a-f]{2}:|0\.0\.0\.0$|0:0$)/i.test(v6);
}

/** Match = host equals entry or ends with ".entry"; "*" allows all except loopback hosts (those must be listed). */
export function hostAllowed(host, allowedDomains) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  const isLocal = isLoopbackHost(h);
  for (const raw of allowedDomains || []) {
    const e = String(raw || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (!e) continue;
    if (e === '*') {
      if (!isLocal) return true;
      continue;
    }
    if (h === e || h.endsWith('.' + e)) return true;
  }
  return false;
}

/** Returns null when the URL may be touched/navigated to, else a self-explanatory error message. */
export function checkUrl(url, allowedDomains) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return `invalid url: ${url}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `cannot use this page (${String(url).slice(0, 100)}): ${u.protocol}// pages are browser-internal or not scriptable by extensions; navigate to an http(s) site first (browser_tabs goto)`;
  }
  const host = u.hostname.toLowerCase();
  if (
    host === 'chromewebstore.google.com' ||
    (host === 'chrome.google.com' && u.pathname.startsWith('/webstore'))
  ) {
    return `cannot use this page (${host}): the Chrome Web Store cannot be scripted by extensions`;
  }
  if (!hostAllowed(host, allowedDomains)) {
    return `domain not allowed: ${host} (add it to ~/.fast-browser/config.json allowedDomains)`;
  }
  return null;
}

/**
 * Allowlist check for a tab about to be read or acted on. During a navigation tab.url is still the old
 * document while pendingUrl is the new one, so both are checked. Returns null or an error message.
 */
export function tabUrlProblem(tab, check) {
  if (!tab || (!tab.url && !tab.pendingUrl)) return check('');
  for (const u of [tab.pendingUrl, tab.url]) {
    if (!u) continue;
    const bad = check(u);
    if (bad) return `the page is on ${String(u).slice(0, 200)} — ${bad}`;
  }
  return null;
}

// The two functions below run inside the page via chrome.scripting.executeScript, so they must be
// self-contained: the in-page domain guard (a copy of hostAllowed, checked against the document that is
// actually committed — closes the race between the SW's tab.url check and execution) is inlined in each.

/** ISOLATED world: call globalThis.__fb[method](...args). */
export async function invokeFb(method, args, allowedDomains) {
  if (Array.isArray(allowedDomains)) {
    const loc = globalThis.location;
    if (loc && /^https?:$/.test(loc.protocol)) {
      const h = String(loc.hostname || '').toLowerCase().replace(/\.$/, '');
      const v6 = h.replace(/^\[|\]$/g, '');
      const local = h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0' ||
        v6 === '::1' || v6 === '::' || /^::ffff:(127\.|7f[0-9a-f]{2}:|0\.0\.0\.0$|0:0$)/i.test(v6);
      const ok = !!h && allowedDomains.some((raw) => {
        const e = String(raw || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
        if (!e) return false;
        if (e === '*') return !local;
        return h === e || h.endsWith('.' + e);
      });
      if (!ok) return { __fbError: `the page is now on ${h} — domain not allowed: ${h} (add it to ~/.fast-browser/config.json allowedDomains)` };
    }
  }
  const fb = globalThis.__fb;
  if (!fb) return { __fbMissing: true };
  if (typeof fb[method] !== 'function') return { __fbError: `page script has no method ${method}` };
  try {
    return { value: await fb[method](...(args || [])) };
  } catch (e) {
    return { __fbError: String((e && e.message) || e) };
  }
}

/** MAIN world: run `code` as an async function body; JSON round-trip, capped. */
export async function evalInPage(code, maxChars, allowedDomains) {
  if (Array.isArray(allowedDomains)) {
    const loc = globalThis.location;
    if (loc && /^https?:$/.test(loc.protocol)) {
      const h = String(loc.hostname || '').toLowerCase().replace(/\.$/, '');
      const v6 = h.replace(/^\[|\]$/g, '');
      const local = h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0' ||
        v6 === '::1' || v6 === '::' || /^::ffff:(127\.|7f[0-9a-f]{2}:|0\.0\.0\.0$|0:0$)/i.test(v6);
      const ok = !!h && allowedDomains.some((raw) => {
        const e = String(raw || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
        if (!e) return false;
        if (e === '*') return !local;
        return h === e || h.endsWith('.' + e);
      });
      if (!ok) return { denied: `the page is now on ${h} — domain not allowed: ${h} (add it to ~/.fast-browser/config.json allowedDomains)` };
    }
  }
  const isCsp = (e) => e && (e.name === 'EvalError' || /unsafe-eval|Content Security Policy/i.test(String(e.message)));
  let fn;
  try {
    const AsyncFunction = (async () => {}).constructor;
    fn = new AsyncFunction(code);
  } catch (e) {
    return isCsp(e) ? { csp: true, error: String(e.message) } : { error: `${e.name}: ${e.message}` };
  }
  let v;
  try {
    v = await fn();
  } catch (e) {
    return { error: e && e.name ? `${e.name}: ${e.message}` : String(e) };
  }
  let json;
  try {
    json = JSON.stringify(v);
  } catch (e) {
    return { error: `result is not JSON-serialisable: ${e.message}` };
  }
  if (json !== undefined && json.length > maxChars) return { tooBig: json.length };
  return { json };
}

// ---------------------------------------------------------------------------------------------
// Page calls

/** Call globalThis.__fb[method]; inject page.js first if it is missing (fresh document). */
export async function pageCall(deps, tabId, method, args = []) {
  try {
    return await deps.callPage(tabId, method, args);
  } catch (e) {
    if (!e || e.code !== 'FB_MISSING') throw e;
  }
  await deps.injectPage(tabId);
  return deps.callPage(tabId, method, args);
}

function timers(deps) {
  return {
    now: deps.now || (() => Date.now()),
    setT: deps.setTimeout || ((fn, ms) => setTimeout(fn, ms)),
    clearT: deps.clearTimeout || ((t) => clearTimeout(t)),
  };
}

/** Watches tabs.onUpdated for one tab: did a navigation start, and wakes waiters on every event. */
export function trackTab(deps, tabId) {
  const { setT, clearT } = timers(deps);
  const wakers = new Set();
  const t = {
    started: false,
    lastUrl: null,
    reset() {
      t.started = false;
    },
    stop() {
      off && off();
      for (const w of [...wakers]) w();
    },
    /** Sleep up to ms, waking early on any tab update. */
    nap(ms) {
      return new Promise((resolve) => {
        const done = () => {
          clearT(timer);
          wakers.delete(done);
          resolve();
        };
        const timer = setT(done, ms);
        wakers.add(done);
      });
    },
  };
  const off = deps.onTabUpdated(tabId, (info = {}) => {
    if (info.status === 'loading') t.started = true;
    if (info.url) {
      t.started = true;
      t.lastUrl = info.url;
    }
    for (const w of [...wakers]) w();
  });
  return t;
}

/**
 * Wait until tab.status === "complete". With expectStart, first wait (≤ NAV_START_GRACE_MS) for Chrome
 * to report the navigation as started so a stale "complete" from the previous page is not trusted.
 * Returns {ok:true} | {ok:false, timedOut:true} ; throws if the tab is gone.
 */
export async function waitForLoad(deps, tabId, tracker, { timeoutMs = LOAD_TIMEOUT_MS, expectStart = false } = {}) {
  const { now } = timers(deps);
  const t0 = now();
  const deadline = t0 + timeoutMs;
  for (;;) {
    const tab = await deps.getTab(tabId);
    if (!tab) throw new Error(`tab ${tabId} was closed`);
    const graceOver = !expectStart || tracker.started || now() - t0 >= NAV_START_GRACE_MS;
    if (graceOver && tab.status === 'complete') return { ok: true, tab };
    const left = deadline - now();
    if (left <= 0) return { ok: false, timedOut: true, tab };
    await tracker.nap(Math.min(left, POLL_MS));
  }
}

function isNavError(e) {
  const m = String((e && e.message) || e || '');
  return /frame.*(removed|was removed)|no frame|document.*(unloaded|changed)|tab.*(navigat|was closed)|message port closed|receiving end does not exist|Frame with ID/i.test(
    m,
  );
}

/**
 * After a step: if the tab started navigating (event or URL change) wait for load (≤15s), re-inject on demand,
 * then wait DOM-stable. Loops when a navigation starts during the stable wait (late JS redirects / submits).
 * Returns the tab's final URL. Throws on hard failures.
 */
export async function settle(deps, tabId, tracker, { urlBefore, expectNav = false, timeoutMs = LOAD_TIMEOUT_MS } = {}) {
  let expect = expectNav;
  let url = urlBefore;
  for (let round = 0; round < 4; round++) {
    const tab = await deps.getTab(tabId);
    if (!tab) throw new Error(`tab ${tabId} was closed`);
    // Only a navigation we caused/observed counts. A tab that was already 'loading' (slow iframe/subresource)
    // must not make every step wait LOAD_TIMEOUT_MS; waitStable itself waits for readyState !== 'loading'.
    const navigating = expect || tracker.started || (url != null && tab.url !== url);
    if (navigating) {
      const r = await waitForLoad(deps, tabId, tracker, { timeoutMs, expectStart: expect });
      // Timeout is not fatal: try to work with whatever has loaded so far (slow subresources are common).
      url = r.tab ? r.tab.url : url;
      tracker.reset();
      expect = false;
      const bad = deps.checkUrl(url);
      if (bad) throw new Error(`the page navigated to ${url} — ${bad}`);
    }
    try {
      await pageCall(deps, tabId, 'waitStable', []);
    } catch (e) {
      if (tracker.started || isNavError(e)) {
        expect = !tracker.started; // frame went away before Chrome told us; give it the start grace
        continue;
      }
      throw e;
    }
    if (!tracker.started) {
      const after = await deps.getTab(tabId);
      if (!after) throw new Error(`tab ${tabId} was closed`);
      if (after.url === url || url == null) return after.url;
      // URL changed without an event yet (e.g. pushState) — loop once more to settle it.
    }
  }
  const last = await deps.getTab(tabId);
  return last ? last.url : url;
}

function errMsg(e) {
  return String((e && e.message) || e || 'unknown error');
}

// ---------------------------------------------------------------------------------------------
// The step loop

/**
 * Run a batch of actions in one tab. Returns ActResult {steps, completed, snapshot}.
 * steps[].i is 1-based (matches the "✓ 1 fill …" text the server prints).
 */
export async function runActions(deps, { tabId, actions, loadTimeoutMs = LOAD_TIMEOUT_MS } = {}) {
  if (!Array.isArray(actions) || actions.length === 0) throw new Error('actions must be a non-empty array');
  if (actions.length > MAX_ACTIONS) throw new Error(`too many actions (${actions.length}); max ${MAX_ACTIONS} per call`);

  // Baseline: the diff returned at the end is relative to the page as it was before the batch.
  await pageCall(deps, tabId, 'snapshot', [{ mode: 'viewport' }]);

  const steps = [];
  let completed = true;

  for (let idx = 0; idx < actions.length; idx++) {
    const action = actions[idx] || {};
    const rec = { i: idx + 1, do: action.do, ok: false };
    steps.push(rec);

    const tracker = trackTab(deps, tabId);
    try {
      const before = await deps.getTab(tabId);
      if (!before) throw new Error(`tab ${tabId} was closed`);
      const urlBefore = before.url;
      let expectNav = false;

      if (action.do === 'navigate') {
        if (!action.url) throw new Error('navigate needs "url"');
        const url = normalizeUrl(action.url);
        const bad = deps.checkUrl(url);
        if (bad) throw new Error(bad);
        await deps.navigate(tabId, url);
        expectNav = true;
      } else {
        // A previous step (noWait, or a late JS redirect after settle) may have left the allowlist.
        const off = tabUrlProblem(before, deps.checkUrl);
        if (off) throw new Error(off);
        let res;
        try {
          res = await pageCall(deps, tabId, 'step', [action]);
        } catch (e) {
          // The action itself tore the document down (synchronous navigation) — that is success.
          if (tracker.started || isNavError(e)) res = { ok: true };
          else throw e;
        }
        if (!res || typeof res !== 'object') res = { ok: false, error: 'page script returned no result' };
        const { ok, error, locator, ...extra } = res;
        Object.assign(rec, extra);
        if (locator) rec.locator = locator;
        if (!ok) {
          rec.error = error || `${action.do} failed`;
          completed = false;
          break;
        }
      }

      if (!action.noWait) {
        await settle(deps, tabId, tracker, { urlBefore, expectNav, timeoutMs: loadTimeoutMs });
      }
      rec.ok = true;
    } catch (e) {
      rec.ok = false;
      rec.error = errMsg(e);
      completed = false;
      break;
    } finally {
      tracker.stop();
    }
  }

  let snapshot;
  try {
    const tab = await deps.getTab(tabId);
    if (!tab) throw new Error(`tab ${tabId} was closed`);
    const bad = tabUrlProblem(tab, deps.checkUrl);
    if (bad) throw new Error(bad); // never read pages outside the allowlist
    const r = await pageCall(deps, tabId, 'snapshot', [{ mode: completed ? 'diff' : 'viewport' }]);
    if (r && typeof r === 'object' && r.error) throw new Error(r.error);
    snapshot = r && typeof r === 'object' ? (r.text ?? '') : String(r ?? '');
  } catch (e) {
    snapshot = `(snapshot unavailable: ${errMsg(e)})`;
  }
  return { steps, completed, snapshot };
}
