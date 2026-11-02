// Fast Browser — MV3 service worker: WS client to the local MCP server, tab tracking, allowlist,
// method dispatch (SPEC "Extension methods"), eval in MAIN world, screenshots.
import { runActions, pageCall, trackTab, settle, checkUrl as checkUrlWith, normalizeUrl, tabUrlProblem, invokeFb, evalInPage } from './runner.js';

const DEFAULT_PORT = 17890;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 5000;
const PING_MS = 20000;
const ALARM = 'fb-keepalive';
const EVAL_MAX_CHARS = 100000;
const CONFIG_WAIT_MS = 3000;

const VERSION = chrome.runtime.getManifest().version;

let ws = null;
let port = DEFAULT_PORT;
let backoff = BACKOFF_MIN;
let reconnectTimer = null;
let pingTimer = null;
let allowedDomains = null; // from server {type:"config"}; null until the server is authenticated
let ceiling = null; // optional user-set ceiling (chrome.storage.local "allowCeiling"): the server can narrow, never widen
let authNonce = null; // our hello nonce for the current socket
let authError = '';
let configWaiters = [];
let status = { state: 'disconnected', error: '', since: Date.now() };
let currentTabId = null;
let currentLoaded = false;

// ---------------------------------------------------------------------------------------------
// Status (popup + badge)

