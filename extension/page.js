// Fast Browser — page logic injected into tabs (content script, isolated world).
// Defines globalThis.__fb. Plain JS, no imports. Injecting it again into the same
// document is a no-op. All public methods take/return JSON-serialisable data.
(() => {
  'use strict';
  const doc = globalThis.document;
  if (!doc) return;
  if (globalThis.__fb && globalThis.__fb._doc === doc) return;

  const win = doc.defaultView || globalThis;

  // ---------- small utils ----------
  const norm = (s) => String(s == null ? '' : s).replace(/[\s\u00a0]+/g, ' ').trim();
  const lower = (s) => norm(s).toLowerCase();
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cssEscape = (s) =>
    win.CSS && typeof win.CSS.escape === 'function'
      ? win.CSS.escape(s)
      : String(s)
          .replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (c) => '\\' + c)
          .replace(/^(-?)(\d)/, (m, d, n) => d + '\\3' + n + ' ');
  const attrVal = (v) => '"' + String(v).replace(/["\\]/g, '\\$&') + '"';

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem',
  ]);
  const NAME_FROM_CONTENT = new Set([
    'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'switch', 'heading', 'treeitem', 'clickable', 'cell', 'gridcell', 'columnheader', 'rowheader',
  ]);
  const INTERACTIVE_SEL = [
    'a[href]', 'button', 'input', 'select', 'textarea', '[contenteditable]', 'summary', '[role]', '[onclick]', '[tabindex]',
  ].join(',');
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
    'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main',
    'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'caption',
  ]);
  const SKIP_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);
  const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'password', 'search', 'number',
    'date', 'time', 'datetime-local', 'month', 'week', 'color']);

  // ---------- state ----------
  const fb = {
    _doc: doc,
    version: '0.1.0',
    _timing: { quiet: 300, cap: 2500, poll: 100, checkSettle: 500 },
    _refs: new WeakMap(), // element -> ref
    _byRef: new Map(), // ref -> WeakRef(element)
    _counter: 0,
    _baseline: null, // {title, url, modal, lines: Map(ref -> line)}
  };

  // Layout helper: everything that needs layout goes through here so jsdom tests can stub it.
  fb._geom = {
    rect(el) {
      return el.getBoundingClientRect();
    },
    hasBox(el) {
      const r = fb._geom.rect(el);
      return r.width > 0 && r.height > 0;
    },
    inViewport(el) {
      const r = fb._geom.rect(el);
      const vw = win.innerWidth || doc.documentElement.clientWidth;
      const vh = win.innerHeight || doc.documentElement.clientHeight;
      return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    },
    viewportHeight() {
      return win.innerHeight || doc.documentElement.clientHeight || 800;
    },
    scrollPercent() {
      const se = doc.scrollingElement || doc.documentElement;
      const max = (se ? se.scrollHeight : 0) - (win.innerHeight || 0);
      if (!(max > 0)) return 0;
      return Math.round(Math.min(100, Math.max(0, ((win.scrollY || 0) / max) * 100)));
    },
  };

  // ---------- refs ----------
  function refOf(el) {
    let r = fb._refs.get(el);
    if (!r) {
      r = ++fb._counter;
      fb._refs.set(el, r);
      fb._byRef.set(r, typeof WeakRef === 'function' ? new WeakRef(el) : { deref: () => el });
    }
    return r;
  }
  function elOfRef(ref) {
    const w = fb._byRef.get(ref);
    return w ? w.deref() || null : undefined; // undefined = never issued, null = collected
  }

  // ---------- visibility ----------
  function ownHidden(el) {
    if (el.hasAttribute('hidden')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const p = el.parentElement;
    if (p && p.localName === 'details' && !p.open && !(el.localName === 'summary' && p.querySelector(':scope > summary') === el)) return true;
    if (el.localName === 'dialog' && !el.hasAttribute('open')) return true;
    const cs = win.getComputedStyle(el);
    return cs.display === 'none';
  }
  function makeHiddenCache() {
    const cache = new Map();
    const hidden = (el) => {
      if (!el || el.nodeType !== 1) return false;
      if (cache.has(el)) return cache.get(el);
      const h = ownHidden(el) || hidden(el.parentElement);
      cache.set(el, h);
      return h;
    };
    return hidden;
  }
  function styleVisible(el, hiddenFn) {
    const hidden = hiddenFn || makeHiddenCache();
    if (hidden(el)) return false;
    const v = win.getComputedStyle(el).visibility;
    return v !== 'hidden' && v !== 'collapse';
  }
  function isVisible(el, hiddenFn) {
    return el.isConnected && styleVisible(el, hiddenFn) && fb._geom.hasBox(el);
  }

  // ---------- roles / names / states ----------
  function inputType(el) {
    return (el.getAttribute('type') || '').toLowerCase();
  }
  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
    const tag = el.localName;
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button': return 'button';
      case 'summary': return 'button';
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'option': return 'option';
      case 'img': return 'img';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'dialog': return 'dialog';
      case 'input': {
        const t = inputType(el);
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'range') return 'slider';
        if (t === 'number') return 'spinbutton';
        if (['button', 'submit', 'reset', 'image', 'file'].includes(t)) return 'button';
        if (el.hasAttribute('list')) return 'combobox';
        if (t === 'search') return 'searchbox';
        return 'textbox';
      }
    }
    if (isContentEditable(el)) return 'textbox';
    if (el.hasAttribute('onclick') || tabIndexAttr(el) >= 0) return 'clickable';
    return 'generic';
  }
  function tabIndexAttr(el) {
    const t = el.getAttribute('tabindex');
    if (t == null || t.trim() === '') return NaN;
    return parseInt(t, 10);
  }
  function isContentEditable(el) {
    const ce = el.getAttribute('contenteditable');
    return ce != null && ce.toLowerCase() !== 'false';
  }
  function isInteractive(el) {
    const tag = el.localName;
    if (tag === 'input') return inputType(el) !== 'hidden';
    if (tag === 'a') { if (el.hasAttribute('href')) return true; }
    else if (tag === 'button' || tag === 'select' || tag === 'textarea') return true;
    if (tag === 'summary') return true;
    if (isContentEditable(el)) return true;
    const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    if (tabIndexAttr(el) >= 0) return true;
    return false;
  }

  // Visible text of a subtree (img alt included, hidden parts and `skip` subtree excluded).
  function textOf(node, skip) {
    let out = '';
    const walk = (n) => {
      if (n === skip) return;
      if (n.nodeType === 3) { out += n.data; return; }
      if (n.nodeType !== 1) return;
      const tag = n.localName;
      if (SKIP_TEXT_TAGS.has(tag)) return;
      if (n !== node && ownHidden(n)) return;
      if (tag === 'img' || (tag === 'input' && inputType(n) === 'image')) { out += ' ' + (n.getAttribute('alt') || '') + ' '; return; }
      if (tag === 'br') { out += ' '; return; }
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return; // embedded controls
      const block = BLOCK_TAGS.has(tag);
      if (block) out += ' ';
      for (const c of n.childNodes) walk(c);
      if (block) out += ' ';
    };
    walk(node);
    return norm(out);
  }

  function labelsText(el) {
    let labels = [];
    try { labels = el.labels ? Array.from(el.labels) : []; } catch { labels = []; }
    if (!labels.length && el.id) labels = Array.from(doc.querySelectorAll('label[for=' + attrVal(el.id) + ']'));
    return norm(labels.map((l) => textOf(l, el)).join(' '));
  }

  function accName(el) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = norm(lb.split(/\s+/).map((id) => doc.getElementById(id)).filter(Boolean).map((n) => textOf(n)).join(' '));
      if (t) return t;
    }
    const al = norm(el.getAttribute('aria-label'));
    if (al) return al;
    const tag = el.localName;
    const role = roleOf(el);
    if (tag === 'input') {
      const t = inputType(el);
      if (t === 'button' || t === 'submit' || t === 'reset') {
        return norm(el.value) || norm(el.getAttribute('title')) || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : '');
      }
      if (t === 'image') return norm(el.getAttribute('alt')) || norm(el.value) || norm(el.getAttribute('title')) || 'Submit';
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'meter' || tag === 'progress' || tag === 'output') {
      const lt = labelsText(el);
      if (lt) return lt;
      const ph = norm(el.getAttribute('placeholder')) || norm(el.getAttribute('aria-placeholder'));
      if (ph) return ph;
      return norm(el.getAttribute('title'));
    }
    if (tag === 'img') return norm(el.getAttribute('alt')) || norm(el.getAttribute('title'));
    if (isContentEditable(el) || role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      return norm(el.getAttribute('aria-placeholder')) || norm(el.getAttribute('placeholder')) ||
        norm(el.getAttribute('data-placeholder')) || norm(el.getAttribute('title')) ||
        (isContentEditable(el) || tag === 'input' ? '' : textOf(el));
    }
    if (NAME_FROM_CONTENT.has(role) || tag === 'a' || tag === 'button' || tag === 'summary') {
      const t = textOf(el);
      if (t) return t;
      return norm(el.getAttribute('title'));
    }
    return norm(el.getAttribute('title')) || textOf(el);
  }

  function isDisabled(el) {
    try { if (el.matches(':disabled')) return true; } catch { /* ignore */ }
    const a = el.closest('[aria-disabled]');
    return !!(a && a.getAttribute('aria-disabled') === 'true');
  }

  function selectedText(sel) {
    return norm(Array.from(sel.selectedOptions || []).map((o) => o.label || o.text).join(', '));
  }

  function statesOf(el, name) {
    const s = [];
    const tag = el.localName;
    const role = roleOf(el);
    const t = tag === 'input' ? inputType(el) : '';
    if (tag === 'select') {
      const v = selectedText(el);
      if (v) s.push('selected=' + q(trunc(v, 60)));
    } else if (tag === 'textarea' || (tag === 'input' && (TEXT_INPUT_TYPES.has(t) || t === 'range'))) {
      const v = el.value || '';
      if (v) {
        const shown = t === 'password' ? '••••' : trunc(norm(v), 60);
        s.push((role === 'combobox' ? 'selected=' : 'value=') + q(shown));
      }
    } else if (isContentEditable(el)) {
      const v = textOf(el);
      if (v) s.push('value=' + q(trunc(v, 60)));
    } else if (role === 'combobox') {
      const v = textOf(el);
      if (v && v !== name) s.push('selected=' + q(trunc(v, 60)));
    }
    if (tag === 'input' && (t === 'checkbox' || t === 'radio')) { if (el.checked) s.push('checked'); }
    else if (el.getAttribute('aria-checked') === 'true') s.push('checked');
    else if (el.getAttribute('aria-checked') === 'mixed') s.push('mixed');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') s.push('pressed');
    if (isDisabled(el)) s.push('disabled');
    let exp = el.getAttribute('aria-expanded');
    if (exp == null && tag === 'summary' && el.parentElement && el.parentElement.localName === 'details') exp = String(el.parentElement.open);
    if (exp === 'true') s.push('expanded');
    else if (exp === 'false') s.push('collapsed');
    if (el.required || el.getAttribute('aria-required') === 'true') s.push('required');
    if (doc.activeElement === el) s.push('focused');
    return s;
  }

  function lineOf(el, ref) {
    const name = accName(el);
    const states = statesOf(el, name);
    return '[' + ref + '] ' + roleOf(el) + ' ' + q(trunc(name, 80)) + (states.length ? ' ' + states.join(' ') : '');
  }
  function describe(el) {
    return '[' + refOf(el) + '] ' + roleOf(el) + ' ' + q(trunc(accName(el), 80));
  }

  // ---------- modal ----------
  function findModal(hiddenFn) {
    const hidden = hiddenFn || makeHiddenCache();
    const list = Array.from(doc.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]'))
      .filter((m) => isVisible(m, hidden));
    return list.length ? list[list.length - 1] : null;
  }

  // ---------- snapshot ----------
  function collect(mode, region) {
    const hidden = makeHiddenCache();
    const modal = findModal(hidden);
    let root = modal || doc.body || doc.documentElement;
    if (region) {
      let r;
      try { r = doc.querySelector(region); } catch { throw new Error('invalid region selector ' + q(region)); }
      if (!r) throw new Error('region ' + q(region) + ' not found');
      root = r;
    }
    const items = []; // {kind:'heading', text} | {kind:'item', ref, line, el}
    if (!root || hidden(root)) return { modal, items };
    const walker = doc.createTreeWalker(root, 1 /* SHOW_ELEMENT */, {
      acceptNode: (n) => (n !== root && hidden(n) ? 2 /* REJECT */ : 1 /* ACCEPT */),
    });
    let pendingHeading = null;
    for (let el = root; el; el = walker.nextNode()) {
      const tag = el.localName;
      const isHeading = /^h[1-3]$/.test(tag) || (el.getAttribute('role') || '').trim() === 'heading';
      if (isHeading && el !== root) {
        if (styleVisible(el, hidden) && fb._geom.hasBox(el)) {
          const t = trunc(textOf(el), 80);
          if (t) pendingHeading = t;
        }
        continue;
      }
      if (!isInteractive(el)) continue;
      if (!styleVisible(el, hidden) || !fb._geom.hasBox(el)) continue;
      if (mode !== 'full' && !fb._geom.inViewport(el)) continue;
      if (pendingHeading) { items.push({ kind: 'heading', text: pendingHeading }); pendingHeading = null; }
      const ref = refOf(el);
      items.push({ kind: 'item', ref, line: lineOf(el, ref), el });
    }
    return { modal, items };
  }

  function header(modal) {
    return [norm(doc.title), String(doc.location ? doc.location.href : ''), 'scroll ' + fb._geom.scrollPercent() + '%']
      .concat(modal ? ['[modal]'] : []);
  }

  function storeBaseline(items, modal) {
    const lines = new Map();
    for (const it of items) if (it.kind === 'item') lines.set(it.ref, it.line);
    fb._baseline = { title: norm(doc.title), url: String(doc.location ? doc.location.href : ''), modal: !!modal, lines };
  }

  function renderFull(items, modal) {
    const out = header(modal);
    out.push('');
    let n = 0;
    for (const it of items) {
      if (it.kind === 'heading') out.push('— ' + it.text);
      else { out.push(it.line); n++; }
    }
    if (!n) out.push('(no interactive elements' + ' in view)');
    return out.join('\n');
  }

  function renderDiff(items, modal) {
    const base = fb._baseline;
    const out = [];
    const title = norm(doc.title), url = String(doc.location ? doc.location.href : '');
    if (base.title !== title || base.url !== url) {
      out.push(title, url, 'scroll ' + fb._geom.scrollPercent() + '%');
    }
    if (base.modal !== !!modal) out.push(modal ? '[modal]' : '[modal closed]');
    if (out.length) out.push('');
    const hdrLen = out.length;
    const seen = new Set();
    const hidden = makeHiddenCache();
    for (const it of items) {
      if (it.kind !== 'item') continue;
      seen.add(it.ref);
      const prev = base.lines.get(it.ref);
      if (prev === undefined) out.push('+ ' + it.line);
      else if (prev !== it.line) out.push('~ ' + it.line);
    }
    for (const [ref, line] of base.lines) {
      if (seen.has(ref)) continue;
      const el = elOfRef(ref);
      // Only report elements that really went away (removed / hidden), not ones merely scrolled
      // out of view or hidden behind a newly opened modal.
      const gone = !el || !el.isConnected || !isVisible(el, hidden);
      if (gone) out.push('- ' + line);
    }
    if (out.length === hdrLen && !hdrLen) return '(no changes)';
    if (out.length === hdrLen) out.push('(no changes)');
    return out.join('\n');
  }

  function snapshotText(opts) {
    const mode = (opts && opts.mode) || 'viewport';
    const region = opts && opts.region;
    if (!['diff', 'viewport', 'full'].includes(mode)) throw new Error('unknown snapshot mode ' + q(mode));
    const { modal, items } = collect(mode === 'full' ? 'full' : 'viewport', region);
    let text;
    if (mode === 'diff') {
      text = fb._baseline ? renderDiff(items, modal) : '(new page)\n' + renderFull(items, modal);
    } else {
      text = renderFull(items, modal);
    }
    storeBaseline(items, modal);
    return text;
  }

  fb.snapshot = function snapshot(opts) {
    try {
      return { text: snapshotText(opts || {}) };
    } catch (e) {
      return { text: '', error: String((e && e.message) || e) };
    }
  };
  // Store the current viewport line map as diff baseline without returning text.
  fb.mark = function mark(opts) {
    try {
      const { modal, items } = collect('viewport', opts && opts.region);
      storeBaseline(items, modal);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };

  // ---------- candidates / matching ----------
  function interactiveCandidates(scope) {
    const hidden = makeHiddenCache();
    const root = scope || doc;
    const out = [];
    for (const el of root.querySelectorAll(INTERACTIVE_SEL)) {
      if (isInteractive(el) && isVisible(el, hidden)) out.push(el);
    }
    return out;
  }
  function bigrams(s) {
    const g = new Map();
    const t = ' ' + s + ' ';
    for (let i = 0; i < t.length - 1; i++) { const b = t.slice(i, i + 2); g.set(b, (g.get(b) || 0) + 1); }
    return g;
  }
  function similarity(a, b) {
    a = lower(a); b = lower(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    let score = 0;
    if (b.includes(a) || a.includes(b)) score = 0.6;
    const ga = bigrams(a), gb = bigrams(b);
    let inter = 0, total = 0;
    for (const [k, v] of ga) { inter += Math.min(v, gb.get(k) || 0); total += v; }
    for (const v of gb.values()) total += v;
    return Math.max(score, total ? (2 * inter) / total : 0);
  }
  function closestList(text, role, pool) {
    const scored = pool.map((el) => {
      let s = similarity(text || '', accName(el));
      if (role && roleOf(el) === role) s += 0.25;
      return { el, s };
    }).filter((x) => x.s > (text ? 0.15 : 0));
    scored.sort((x, y) => y.s - x.s);
    const top = scored.slice(0, 5);
    if (!top.length) return 'no interactive elements visible' + (pool.length ? '' : ' on the page');
    return 'closest: ' + top.map((x) => describe(x.el)).join(', ');
  }

  function matchByName(text, role, pool) {
    const filtered = role ? pool.filter((el) => roleOf(el) === role) : pool;
    const want = norm(text);
    const wl = want.toLowerCase();
    const named = filtered.map((el) => ({ el, n: accName(el) }));
    let m = named.filter((x) => x.n === want);
    if (!m.length) m = named.filter((x) => x.n.toLowerCase() === wl);
    if (!m.length && wl) m = named.filter((x) => x.n.toLowerCase().includes(wl));
    return m.map((x) => x.el);
  }

  // Smallest visible element whose own text equals `text` (for click targets without semantics).
  function matchPlainText(text, scope) {
    const wl = lower(text);
    if (!wl) return null;
    const hidden = makeHiddenCache();
    let best = null;
    for (const el of (scope || doc.body || doc).querySelectorAll('*')) {
      if (SKIP_TEXT_TAGS.has(el.localName)) continue;
      if (el.textContent.length > wl.length * 4 + 40) continue; // cheap pre-filter
      if (lower(textOf(el)) !== wl) continue;
      if (!isVisible(el, hidden)) continue;
      best = el; // later in document order = deeper descendant of an earlier match
    }
    return best;
  }

  function findByText(text, role) {
    const modal = findModal();
    const scopes = modal ? [modal, null] : [null];
    for (const scope of scopes) {
      const pool = interactiveCandidates(scope);
      const m = matchByName(text, role, pool);
      if (m.length) return m[0];
    }
    if (!role) {
      for (const scope of scopes) {
        const el = matchPlainText(text, scope);
        if (el) return el;
      }
    }
    const pool = interactiveCandidates(modal);
    throw new Error('no element matches text ' + q(text) + (role ? ' role=' + role : '') + '; ' + closestList(text, role, pool));
  }

  function resolveLocator(loc) {
    if (loc.selector) {
      let list = null;
      try { list = doc.querySelectorAll(loc.selector); } catch { list = null; }
      if (list && list.length === 1 && lower(accName(list[0])) === lower(loc.name || '')) return list[0];
    }
    if (loc.role || loc.name) {
      const pool = interactiveCandidates(null);
      const want = lower(loc.name || '');
      const m = pool.filter((el) => (!loc.role || roleOf(el) === loc.role) && lower(accName(el)) === want);
      if (m.length) return m[Math.min(loc.nth || 0, m.length - 1)];
    }
    const pool = interactiveCandidates(findModal());
    throw new Error('no element matches locator selector=' + q(loc.selector || '') + ' role=' + (loc.role || '') +
      ' name=' + q(loc.name || '') + '; ' + closestList(loc.name || '', loc.role, pool));
  }

  function resolveTarget(a) {
    if (a.ref != null) {
      const ref = Number(a.ref);
      const el = elOfRef(ref);
      if (el === undefined) throw new Error('ref ' + a.ref + ' is unknown; take a new snapshot');
      if (!el || !el.isConnected) throw new Error('ref ' + a.ref + ' is stale (element removed); take a new snapshot');
      return el;
    }
    if (a.locator && typeof a.locator === 'object') return resolveLocator(a.locator);
    if (a.selector) {
      let list;
      try { list = Array.from(doc.querySelectorAll(a.selector)); } catch { throw new Error('invalid selector ' + q(a.selector)); }
      if (!list.length) throw new Error('no element matches selector ' + q(a.selector));
      const hidden = makeHiddenCache();
      return list.find((el) => isVisible(el, hidden)) || list[0];
    }
    if (a.text != null && a.text !== '') return findByText(String(a.text), a.role);
    if (a.role) {
      const m = interactiveCandidates(findModal()).filter((el) => roleOf(el) === a.role);
      if (m.length) return m[0];
      throw new Error('no element with role=' + a.role + '; ' + closestList('', a.role, interactiveCandidates(findModal())));
    }
    return null;
  }

  // ---------- locator generation ----------
  function looksGenerated(id) {
    return !id || id.length > 40 || /\d{3,}|[:.\s]|[0-9a-f]{8,}|^(ember|ext-|react|mui|radix|headlessui|rc[-_]|__|j_?id)/i.test(id) ||
      /^[a-z]{0,3}\d+$/i.test(id);
  }
  function uniqueFor(sel, el) {
    try { const l = doc.querySelectorAll(sel); return l.length === 1 && l[0] === el; } catch { return false; }
  }
  function anchorOf(el) {
    if (el.id && !looksGenerated(el.id)) return '#' + cssEscape(el.id);
    for (const a of ['data-testid', 'data-test']) {
      const v = el.getAttribute(a);
      if (v) return el.localName + '[' + a + '=' + attrVal(v) + ']';
    }
    return null;
  }
  function stableSelector(el) {
    const tag = el.localName;
    const cands = [];
    if (el.id && !looksGenerated(el.id)) cands.push('#' + cssEscape(el.id));
    for (const a of ['data-testid', 'data-test']) {
      const v = el.getAttribute(a);
      if (v) cands.push('[' + a + '=' + attrVal(v) + ']', tag + '[' + a + '=' + attrVal(v) + ']');
    }
    const nm = el.getAttribute('name');
    if (nm) {
      cands.push(tag + '[name=' + attrVal(nm) + ']');
      // [value=…] only for radio/checkbox (static option values). For typed inputs the attribute can mirror
      // what was typed (React syncs it), which would leak secrets into recordings and break replay.
      if (el.hasAttribute('value') && tag === 'input' && /^(radio|checkbox)$/.test(inputType(el))) cands.push(tag + '[name=' + attrVal(nm) + '][value=' + attrVal(el.getAttribute('value')) + ']');
    }
    const al = el.getAttribute('aria-label');
    if (al) cands.push(tag + '[aria-label=' + attrVal(al) + ']');
    for (const c of cands) if (uniqueFor(c, el)) return c;
    // structural path, anchored at the nearest stable ancestor
    const segs = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur !== el) {
        const anc = anchorOf(cur);
        if (anc && uniqueFor(anc, cur)) {
          const s = anc + ' > ' + segs.join(' > ');
          if (uniqueFor(s, el)) return s;
        }
      }
      let seg = cur.localName;
      const p = cur.parentElement;
      if (p) {
        const same = Array.from(p.children).filter((c) => c.localName === cur.localName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      segs.unshift(seg);
      const s = segs.join(' > ');
      if (uniqueFor(s, el)) return s;
      if (cur.localName === 'html') return s;
      cur = p;
    }
    return segs.join(' > ');
  }
  function locatorFor(el) {
    const role = roleOf(el);
    const name = accName(el);
    const loc = { selector: stableSelector(el), role, name };
    const same = interactiveCandidates(null).filter((c) => roleOf(c) === role && lower(accName(c)) === lower(name));
    if (same.length > 1) { const i = same.indexOf(el); if (i > 0) loc.nth = i; }
    if (el.localName === 'input' && inputType(el) === 'password') loc.password = true;
    return loc;
  }
  fb._locatorFor = locatorFor;

  // ---------- events ----------
  function center(el) {
    const r = fb._geom.rect(el);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function mouse(el, type, extra) {
    const { x, y } = center(el);
    const init = Object.assign({ bubbles: true, cancelable: true, composed: true, view: win, clientX: x, clientY: y, button: 0 }, extra || {});
    let ev;
    if (type.startsWith('pointer') && typeof win.PointerEvent === 'function') {
      ev = new win.PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, init));
    } else {
      ev = new win.MouseEvent(type, init);
    }
    return el.dispatchEvent(ev);
  }
  function scrollIntoView(el) {
    if (typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { /* ignore */ }
    }
  }
  function focusable(el) {
    return el.tabIndex >= 0 || /^(input|select|textarea|button|a)$/.test(el.localName) || isContentEditable(el);
  }
  function doFocus(el) {
    if (focusable(el) && typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch { el.focus(); } }
  }
  function click(el) {
    scrollIntoView(el);
    mouse(el, 'pointerover'); mouse(el, 'mouseover');
    const okDown = mouse(el, 'pointerdown', { buttons: 1 }) & mouse(el, 'mousedown', { buttons: 1 });
    if (okDown) doFocus(el);
    mouse(el, 'pointerup'); mouse(el, 'mouseup');
    mouse(el, 'click', { detail: 1 });
  }
  function fire(el, type, Ctor) {
    const C = (Ctor && win[Ctor]) || win.Event;
    el.dispatchEvent(new C(type, { bubbles: true, cancelable: type !== 'input' && type !== 'change' ? true : false, composed: true }));
  }
  function nativeSetValue(el, value) {
    const proto = el.localName === 'textarea' ? win.HTMLTextAreaElement.prototype
      : el.localName === 'select' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }
  function isFillable(el) {
    if (el.localName === 'textarea') return true;
    if (el.localName === 'input') return TEXT_INPUT_TYPES.has(inputType(el)) || inputType(el) === 'range';
    return isContentEditable(el);
  }
  function fill(el, value) {
    if (el.localName === 'select') return selectOption(el, value);
    if (!isFillable(el)) throw new Error('element ' + describe(el) + ' is not fillable (use click/check/select)');
    if (el.readOnly) throw new Error('element [' + refOf(el) + '] is read-only');
    scrollIntoView(el);
    doFocus(el);
    if (isContentEditable(el)) {
      let done = false;
      try {
        const sel = win.getSelection && win.getSelection();
        if (sel && doc.createRange) { const r = doc.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r); }
        if (typeof doc.execCommand === 'function') done = doc.execCommand('insertText', false, value) && norm(el.textContent) === norm(value);
      } catch { done = false; }
      if (!done) { el.textContent = value; fire(el, 'input', 'InputEvent'); }
      return;
    }
    try { if (typeof el.select === 'function') el.select(); } catch { /* some types can't select */ }
    nativeSetValue(el, value);
    fire(el, 'input', 'InputEvent');
    fire(el, 'change');
  }

  async function selectOption(el, value) {
    const v = String(value == null ? '' : value);
    if (el.localName === 'select') {
      const opts = Array.from(el.options);
      const opt = opts.find((o) => norm(o.label || o.text) === norm(v)) || opts.find((o) => o.value === v) ||
        opts.find((o) => lower(o.label || o.text) === lower(v));
      if (!opt) {
        throw new Error('option ' + q(v) + ' not found in ' + describe(el) + '; options: ' +
          opts.slice(0, 15).map((o) => q(norm(o.label || o.text))).join(', ') + (opts.length > 15 ? ', …' : ''));
      }
      doFocus(el);
      nativeSetValue(el, opt.value);
      opt.selected = true;
      fire(el, 'input', 'InputEvent');
      fire(el, 'change');
      return;
    }
    // custom combobox: open it (typing the value when it's a text field), then click the option
    if (isFillable(el)) { fill(el, v); } else { click(el); }
    await fb.waitStable({ quiet: Math.min(150, fb._timing.quiet), cap: Math.min(1500, fb._timing.cap) });
    let scope = null;
    const ctl = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (ctl) scope = doc.getElementById(ctl.split(/\s+/)[0]);
    const hidden = makeHiddenCache();
    const optSel = '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="treeitem"], [role="listbox"] li, li[data-value]';
    const pool = Array.from((scope || doc).querySelectorAll(optSel)).filter((o) => o !== el && isVisible(o, hidden));
    const want = norm(v), wl = want.toLowerCase();
    const named = pool.map((o) => ({ o, n: accName(o) }));
    const hit = named.find((x) => x.n === want) || named.find((x) => x.n.toLowerCase() === wl) ||
      (wl ? named.find((x) => x.n.toLowerCase().includes(wl)) : null);
    if (!hit) {
      throw new Error('option ' + q(v) + ' not found after opening ' + describe(el) + '; visible options: ' +
        (named.length ? named.slice(0, 10).map((x) => q(trunc(x.n, 40))).join(', ') : '(none)'));
    }
    click(hit.o);
  }

  function checkbox(el) {
    if (el.localName === 'label' && el.control) return el.control;
    return el;
  }
  function isChecked(el) {
    if (el.localName === 'input' && (inputType(el) === 'checkbox' || inputType(el) === 'radio')) return el.checked;
    const a = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed') ?? el.getAttribute('aria-selected');
    if (a != null) return a === 'true';
    throw new Error('element ' + describe(el) + ' is not a checkbox/radio/switch');
  }

  const KEYCODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ' ': 32, Space: 32, ArrowDown: 40, ArrowUp: 38,
    ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageDown: 34, PageUp: 33 };
  function parseKey(k) {
    let parts = String(k).split('+');
    if (k.endsWith('++')) parts = k.slice(0, -2).split('+').concat('+');
    const key0 = parts.pop() || '';
    const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    for (const m of parts) {
      const l = m.toLowerCase();
      if (l === 'control' || l === 'ctrl') mods.ctrlKey = true;
      else if (l === 'shift') mods.shiftKey = true;
      else if (l === 'alt' || l === 'option') mods.altKey = true;
      else if (l === 'meta' || l === 'cmd' || l === 'command') mods.metaKey = true;
    }
    const key = key0 === 'Space' ? ' ' : key0 === 'Esc' ? 'Escape' : key0;
    return { key, mods };
  }
  function keyEvent(el, type, key, mods) {
    let code = KEYCODES[key];
    if (code == null && key.length === 1) code = key.toUpperCase().charCodeAt(0);
    const ev = new win.KeyboardEvent(type, Object.assign({ key, bubbles: true, cancelable: true, composed: true, view: win,
      code: key.length === 1 && /[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : key }, mods));
    try {
      Object.defineProperty(ev, 'keyCode', { get: () => code || 0 });
      Object.defineProperty(ev, 'which', { get: () => code || 0 });
    } catch { /* ignore */ }
    return el.dispatchEvent(ev);
  }
  function tabbables() {
    const hidden = makeHiddenCache();
    return Array.from(doc.querySelectorAll('a[href], button, input, select, textarea, [tabindex], [contenteditable]'))
      .filter((e) => e.tabIndex >= 0 && !isDisabled(e) && !(e.localName === 'input' && inputType(e) === 'hidden') && isVisible(e, hidden));
  }
  // Selection-aware typing for press: replaces the selection (e.g. after Control+a), else inserts at the caret.
  // Inputs without a selection API (email, number…) fall back to appending / trimming at the end.
  function editText(el, key) {
    const v = String(el.value || '');
    let s = null, e = null;
    try { s = el.selectionStart; e = el.selectionEnd; } catch { s = e = null; }
    if (typeof s !== 'number' || typeof e !== 'number') { s = e = v.length; }
    let next, caret;
    if (key === 'Backspace' || key === 'Delete') {
      if (s !== e) { next = v.slice(0, s) + v.slice(e); caret = s; }
      else if (key === 'Backspace') { if (s === 0) return; next = v.slice(0, s - 1) + v.slice(s); caret = s - 1; }
      else { if (s >= v.length) return; next = v.slice(0, s) + v.slice(s + 1); caret = s; }
    } else {
      next = v.slice(0, s) + key + v.slice(e); caret = s + key.length;
    }
    nativeSetValue(el, next);
    try { el.setSelectionRange(caret, caret); } catch { /* type without selection API */ }
    fire(el, 'input', 'InputEvent');
  }
  function press(target, keySpec) {
    const { key, mods } = parseKey(keySpec);
    const el = target || doc.activeElement || doc.body;
    if (target) doFocus(target);
    const notPrevented = keyEvent(el, 'keydown', key, mods);
    const printable = key.length === 1 && !mods.ctrlKey && !mods.metaKey && !mods.altKey;
    if (notPrevented && (printable || key === 'Enter')) keyEvent(el, 'keypress', key, mods);
    if (notPrevented) {
      const tag = el.localName;
      if (key === 'Enter' && !mods.ctrlKey && !mods.altKey) {
        if (tag === 'input' && el.form && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(inputType(el))) {
          const form = el.form;
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
        } else if (tag === 'button' || tag === 'a' || tag === 'summary' || (tag === 'input' && ['button', 'submit', 'reset'].includes(inputType(el)))) {
          el.click();
        }
      } else if (key === 'Escape') {
        // Synthetic key events are untrusted, so a native modal <dialog> ignores them: emulate cancel + close.
        const dlg = (el.closest && el.closest('dialog[open]')) || Array.from(doc.querySelectorAll('dialog[open]')).pop();
        if (dlg && typeof dlg.close === 'function') {
          const ok = dlg.dispatchEvent(new win.Event('cancel', { cancelable: true }));
          if (ok && dlg.open) dlg.close();
        }
      } else if (key === 'Tab') {
        const list = tabbables();
        if (list.length) {
          const i = list.indexOf(el);
          const next = mods.shiftKey ? list[(i <= 0 ? list.length : i) - 1] : list[(i + 1) % list.length];
          doFocus(next);
        }
      } else if ((mods.ctrlKey || mods.metaKey) && key.toLowerCase() === 'a' && isFillable(el) && typeof el.select === 'function') {
        el.select();
      } else if ((printable || key === 'Backspace' || key === 'Delete') && isFillable(el) && !isContentEditable(el) && !el.readOnly) {
        editText(el, key);
      }
    }
    keyEvent(el, 'keyup', key, mods);
  }

  function hover(el) {
    scrollIntoView(el);
    mouse(el, 'pointerover'); mouse(el, 'mouseover');
    mouse(el, 'pointerenter', { bubbles: false }); mouse(el, 'mouseenter', { bubbles: false });
    mouse(el, 'pointermove'); mouse(el, 'mousemove');
  }

  function scrollableAncestor(el) {
    for (let p = el && el.parentElement; p; p = p.parentElement) {
      const cs = win.getComputedStyle(p);
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  }
  function scrollPage(dy) {
    const se = doc.scrollingElement || doc.documentElement;
    const docScrollable = se && se.scrollHeight > (win.innerHeight || se.clientHeight);
    if (!docScrollable) {
      // largest visible scroll container
      let best = null, area = 0;
      const hidden = makeHiddenCache();
      for (const e of doc.querySelectorAll('body *')) {
        if (e.scrollHeight <= e.clientHeight + 1) continue;
        const cs = win.getComputedStyle(e);
        if (!/(auto|scroll|overlay)/.test(cs.overflowY) || !isVisible(e, hidden)) continue;
        const a = e.clientWidth * e.clientHeight;
        if (a > area) { area = a; best = e; }
      }
      if (best) { best.scrollTop += dy; return; }
    }
    if (typeof win.scrollBy === 'function') { try { win.scrollBy(0, dy); } catch { /* jsdom */ } }
  }

  function pageText(el) {
    if (!el) return '';
    if (typeof el.innerText === 'string') return el.innerText;
    // fallback (no layout engine): block-aware text walk
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.data.replace(/[ \t\r\n\f]+/g, ' '); return; }
      if (n.nodeType !== 1) return;
      const tag = n.localName;
      if (SKIP_TEXT_TAGS.has(tag) || ownHidden(n)) return;
      if (tag === 'br') { out += '\n'; return; }
      if (tag === 'img') { const a = n.getAttribute('alt'); if (a) out += a; return; }
      const block = BLOCK_TAGS.has(tag);
      if (block) out += '\n';
      for (const c of n.childNodes) walk(c);
      if (tag === 'td' || tag === 'th') out += '\t';
      if (block) out += '\n';
    };
    walk(el);
    return out;
  }
  function collapseText(t) {
    return String(t).split('\n').map((l) => l.replace(/[ \t\f\v\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
  }

  async function waitFor(a) {
    const timeout = a.ms != null ? Number(a.ms) : 5000;
    const poll = fb._timing.poll;
    const start = Date.now();
    const check = () => {
      if (a.waitSelector) {
        let el;
        try { el = doc.querySelector(a.waitSelector); } catch { throw new Error('invalid selector ' + q(a.waitSelector)); }
        if (!el || !isVisible(el)) return false;
      }
      if (a.waitText) {
        if (!lower(pageText(doc.body)).includes(lower(a.waitText))) return false;
      }
      return true;
    };
    for (;;) {
      if (check()) return;
      if (Date.now() - start >= timeout) {
        const what = [a.waitText ? 'text ' + q(a.waitText) : '', a.waitSelector ? 'selector ' + q(a.waitSelector) : ''].filter(Boolean).join(' and ');
        throw new Error('timed out after ' + timeout + 'ms waiting for ' + what);
      }
      await sleep(poll);
    }
  }

  // ---------- step ----------
  const NEEDS_TARGET = new Set(['click', 'fill', 'select', 'check', 'hover']);
  async function runStep(a) {
    const kind = a && a.do;
    if (!kind) throw new Error('action needs "do"');
    if (kind === 'navigate') {
      if (!a.url) throw new Error('navigate needs url');
      win.location.href = a.url;
      return {};
    }
    if (kind === 'wait') {
      if (a.waitText || a.waitSelector) await waitFor(a);
      else await sleep(a.ms != null ? Number(a.ms) : 1000);
      return {};
    }
    const hasTarget = a.ref != null || a.locator || a.selector || (a.text != null && a.text !== '') || (a.role && NEEDS_TARGET.has(kind));
    let el = hasTarget ? resolveTarget(a) : null;
    if (NEEDS_TARGET.has(kind) && !el) throw new Error(kind + ' needs a target (ref, text, selector or locator)');
    if (kind === 'check' && el) el = checkbox(el);
    // Build the locator BEFORE acting: the action may rename the target ("Show more" → "Show less"), change a
    // combobox's displayed value, or remove it — a post-action locator would not match on replay.
    const locator = el ? locatorFor(el) : null;
    switch (kind) {
      case 'click':
        if (isDisabled(el)) throw new Error('element [' + refOf(el) + '] is disabled');
        click(el);
        break;
      case 'fill':
        if (isDisabled(el)) throw new Error('element [' + refOf(el) + '] is disabled');
        if (a.value == null) throw new Error('fill needs value');
        await fill(el, String(a.value));
        break;
      case 'select':
        if (isDisabled(el)) throw new Error('element [' + refOf(el) + '] is disabled');
        if (a.value == null) throw new Error('select needs value');
        await selectOption(el, String(a.value));
        break;
      case 'check': {
        if (isDisabled(el)) throw new Error('element [' + refOf(el) + '] is disabled');
        const want = a.checked !== false;
        if (isChecked(el) !== want) {
          if (!want && el.localName === 'input' && inputType(el) === 'radio') throw new Error('cannot uncheck radio ' + describe(el) + '; check another option instead');
          click(el);
          // Frameworks may commit the new state after the event returns (React 18 microtask, Vue nextTick):
          // give them a short settle before declaring failure.
          const t0 = Date.now();
          while (isChecked(el) !== want && Date.now() - t0 < (fb._timing.checkSettle ?? 500)) {
            await Promise.resolve();
            await sleep(25);
          }
          if (isChecked(el) !== want) throw new Error('clicking ' + describe(el) + ' did not change its checked state');
        }
        break;
      }
      case 'press':
        if (!a.key) throw new Error('press needs key');
        press(el, String(a.key));
        break;
      case 'hover':
        hover(el);
        break;
      case 'scroll':
        if (el) scrollIntoView(el);
        else {
          const amt = a.amount != null ? Number(a.amount) : fb._geom.viewportHeight();
          scrollPage(a.direction === 'up' ? -amt : amt);
        }
        break;
      default:
        throw new Error('unknown action do=' + q(kind));
    }
    return locator ? { locator } : {};
  }

  fb.step = async function step(action) {
    try {
      const r = await runStep(action || {});
      const out = { ok: true };
      if (r.locator) out.locator = r.locator;
      return out;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };

  // ---------- DOM-stable wait ----------
  fb.waitStable = function waitStable(opts) {
    const quiet = (opts && opts.quiet) != null ? opts.quiet : fb._timing.quiet;
    const cap = (opts && opts.cap) != null ? opts.cap : fb._timing.cap;
    return new Promise((resolve) => {
      const start = Date.now();
      let timer = null, obs = null, finished = false;
      const done = (stable) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); clearTimeout(capTimer);
        if (obs) obs.disconnect();
        resolve({ stable, ms: Date.now() - start });
      };
      const capTimer = setTimeout(() => done(false), cap);
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => (doc.readyState === 'loading' ? arm() : done(true)), quiet);
      };
      try {
        obs = new win.MutationObserver(arm);
        obs.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch { obs = null; }
      arm();
    });
  };

  // ---------- extract ----------
  function cellText(c) {
    return collapseText(pageText(c)).replace(/\n/g, ' ').replace(/\|/g, '\\|');
  }
  function tableToMd(t) {
    const rows = [];
    let headerRow = false;
    if (t.localName === 'table') {
      const trs = Array.from(t.rows || t.querySelectorAll('tr')).filter((tr) => tr.closest('table') === t);
      for (const tr of trs) {
        const cells = [];
        for (const c of tr.cells) {
          const txt = cellText(c);
          const span = Math.max(1, Math.min(20, parseInt(c.getAttribute('colspan') || '1', 10) || 1));
          cells.push(txt);
          for (let k = 1; k < span; k++) cells.push('');
        }
        rows.push(cells);
      }
      const first = trs[0];
      headerRow = !!first && (first.parentElement.localName === 'thead' || Array.from(first.cells).every((c) => c.localName === 'th'));
    } else {
      for (const r of t.querySelectorAll('[role="row"]')) {
        const cells = Array.from(r.querySelectorAll('[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]'));
        rows.push(cells.map(cellText));
      }
      const first = t.querySelector('[role="row"]');
      headerRow = !!first && !!first.querySelector('[role="columnheader"]');
    }
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length), 1);
    const pad = (r) => r.concat(Array(width - r.length).fill(''));
    const line = (r) => '| ' + pad(r).join(' | ') + ' |';
    const out = [];
    let body = rows;
    if (headerRow) { out.push(line(rows[0])); body = rows.slice(1); } else out.push(line(Array(width).fill('')));
    out.push('|' + Array(width).fill(' --- ').join('|') + '|');
    for (const r of body) out.push(line(r));
    const cap = t.localName === 'table' && t.caption ? norm(t.caption.textContent) : norm(t.getAttribute('aria-label'));
    return (cap ? '### ' + cap + '\n' : '') + out.join('\n');
  }

  function extractText(opts) {
    const kind = (opts && opts.kind) || 'text';
    const maxChars = opts && opts.maxChars > 0 ? Math.floor(opts.maxChars) : 8000;
    let root = null;
    if (opts && opts.region) {
      try { root = doc.querySelector(opts.region); } catch { throw new Error('invalid region selector ' + q(opts.region)); }
      if (!root) throw new Error('region ' + q(opts.region) + ' not found');
    }
    let text;
    if (kind === 'text') {
      const r = root || doc.querySelector('main, [role="main"]') || doc.body;
      text = collapseText(pageText(r));
    } else if (kind === 'table') {
      const r = root || doc.body;
      const hidden = makeHiddenCache();
      const tables = Array.from(r.querySelectorAll('table, [role="table"], [role="grid"]'));
      if (r.matches && r.matches('table, [role="table"], [role="grid"]')) tables.unshift(r);
      text = tables.filter((t) => isVisible(t, hidden)).map(tableToMd).filter(Boolean).join('\n\n');
      if (!text) text = '(no tables)';
    } else if (kind === 'links') {
      const r = root || doc.body;
      const hidden = makeHiddenCache();
      const seen = new Set();
      const lines = [];
      for (const a of r.querySelectorAll('a[href]')) {
        const href = a.href;
        if (!href || /^javascript:/i.test(href) || !isVisible(a, hidden)) continue;
        const l = '- [' + (accName(a) || href).replace(/[[\]]/g, '\\$&') + '](' + href + ')';
        if (seen.has(l)) continue;
        seen.add(l);
        lines.push(l);
      }
      text = lines.join('\n') || '(no links)';
    } else {
      throw new Error('unknown extract kind ' + q(kind));
    }
    const truncated = text.length > maxChars;
    return { text: truncated ? text.slice(0, maxChars) : text, truncated };
  }
  fb.extract = function extract(opts) {
    try {
      return extractText(opts || {});
    } catch (e) {
      return { text: '', truncated: false, error: String((e && e.message) || e) };
    }
  };

  // ---------- test hook ----------
  fb.resetForTests = function resetForTests() {
    fb._refs = new WeakMap();
    fb._byRef = new Map();
    fb._counter = 0;
    fb._baseline = null;
    fb._timing = { quiet: 300, cap: 2500, poll: 100, checkSettle: 500 };
  };

  // exposed for tests / debugging
  fb._accName = accName;
  fb._roleOf = roleOf;

  globalThis.__fb = fb;
})();