function setStatus(state, error = '') {
  status = { state, error, since: Date.now() };
  const badge = state === 'connected' ? '' : state === 'connecting' || state === 'authenticating' ? '…' : '!';
  try {
    chrome.action.setBadgeText({ text: badge });
    chrome.action.setBadgeBackgroundColor({ color: state === 'connecting' ? '#9a7b00' : '#c62828' });
    chrome.action.setTitle({ title: `Fast Browser — ${state}${error ? ': ' + error : ''} (port ${port})` });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------------------------
// Allowlist = server list, intersected with the optional extension-side ceiling

function checkUrl(url) {
  const bad = checkUrlWith(url, allowedDomains);
  if (bad || !ceiling) return bad;
  const capped = checkUrlWith(url, ceiling);
  return capped ? capped.replace('(add it to ~/.fast-browser/config.json allowedDomains)', "(outside the extension popup's allowed-domains ceiling)") : null;
}

/** Domains for the in-page guard (second layer; the SW-side checks above also apply the ceiling). */
function pageAllowList() {
  return allowedDomains || [];
}

async function loadSettings() {
  try {
    const { allowCeiling } = await chrome.storage.local.get('allowCeiling');
    const list = Array.isArray(allowCeiling) ? allowCeiling.map((d) => String(d).trim().toLowerCase()).filter(Boolean) : [];
    ceiling = list.length ? list : null;
  } catch {
    ceiling = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Token handshake (see server/src/bridge.js). The shared secret is $FB_HOME/token on the server side and is
// pasted once into the popup (chrome.storage.local "token"). A process that merely grabbed the port cannot
// produce the proof, so it never gets to set allowedDomains or send requests.

async function loadToken() {
  try {
    const { token } = await chrome.storage.local.get('token');
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function randomHex(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key, message) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function refuseServer(sock, message) {
  authError = message;
  setStatus('unpaired', message);
  try {
    sock.close(4003, 'server not authenticated');
  } catch {
    /* ignore */
  }
}

async function onConfig(sock, msg) {
  const token = await loadToken();
  if (ws !== sock) return;
  if (!token) {
    return refuseServer(sock, 'not paired: paste the token from ~/.fast-browser/token (machine running Claude Code) into this popup');
  }
  if (typeof msg.proof !== 'string' || typeof msg.nonce !== 'string') {
    return refuseServer(sock, 'the server on this port did not authenticate (outdated Fast Browser server, or not Fast Browser); refusing');
  }
  const expect = await hmacHex(token, 'server:' + authNonce);
  if (ws !== sock) return;
  if (!sameStr(expect, msg.proof)) {
    return refuseServer(sock, 'server failed authentication (token mismatch): re-paste the token from ~/.fast-browser/token');
  }
  sock.send(JSON.stringify({ type: 'auth', proof: await hmacHex(token, 'ext:' + msg.nonce) }));
  if (ws !== sock) return;
  allowedDomains = Array.isArray(msg.allowedDomains) ? msg.allowedDomains.map(String) : [];
  authError = '';
  setStatus('connected');
  configWaiters.splice(0).forEach((w) => w());
}

// ---------------------------------------------------------------------------------------------
// WebSocket client

async function loadPort() {
  try {
    const { port: p } = await chrome.storage.local.get('port');
    const n = Number(p);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  port = await loadPort();
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return; // raced
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) {
    setStatus('disconnected', e.message);
    scheduleReconnect();
    return;
  }
  ws = sock;
  allowedDomains = null;
  setStatus('connecting');
  sock.onopen = () => {
    if (ws !== sock) return;
    authNonce = randomHex(16);
    send({ type: 'hello', version: VERSION, extensionId: chrome.runtime.id, nonce: authNonce });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS);
    setStatus('authenticating');
  };
  sock.onmessage = (ev) => onMessage(sock, ev.data);
  sock.onerror = () => {
    /* onclose follows */
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    const wasAuthed = !!allowedDomains;
    ws = null;
    allowedDomains = null;
    clearInterval(pingTimer);
    pingTimer = null;
    if (authError) setStatus('unpaired', authError);
    else setStatus('disconnected', ev.code === 4000 ? 'replaced by another connection' : ev.reason || '');
    if (wasAuthed) backoff = BACKOFF_MIN; // lost a working server: retry quickly
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, BACKOFF_MAX);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function reconnectNow() {
  backoff = BACKOFF_MIN;
  authError = '';
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const old = ws;
  ws = null;
  if (old) {
    old.onclose = null;
    try {
      old.close();
    } catch {
      /* ignore */
    }
  }
  clearInterval(pingTimer);
  connect();
}

function onMessage(sock, data) {
  let msg;
  try {
    msg = JSON.parse(String(data));
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  if (ws !== sock) return;
  if (msg.type === 'config') {
    onConfig(sock, msg).catch((e) => refuseServer(sock, 'authentication error: ' + String((e && e.message) || e)));
    return;
  }
  // Requests are honoured only after the server proved it knows the token (onConfig sets allowedDomains).
  if (msg.type === 'req' && allowedDomains) handleRequest(msg);
}

async function handleRequest({ id, method, params }) {
  try {
    const fn = METHODS[method];
    if (!fn) throw new Error(`unknown method: ${method}`);
    await waitForConfig();
    const result = await fn(params || {});
    send({ id, type: 'res', ok: true, result });
  } catch (e) {
    const error = { message: String((e && e.message) || e || 'unknown error') };
    if (e && e.snapshot) error.snapshot = e.snapshot;
    send({ id, type: 'res', ok: false, error });
  }
}

function waitForConfig() {
  if (allowedDomains) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      configWaiters = configWaiters.filter((w) => w !== done);
      reject(new Error('no config received from the Fast Browser server yet; retry'));
    }, CONFIG_WAIT_MS);
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    configWaiters.push(done);
  });
}

// ---------------------------------------------------------------------------------------------
// Current tab tracking

async function loadCurrent() {
  if (currentLoaded) return;
  currentLoaded = true;
  try {
    const { currentTabId: id } = await chrome.storage.session.get('currentTabId');
    if (currentTabId == null && Number.isInteger(id)) currentTabId = id;
  } catch {
    /* ignore */
  }
}

function setCurrent(tabId) {
  currentTabId = tabId;
  try {
    chrome.storage.session.set({ currentTabId: tabId });
  } catch {
    /* ignore */
  }
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

/** The tab a method acts on when no tabId is given; null if none. */
async function defaultTabId() {
  await loadCurrent();
  if (currentTabId != null && (await getTab(currentTabId))) return currentTabId;
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (t) return t.id;
  const [any] = await chrome.tabs.query({ active: true });
  return any ? any.id : null;
}

async function resolveTab(params) {
  const id = params.tabId != null ? Number(params.tabId) : await defaultTabId();
  if (id == null) throw new Error('no tab available — open one with browser_tabs action=new');
  const tab = await getTab(id);
  if (!tab) throw new Error(`tab ${id} not found (closed?) — list tabs with browser_tabs action=list`);
  return tab;
}

/** Resolve + allowlist check for methods that read/act on page content. */
async function resolveUsableTab(params) {
  const tab = await resolveTab(params);
  const bad = tabUrlProblem(tab, checkUrl); // pendingUrl too: during a navigation tab.url is still the old page
  if (bad) throw new Error(bad);
  return tab;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === currentTabId) setCurrent(null);
});

// ---------------------------------------------------------------------------------------------
// Page bridge (chrome.scripting) — deps for runner.js

function friendlyScriptError(e, tab) {
  const m = String((e && e.message) || e);
  if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\/|edge:\/\/|missing host permission|Cannot script/i.test(m)) {
    return new Error(
      `cannot run on this page (${tab && tab.url ? tab.url.slice(0, 100) : 'unknown url'}): browser-internal or protected pages ` +
        `(chrome://, Chrome Web Store, PDF viewer, other extensions) cannot be scripted — navigate to a normal web page (${m})`,
    );
  }
  return e instanceof Error ? e : new Error(m);
}

const deps = {
  getTab,
  onTabUpdated(tabId, cb) {
    const l = (id, info, tab) => {
      if (id === tabId) cb(info, tab);
    };
    chrome.tabs.onUpdated.addListener(l);
    return () => chrome.tabs.onUpdated.removeListener(l);
  },
  navigate: (tabId, url) => chrome.tabs.update(tabId, { url }),
  checkUrl: (url) => checkUrl(url),
  async injectPage(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['page.js'] });
    } catch (e) {
      throw friendlyScriptError(e, await getTab(tabId));
    }
  },
  async callPage(tabId, method, args) {
    let res;
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: invokeFb, args: [method, args || [], pageAllowList()] });
      res = r && r.result;
    } catch (e) {
      throw friendlyScriptError(e, await getTab(tabId));
    }
    if (!res || typeof res !== 'object') {
      const e = new Error('page script did not answer (document changed?)');
      e.code = 'FB_MISSING';
      throw e;
    }
    if (res.__fbMissing) {
      const e = new Error('page script missing');
      e.code = 'FB_MISSING';
      throw e;
    }
    if (res.__fbError) throw new Error(res.__fbError);
    return res.value;
  },
};

async function snapshotText(tabId, mode = 'viewport', region) {
  const opts = { mode };
  if (region) opts.region = region;
  const r = await pageCall(deps, tabId, 'snapshot', [opts]);
  if (r && typeof r === 'object' && r.error) throw new Error(r.error);
  return r && typeof r === 'object' ? (r.text ?? '') : String(r ?? '');
}

/** Navigate tabId to url (already allowlist-checked), wait load + DOM-stable, return viewport snapshot. */
async function openUrl(tabId, url) {
  const before = await getTab(tabId);
  const tracker = trackTab(deps, tabId);
  try {
    await chrome.tabs.update(tabId, { url });
    await settle(deps, tabId, tracker, { urlBefore: before ? before.url : null, expectNav: true });
  } finally {
    tracker.stop();
  }
  return snapshotText(tabId, 'viewport');
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* ignore */
  }
}

function checkedUrl(raw) {
  if (!raw) throw new Error('url is required');
  const url = normalizeUrl(raw);
  const bad = checkUrl(url);
  if (bad) throw new Error(bad);
  return url;
}

// ---------------------------------------------------------------------------------------------
// Methods

const METHODS = {
  async 'tabs.list'() {
    const cur = await defaultTabId();
    const tabs = await chrome.tabs.query({});
    // Tabs outside the allowlist: only the host is shown, never title/path/query (reset tokens, mail subjects).
    return {
      tabs: tabs.map((t) => {
        const url = t.url || t.pendingUrl || '';
        const ok = !tabUrlProblem(t, checkUrl);
        let shown = url;
        if (!ok) {
          let host = '';
          try {
            host = new URL(url).host;
          } catch {
            /* ignore */
          }
          shown = `(not allowed${host ? ': ' + host : ''})`;
        }
        return { tabId: t.id, title: ok ? t.title || '' : '', url: shown, active: !!t.active, current: t.id === cur };
      }),
    };
  },

  async 'tabs.goto'(p) {
    const url = checkedUrl(p.url);
    let tabId = p.tabId != null ? Number(p.tabId) : await defaultTabId();
    if (tabId == null || !(await getTab(tabId))) {
      if (p.tabId != null) throw new Error(`tab ${p.tabId} not found`);
      const t = await chrome.tabs.create({ url: 'about:blank', active: true });
      tabId = t.id;
    }
    setCurrent(tabId);
    const snapshot = await openUrl(tabId, url);
    return { tabId, snapshot };
  },

  async 'tabs.new'(p) {
    const url = p.url ? checkedUrl(p.url) : null;
    const t = await chrome.tabs.create({ active: true, ...(url ? { url: 'about:blank' } : {}) });
    setCurrent(t.id);
    if (!url) return { tabId: t.id };
    const snapshot = await openUrl(t.id, url);
    return { tabId: t.id, snapshot };
  },

  async 'tabs.select'(p) {
    if (p.tabId == null) throw new Error('tabId is required');
    const tab = await resolveTab(p);
    const bad = tabUrlProblem(tab, checkUrl); // before focusing it or making it the current tab
    if (bad) throw new Error(`tab ${tab.id} not selected: ${bad}`);
    await focusTab(tab);
    setCurrent(tab.id);
    const snapshot = await snapshotText(tab.id, 'viewport');
    return { tabId: tab.id, snapshot };
  },

  async 'tabs.close'(p) {
    const tab = await resolveTab(p);
    await chrome.tabs.remove(tab.id);
    if (tab.id === currentTabId) setCurrent(null);
    return { closed: tab.id };
  },

  async 'page.snapshot'(p) {
    const tab = await resolveUsableTab(p);
    const mode = ['diff', 'viewport', 'full'].includes(p.mode) ? p.mode : 'viewport';
    return { text: await snapshotText(tab.id, mode, p.region) };
  },

  async 'page.act'(p) {
    const tab = await resolveUsableTab(p);
    return runActions(deps, { tabId: tab.id, actions: p.actions });
  },

  async 'page.extract'(p) {
    const tab = await resolveUsableTab(p);
    const opts = { kind: ['text', 'table', 'links'].includes(p.kind) ? p.kind : 'text' };
    if (p.region) opts.region = p.region;
    if (p.maxChars != null) opts.maxChars = Number(p.maxChars);
    const r = await pageCall(deps, tab.id, 'extract', [opts]);
    if (r && r.error) throw new Error(r.error);
    return { text: (r && r.text) || '', truncated: !!(r && r.truncated) };
  },

  async 'page.eval'(p) {
    if (typeof p.code !== 'string' || !p.code.trim()) throw new Error('code is required');
    const tab = await resolveUsableTab(p);
    let r;
    try {
      [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: evalInPage,
        args: [p.code, EVAL_MAX_CHARS, pageAllowList()],
      });
    } catch (e) {
      throw friendlyScriptError(e, tab);
    }
    const res = r && r.result;
    if (!res || typeof res !== 'object') throw new Error('eval returned nothing (the page navigated away?)');
    if (res.denied) throw new Error(res.denied);
    if (res.csp) {
      throw new Error(
        `this page's Content-Security-Policy blocks eval ('unsafe-eval' not allowed), so browser_eval cannot run here — ` +
          `use browser_extract (text/table/links) or browser_snapshot instead. (${res.error})`,
      );
    }
    if (res.error) throw new Error(`eval error: ${res.error}`);
    if (res.tooBig) throw new Error(`eval result too large (${res.tooBig} chars of JSON > ${EVAL_MAX_CHARS}); return less data`);
    return { value: res.json === undefined ? null : JSON.parse(res.json) };
  },

  async 'page.screenshot'(p) {
    const tab = await resolveUsableTab(p);
    const maxWidth = Math.max(16, Number(p.maxWidth) || 1024);
    const quality = Math.min(100, Math.max(1, Math.round(Number(p.quality) || 60)));
    if (!tab.active) {
      await focusTab(tab);
      await new Promise((r) => setTimeout(r, 150)); // let the tab paint
    }
    // captureVisibleTab grabs whatever is visible: re-check it is still this tab, on an allowed URL.
    const [shown] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (!shown || shown.id !== tab.id) throw new Error(`tab ${tab.id} is not the visible tab of its window (focus changed); retry`);
    const shownBad = tabUrlProblem(shown, checkUrl);
    if (shownBad) throw new Error(shownBad);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality });
    return { dataBase64: await downscale(dataUrl, maxWidth, quality), mimeType: 'image/jpeg' };
  },
};

async function downscale(dataUrl, maxWidth, quality) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  try {
    if (bmp.width <= maxWidth) return b64;
    const w = maxWidth;
    const h = Math.max(1, Math.round((bmp.height * maxWidth) / bmp.width));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
    return toBase64(await out.arrayBuffer());
  } finally {
    bmp.close();
  }
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------------------------------------
// Popup messages, settings, lifecycle

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'fb.status') {
    (async () => {
      const cur = await defaultTabId().catch(() => null);
      sendResponse({ ...status, port, allowedDomains, ceiling, paired: !!(await loadToken()), currentTabId: cur, version: VERSION });
    })();
    return true;
  }
  if (msg.type === 'fb.reconnect') {
    reconnectNow();
    sendResponse({ ok: true });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.allowCeiling) loadSettings();
  if (changes.port || changes.token) reconnectNow();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  if (!ws) connect();
  else send({ type: 'ping' });
});

chrome.alarms.get(ALARM).then((a) => {
  if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

setStatus('disconnected');
loadCurrent();
loadSettings().finally(() => connect());
