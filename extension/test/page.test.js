import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const SRC = readFileSync(new URL('../page.js', import.meta.url), 'utf8');

// jsdom has no layout: stub the geometry helper. data-nobox → zero box, data-offscreen → outside viewport.
function load(html, { url = 'https://app.test/page', title = 'Test Page' } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>${title}</title></head><body>${html}</body></html>`, {
    url,
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(), // silence "not implemented" noise
  });
  dom.window.eval(SRC);
  const fb = dom.window.__fb;
  fb._geom.rect = () => ({ left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 });
  fb._geom.hasBox = (el) => !el.closest('[data-nobox]');
  fb._geom.inViewport = (el) => !el.closest('[data-offscreen]');
  fb._timing = { quiet: 20, cap: 300, poll: 10 };
  return { dom, w: dom.window, d: dom.window.document, fb };
}
const snap = (fb, opts) => {
  const r = fb.snapshot(opts);
  assert.equal(r.error, undefined, r.error);
  return r.text;
};
const lines = (t) => t.split('\n');
const json = (v) => JSON.parse(JSON.stringify(v));
// page objects come from the jsdom realm (different Object prototype) → compare as plain JSON
const deq = (actual, expected, msg) => assert.deepEqual(json(actual), expected, msg);

describe('injection', () => {
  test('re-injecting into the same document is a no-op', () => {
    const { w, fb } = load('<button>A</button>');
    snap(fb);
    const counter = fb._counter;
    w.eval(SRC);
    assert.equal(w.__fb, fb);
    assert.equal(w.__fb._counter, counter);
  });
});

describe('snapshot', () => {
  const PAGE = `
    <h1>Login</h1>
    <form>
      <label for="em">Email</label><input id="em" type="email" value="a@b.c" required>
      <label>Password <input type="password" value="secret"></label>
      <input placeholder="Search here">
      <span id="lbl">Labelled by</span><input aria-labelledby="lbl">
      <button aria-label="Close dialog">X</button>
      <a href="/home"><img alt="Home icon"></a>
      <button title="Only title"></button>
      <label><input type="checkbox" checked> Remember me</label>
      <select name="st"><option>Open</option><option selected>Closed</option></select>
      <button disabled>Submit</button>
      <div role="button" aria-expanded="false">Menu</div>
      <div role="button" aria-expanded="true">Open menu</div>
      <textarea>${'x'.repeat(100)}</textarea>
      <button>${'n'.repeat(120)}</button>
    </form>
    <h2>Empty section</h2>
    <h2>Hidden stuff</h2>
    <button style="display:none">dn</button>
    <div style="display:none"><button>dn2</button></div>
    <button style="visibility:hidden">vh</button>
    <button aria-hidden="true">ah</button>
    <button hidden>hid</button>
    <button data-nobox>nobox</button>
    <input type="hidden" name="tok">
    <div onclick="1">Clickable div</div>
    <span tabindex="0">Focusable span</span>
    <span tabindex="-1">Not listed</span>
    <a>No href</a>
    <div contenteditable="true">Editor text</div>
    <details><summary>More</summary><button>inside closed details</button></details>
    <button data-offscreen>Far below</button>`;

  test('header, headings, roles, names and states', () => {
    const { fb, d } = load(PAGE);
    d.querySelector('[placeholder]').focus();
    const t = snap(fb);
    const L = lines(t);
    assert.equal(L[0], 'Test Page');
    assert.equal(L[1], 'https://app.test/page');
    assert.equal(L[2], 'scroll 0%');
    assert.equal(L[3], '');
    assert.equal(L[4], '— Login');
    assert.match(t, /\[1\] textbox "Email" value="a@b\.c" required\n/);
    assert.match(t, /\[\d+\] textbox "Password" value="••••"\n/);
    assert.ok(!t.includes('secret'));
    assert.match(t, /\[\d+\] textbox "Search here" focused\n/);
    assert.match(t, /\[\d+\] textbox "Labelled by"\n/);
    assert.match(t, /\[\d+\] button "Close dialog"\n/);
    assert.match(t, /\[\d+\] link "Home icon"\n/);
    assert.match(t, /\[\d+\] button "Only title"\n/);
    assert.match(t, /\[\d+\] checkbox "Remember me" checked\n/);
    assert.match(t, /\[\d+\] combobox "" selected="Closed"\n/);
    assert.match(t, /\[\d+\] button "Submit" disabled\n/);
    assert.match(t, /\[\d+\] button "Menu" collapsed\n/);
    assert.match(t, /\[\d+\] button "Open menu" expanded\n/);
    assert.match(t, new RegExp(`textbox "" value="${'x'.repeat(59)}…"`));
    assert.match(t, new RegExp(`button "${'n'.repeat(79)}…"`));
    assert.match(t, /\[\d+\] clickable "Clickable div"\n/);
    assert.match(t, /\[\d+\] clickable "Focusable span"\n/);
    assert.match(t, /\[\d+\] textbox "" value="Editor text"\n/);
    assert.match(t, /\[\d+\] button "More" collapsed/);
    // headings only when followed by listed items
    assert.ok(!t.includes('Empty section'));
    assert.match(t, /— Hidden stuff\n\[\d+\] clickable "Clickable div"/);
    for (const hidden of ['dn', 'dn2', 'vh', 'ah', 'hid', 'nobox', 'Not listed', 'No href', 'inside closed details', 'Far below']) {
      assert.ok(!t.includes(`"${hidden}"`), `should not list ${hidden}`);
    }
    assert.ok(!t.includes('tok'));
  });

  test('full mode includes elements outside the viewport', () => {
    const { fb } = load(PAGE);
    assert.ok(!snap(fb).includes('Far below'));
    assert.match(snap(fb, { mode: 'full' }), /button "Far below"/);
  });

  test('refs are stable across snapshots and DOM changes', () => {
    const { fb, d } = load('<button id="a">A</button><button id="b">B</button>');
    const t1 = snap(fb);
    assert.match(t1, /\[1\] button "A"/);
    assert.match(t1, /\[2\] button "B"/);
    const n = d.createElement('button');
    n.textContent = 'New';
    d.body.prepend(n);
    const t2 = snap(fb);
    assert.match(t2, /\[1\] button "A"/);
    assert.match(t2, /\[2\] button "B"/);
    assert.match(t2, /\[3\] button "New"/);
    assert.ok(t2.indexOf('"New"') < t2.indexOf('"A"'), 'document order');
  });

  test('modal: only the modal subtree is listed', () => {
    const { fb } = load(`<button>Behind</button>
      <div role="dialog" aria-modal="true"><h2>Confirm</h2><button>OK</button><button>Cancel</button></div>
      <dialog><button>closed dialog btn</button></dialog>`);
    const t = snap(fb);
    assert.match(t, /\nscroll 0%\n\[modal\]\n\n— Confirm\n\[\d+\] button "OK"\n\[\d+\] button "Cancel"$/);
    assert.ok(!t.includes('Behind'));
    assert.ok(!t.includes('closed dialog btn'));
  });

  test('topmost (last) visible modal wins, hidden modal ignored', () => {
    const { fb } = load(`<dialog open><button>First</button></dialog>
      <div role="alertdialog"><button>Second</button></div>
      <div role="dialog" style="display:none"><button>Hidden</button></div>`);
    const t = snap(fb);
    assert.match(t, /button "Second"/);
    assert.ok(!t.includes('First'));
  });

  test('region limits the listing; bad region → error', () => {
    const { fb } = load('<div id="r"><button>In</button></div><button>Out</button>');
    const t = snap(fb, { region: '#r' });
    assert.match(t, /button "In"/);
    assert.ok(!t.includes('Out'));
    assert.match(fb.snapshot({ region: '#nope' }).error, /region "#nope" not found/);
  });

  test('diff: + new, ~ changed, - gone, (no changes)', () => {
    const { fb, d } = load('<button id="a">A</button><button id="b">B</button><input id="c">');
    const first = snap(fb, { mode: 'diff' });
    assert.ok(first.startsWith('(new page)\nTest Page\n'));
    assert.equal(snap(fb, { mode: 'diff' }), '(no changes)');
    d.getElementById('b').remove();
    d.getElementById('c').value = 'typed';
    const nb = d.createElement('button');
    nb.textContent = 'Added';
    d.body.append(nb);
    const t = snap(fb, { mode: 'diff' });
    deq(lines(t), ['~ [3] textbox "" value="typed"', '+ [4] button "Added"', '- [2] button "B"']);
    assert.equal(snap(fb, { mode: 'diff' }), '(no changes)');
  });

  test('diff: scrolled-out elements are not reported as gone', () => {
    const { fb, d } = load('<button id="a">A</button><button id="b">B</button>');
    snap(fb);
    d.getElementById('b').setAttribute('data-offscreen', '');
    assert.equal(snap(fb, { mode: 'diff' }), '(no changes)');
  });

  test('diff: header re-sent when title or url changes; modal open noted', () => {
    const { fb, d } = load('<button>A</button>');
    snap(fb);
    d.title = 'Other';
    const t = snap(fb, { mode: 'diff' });
    deq(lines(t), ['Other', 'https://app.test/page', 'scroll 0%', '', '(no changes)']);
    const m = d.createElement('div');
    m.setAttribute('role', 'dialog');
    m.innerHTML = '<button>OK</button>';
    d.body.append(m);
    const t2 = snap(fb, { mode: 'diff' });
    deq(lines(t2), ['[modal]', '', '+ [2] button "OK"']);
  });

  test('results are JSON-serialisable', () => {
    const { fb } = load('<button>A</button>');
    const r = fb.snapshot({ mode: 'full' });
    deq(r, { text: r.text });
    assert.equal(typeof r.text, "string");
  });
});

describe('target resolution and errors', () => {
  test('text: exact match beats contains; role filter', () => {
    const { fb, d } = load('<button>Lưu lại</button><button>Lưu</button><a href="#">Lưu</a>');
    snap(fb);
    let hit = null;
    d.querySelectorAll('button,a').forEach((e) => e.addEventListener('click', (ev) => { hit = e; ev.preventDefault(); }));
    return (async () => {
      let r = await fb.step({ do: 'click', text: 'Lưu' });
      assert.equal(r.ok, true);
      assert.equal(hit.textContent, 'Lưu');
      assert.equal(hit.localName, 'button');
      r = await fb.step({ do: 'click', text: 'lưu', role: 'link' });
      assert.equal(r.ok, true);
      assert.equal(hit.localName, 'a');
      r = await fb.step({ do: 'click', text: 'lại' });
      assert.equal(r.ok, true);
      assert.equal(hit.textContent, 'Lưu lại');
    })();
  });

  test('no match → message lists closest candidates with refs', async () => {
    const { fb } = load('<button>Lưu lại</button><button>Lưu nháp</button><button>Xoá</button><a href="/x">Trang chủ</a>');
    const t = snap(fb);
    assert.match(t, /\[1\] button "Lưu lại"/);
    const r = await fb.step({ do: 'click', text: 'Lưu bản', role: 'button' });
    assert.equal(r.ok, false);
    assert.match(r.error, /^no element matches text "Lưu bản" role=button; closest: \[1\] button "Lưu lại", \[2\] button "Lưu nháp"/);
  });

  test('plain text fallback clicks non-semantic element', async () => {
    const { fb, d } = load('<div class="card"><span>Open details</span></div>');
    let clicked = false;
    d.querySelector('.card').addEventListener('click', () => { clicked = true; });
    const r = await fb.step({ do: 'click', text: 'Open details' });
    assert.equal(r.ok, true, r.error);
    assert.ok(clicked);
  });

  test('stale / unknown ref, missing selector, missing target', async () => {
    const { fb, d } = load('<button id="x">X</button>');
    snap(fb);
    d.getElementById('x').remove();
    assert.equal((await fb.step({ do: 'click', ref: 1 })).error, 'ref 1 is stale (element removed); take a new snapshot');
    assert.equal((await fb.step({ do: 'click', ref: 99 })).error, 'ref 99 is unknown; take a new snapshot');
    assert.equal((await fb.step({ do: 'click', selector: '#nope' })).error, 'no element matches selector "#nope"');
    assert.match((await fb.step({ do: 'click', selector: '##' })).error, /invalid selector/);
    assert.match((await fb.step({ do: 'click' })).error, /click needs a target/);
    assert.match((await fb.step({ do: 'fly', ref: 1 })).error, /unknown action|stale/);
    assert.match((await fb.step({ do: 'fly' })).error, /unknown action do="fly"/);
  });

  test('disabled element → error', async () => {
    const { fb } = load('<button>A</button><button disabled>Save</button><div role="button" aria-disabled="true">Ar</div>');
    snap(fb);
    assert.equal((await fb.step({ do: 'click', ref: 2 })).error, 'element [2] is disabled');
    assert.equal((await fb.step({ do: 'click', text: 'Ar' })).error, 'element [3] is disabled');
  });

  test('text search is scoped to an open modal first', async () => {
    const { fb, d } = load('<button>OK</button><div role="dialog"><button>OK</button></div>');
    let which = null;
    d.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => { which = i; }));
    const r = await fb.step({ do: 'click', text: 'OK' });
    assert.equal(r.ok, true);
    assert.equal(which, 1);
  });
});

describe('actions', () => {
  test('click dispatches the pointer/mouse sequence, focuses, returns locator', async () => {
    const { fb, d } = load('<button id="save">Save</button>');
    const seen = [];
    const b = d.getElementById('save');
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) b.addEventListener(t, (e) => seen.push(e.type + ':' + e.clientX));
    const r = await fb.step({ do: 'click', text: 'Save' });
    deq(r, { ok: true, locator: { selector: '#save', role: 'button', name: 'Save' } });
    deq(seen, ['pointerdown:50', 'mousedown:50', 'pointerup:50', 'mouseup:50', 'click:50']);
    assert.equal(d.activeElement, b);
  });

  test('click on checkbox toggles via activation behaviour', async () => {
    const { fb, d } = load('<label><input type="checkbox" id="c"> Agree</label>');
    await fb.step({ do: 'click', text: 'Agree', role: 'checkbox' });
    assert.equal(d.getElementById('c').checked, true);
  });

  test('fill uses the native value setter and fires input + change (React-style)', async () => {
    const { fb, d, w } = load('<label>Name <input id="n" value="old"></label><textarea aria-label="Bio"></textarea>');
    const n = d.getElementById('n');
    // Simulate React's instance-level value tracker override: own-property setter must be bypassed.
    let ownSetterCalls = 0;
    Object.defineProperty(n, 'value', {
      configurable: true,
      get() { return Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').get.call(this); },
      set(v) { ownSetterCalls++; Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(this, v); },
    });
    const events = [];
    n.addEventListener('input', (e) => events.push('input:' + e.target.value));
    n.addEventListener('change', () => events.push('change'));
    const r = await fb.step({ do: 'fill', text: 'Name', value: 'Phương' });
    assert.equal(r.ok, true, r.error);
    assert.equal(n.value, 'Phương');
    assert.equal(ownSetterCalls, 0);
    deq(events, ['input:Phương', 'change']);
    assert.equal((await fb.step({ do: 'fill', text: 'Bio', value: 'hi' })).ok, true);
    assert.equal(d.querySelector('textarea').value, 'hi');
  });

  test('fill contenteditable falls back to textContent; non-fillable → error', async () => {
    const { fb, d } = load('<div contenteditable="true" aria-label="Editor">old</div><button>B</button><input aria-label="RO" readonly>');
    let inputs = 0;
    d.querySelector('[contenteditable]').addEventListener('input', () => inputs++);
    assert.equal((await fb.step({ do: 'fill', text: 'Editor', value: 'new text' })).ok, true);
    assert.equal(d.querySelector('[contenteditable]').textContent, 'new text');
    assert.equal(inputs, 1);
    assert.match((await fb.step({ do: 'fill', text: 'B', value: 'x' })).error, /is not fillable/);
    assert.match((await fb.step({ do: 'fill', text: 'RO', value: 'x' })).error, /is read-only/);
  });

  test('fill password → locator flagged as password', async () => {
    const { fb } = load('<input type="password" name="pw" aria-label="Password">');
    const r = await fb.step({ do: 'fill', text: 'Password', value: 'hunter2' });
    assert.equal(r.ok, true);
    deq(r.locator, { selector: 'input[name="pw"]', role: 'textbox', name: 'Password', password: true });
    assert.ok(!JSON.stringify(r).includes('hunter2'));
  });

  test('select native by label, by value; unknown option lists options', async () => {
    const { fb, d } = load(`<label>Trạng thái <select id="s"><option value="o">Mở</option><option value="c">Đóng</option></select></label>`);
    const s = d.getElementById('s');
    let changes = 0;
    s.addEventListener('change', () => changes++);
    assert.equal((await fb.step({ do: 'select', text: 'Trạng thái', value: 'Đóng' })).ok, true);
    assert.equal(s.value, 'c');
    assert.equal((await fb.step({ do: 'select', text: 'Trạng thái', value: 'o' })).ok, true);
    assert.equal(s.value, 'o');
    assert.equal(changes, 2);
    const r = await fb.step({ do: 'select', text: 'Trạng thái', value: 'Huỷ' });
    assert.match(r.error, /^option "Huỷ" not found in \[1\] combobox "Trạng thái"; options: "Mở", "Đóng"$/);
    assert.match(snap(fb), /combobox "Trạng thái" selected="Mở"/);
  });

  test('select on a custom combobox: open, then click option by name', async () => {
    const { fb, d } = load(`<div role="combobox" aria-label="Country" aria-controls="lb" tabindex="0">Pick</div>
      <ul role="listbox" id="lb" hidden><li role="option">Vietnam</li><li role="option">Denmark</li></ul>`);
    const cb = d.querySelector('[role=combobox]');
    const lb = d.getElementById('lb');
    cb.addEventListener('click', () => { lb.hidden = false; });
    lb.addEventListener('click', (e) => { cb.textContent = e.target.textContent; lb.hidden = true; });
    const r = await fb.step({ do: 'select', text: 'Country', value: 'denmark' });
    assert.equal(r.ok, true, r.error);
    assert.equal(cb.textContent, 'Denmark');
    assert.equal(r.locator.role, 'combobox');
    const bad = await fb.step({ do: 'select', text: 'Country', value: 'Mars' });
    assert.match(bad.error, /^option "Mars" not found after opening \[\d+\] combobox "Country"; visible options: "Vietnam", "Denmark"$/);
  });

  test('check: only clicks when state differs; aria switch; radio uncheck error', async () => {
    const { fb, d } = load(`<label><input type="checkbox" id="c"> Agree</label>
      <div role="switch" aria-checked="false" aria-label="Dark mode" tabindex="0"></div>
      <label><input type="radio" name="r" id="r1" checked> One</label>`);
    const c = d.getElementById('c');
    let clicks = 0;
    c.addEventListener('click', () => clicks++);
    const sw = d.querySelector('[role=switch]');
    sw.addEventListener('click', () => sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true')));
    assert.equal((await fb.step({ do: 'check', text: 'Agree' })).ok, true);
    assert.equal((await fb.step({ do: 'check', text: 'Agree', checked: true })).ok, true);
    assert.equal(clicks, 1);
    assert.equal(c.checked, true);
    assert.equal((await fb.step({ do: 'check', text: 'Agree', checked: false })).ok, true);
    assert.equal(c.checked, false);
    assert.equal((await fb.step({ do: 'check', text: 'Dark mode' })).ok, true);
    assert.equal(sw.getAttribute('aria-checked'), 'true');
    assert.match((await fb.step({ do: 'check', text: 'One', checked: false })).error, /cannot uncheck radio/);
  });

  test('press Enter in a form input submits the form; keys reach handlers', async () => {
    const { fb, d } = load('<form id="f"><input aria-label="Q"><button>Go</button></form>');
    let submitted = 0;
    const keys = [];
    d.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); submitted++; });
    d.querySelector('input').addEventListener('keydown', (e) => keys.push(e.key + ':' + e.keyCode + ':' + e.ctrlKey));
    assert.equal((await fb.step({ do: 'press', text: 'Q', key: 'Enter' })).ok, true);
    assert.equal(submitted, 1);
    assert.equal((await fb.step({ do: 'press', key: 'Control+a' })).ok, true); // activeElement = the input
    deq(keys, ['Enter:13:false', 'a:65:true']);
  });

  test('press Enter prevented by handler does not submit; Tab moves focus; typing a char', async () => {
    const { fb, d } = load('<form id="f"><input id="a" aria-label="A"><input id="b" aria-label="B"></form>');
    let submitted = 0;
    d.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); submitted++; });
    d.getElementById('a').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    await fb.step({ do: 'press', text: 'A', key: 'Enter' });
    assert.equal(submitted, 0);
    await fb.step({ do: 'press', key: 'Tab' });
    assert.equal(d.activeElement.id, 'b');
    await fb.step({ do: 'press', key: 'x' });
    assert.equal(d.getElementById('b').value, 'x');
  });

  test('hover dispatches over/enter/move', async () => {
    const { fb, d } = load('<button>Tip</button>');
    const seen = [];
    for (const t of ['mouseover', 'mouseenter', 'mousemove']) d.querySelector('button').addEventListener(t, () => seen.push(t));
    assert.equal((await fb.step({ do: 'hover', text: 'Tip' })).ok, true);
    deq(seen, ['mouseover', 'mouseenter', 'mousemove']);
  });

  test('scroll with and without target', async () => {
    const { fb, d } = load('<button>Far</button>');
    let into = null;
    d.querySelector('button').scrollIntoView = (o) => { into = o; };
    assert.equal((await fb.step({ do: 'scroll', text: 'Far' })).ok, true);
    deq(into, { block: 'center', inline: 'nearest' });
    assert.equal((await fb.step({ do: 'scroll', direction: 'down', amount: 300 })).ok, true);
  });

  test('wait for text / selector, timeout error, plain ms', async () => {
    const { fb, d, w } = load('<div id="out"></div>');
    w.setTimeout(() => { d.getElementById('out').innerHTML = '<p class="done">Đã lưu</p>'; }, 40);
    assert.equal((await fb.step({ do: 'wait', waitText: 'đã lưu', ms: 1000 })).ok, true);
    assert.equal((await fb.step({ do: 'wait', waitSelector: '.done', ms: 1000 })).ok, true);
    const r = await fb.step({ do: 'wait', waitText: 'never', ms: 50 });
    assert.equal(r.error, 'timed out after 50ms waiting for text "never"');
    const t0 = Date.now();
    assert.equal((await fb.step({ do: 'wait', ms: 30 })).ok, true);
    assert.ok(Date.now() - t0 >= 25);
  });

  test('navigate (page-side fallback) to a hash url', async () => {
    const { fb, w } = load('<p>x</p>');
    assert.equal((await fb.step({ do: 'navigate', url: '#sec' })).ok, true);
    assert.equal(w.location.hash, '#sec');
  });
});

describe('locators', () => {
  test('selector preference: stable id, testid, name, aria-label, structural; generated ids skipped', () => {
    const { fb, d } = load(`
      <button id="save-btn">Save</button>
      <button id=":r1:" data-testid="del">Delete</button>
      <input id="input-12345" name="email" aria-label="Email">
      <button id="mui-123" aria-label="Close">x</button>
      <div><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul></div>`);
    const loc = (sel) => fb._locatorFor(d.querySelector(sel));
    assert.equal(loc('#save-btn').selector, '#save-btn');
    assert.equal(loc('[data-testid=del]').selector, '[data-testid="del"]');
    assert.equal(loc('[name=email]').selector, 'input[name="email"]');
    assert.equal(loc('[aria-label=Close]').selector, 'button[aria-label="Close"]');
    const s = loc('a[href="/b"]').selector;
    assert.equal(d.querySelectorAll(s).length, 1);
    assert.equal(d.querySelector(s).getAttribute('href'), '/b');
    assert.match(s, /li:nth-of-type\(2\)/);
  });

  test('nth recorded for duplicate role+name; radio name+value selector', () => {
    const { fb, d } = load(`<ul><li><button>Edit</button></li><li><button>Edit</button></li></ul>
      <input type="radio" name="size" value="s" aria-label="S"><input type="radio" name="size" value="m" aria-label="M">`);
    const b = d.querySelectorAll('button');
    assert.equal(fb._locatorFor(b[0]).nth, undefined);
    assert.equal(fb._locatorFor(b[1]).nth, 1);
    assert.equal(fb._locatorFor(d.querySelector('[value=m]')).selector, 'input[name="size"][value="m"]');
  });

  test('replay: selector + name match → that element', async () => {
    const { fb, d } = load('<button id="go">Go</button><button>Go</button>');
    let hit = null;
    d.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => { hit = i; }));
    const r = await fb.step({ do: 'click', locator: { selector: '#go', role: 'button', name: 'go' } });
    assert.equal(r.ok, true);
    assert.equal(hit, 0);
  });

  test('replay: selector broken → role+name fallback (with nth); nothing → error', async () => {
    const { fb, d } = load('<button class="new">Edit</button><button class="new">Edit</button><button>Save draft</button>');
    let hit = null;
    d.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => { hit = i; }));
    let r = await fb.step({ do: 'click', locator: { selector: '#old-id', role: 'button', name: 'Edit', nth: 1 } });
    assert.equal(r.ok, true, r.error);
    assert.equal(hit, 1);
    // selector matches one element but its name differs → fallback by role+name
    r = await fb.step({ do: 'click', locator: { selector: 'button:not(.new)', role: 'button', name: 'Edit' } });
    assert.equal(r.ok, true);
    assert.equal(hit, 0);
    r = await fb.step({ do: 'click', locator: { selector: '#gone', role: 'button', name: 'Save' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /^no element matches locator selector="#gone" role=button name="Save"; closest: \[\d+\] button "Save draft"/);
  });

  test('generated locator round-trips through replay', async () => {
    const { fb, d } = load('<form><label>City <input name="city"></label></form>');
    const r1 = await fb.step({ do: 'fill', text: 'City', value: 'Hà Nội' });
    d.querySelector('input').value = '';
    const r2 = await fb.step({ do: 'fill', locator: r1.locator, value: 'Huế' });
    assert.equal(r2.ok, true);
    assert.equal(d.querySelector('input').value, 'Huế');
    deq(r2, { ok: true, locator: { selector: 'input[name="city"]', role: 'textbox', name: 'City' } });
  });
});

describe('extract', () => {
  test('text from main, whitespace collapsed, truncation', () => {
    const { fb } = load('<nav>menu</nav><main><h1>Title</h1>\n\n<p>Hello    <b>world</b></p><p style="display:none">secret</p></main>');
    const r = fb.extract({ kind: 'text' });
    deq(r, { text: 'Title\nHello world', truncated: false });
    deq(fb.extract({ maxChars: 5 }), { text: 'Title', truncated: true });
  });

  test('text with region; bad region → error', () => {
    const { fb } = load('<div id="a">Alpha</div><div id="b">Beta</div>');
    assert.equal(fb.extract({ kind: 'text', region: '#b' }).text, 'Beta');
    assert.match(fb.extract({ region: '#zz' }).error, /not found/);
  });

  test('table → markdown (html table and role=grid)', () => {
    const { fb } = load(`<table><caption>Orders</caption><thead><tr><th>Id</th><th>Status</th></tr></thead>
      <tbody><tr><td>1</td><td>Open | new</td></tr><tr><td colspan="2">Total 1</td></tr></tbody></table>
      <div role="grid"><div role="row"><span role="columnheader">A</span><span role="columnheader">B</span></div>
      <div role="row"><span role="gridcell">x</span><span role="gridcell">y</span></div></div>
      <table data-nobox><tr><td>invisible</td></tr></table>`);
    const r = fb.extract({ kind: 'table' });
    assert.equal(r.text, [
      '### Orders',
      '| Id | Status |',
      '| --- | --- |',
      '| 1 | Open \\| new |',
      '| Total 1 |  |',
      '',
      '| A | B |',
      '| --- | --- |',
      '| x | y |',
    ].join('\n'));
  });

  test('links: unique, absolute, in order', () => {
    const { fb } = load('<a href="/a">A</a><a href="b?x=1">B</a><a href="/a">A</a><a href="javascript:void 0">J</a><a href="/c" style="display:none">C</a><a href="/d"></a>');
    assert.equal(fb.extract({ kind: 'links' }).text, [
      '- [A](https://app.test/a)',
      '- [B](https://app.test/b?x=1)',
      '- [https://app.test/d](https://app.test/d)',
    ].join('\n'));
  });
});

describe('waitStable', () => {
  test('resolves stable after the quiet period', async () => {
    const { fb } = load('<p>x</p>');
    const r = await fb.waitStable();
    assert.equal(r.stable, true);
    assert.ok(r.ms >= 15 && r.ms < 250, String(r.ms));
  });

  test('continuous mutations hit the hard cap', async () => {
    const { fb, d, w } = load('<p id="p">0</p>');
    let i = 0;
    const iv = w.setInterval(() => { d.getElementById('p').textContent = String(++i); }, 5);
    const r = await fb.waitStable({ quiet: 30, cap: 150 });
    w.clearInterval(iv);
    assert.equal(r.stable, false);
    assert.ok(r.ms >= 140 && r.ms < 400, String(r.ms));
  });

  test('default timing is 300ms quiet / 2500ms cap', () => {
    const { fb } = load('');
    fb.resetForTests();
    deq(fb._timing, { quiet: 300, cap: 2500, poll: 100, checkSettle: 500 });
  });
});

describe('resetForTests', () => {
  test('clears refs and baseline', () => {
    const { fb } = load('<button>A</button>');
    snap(fb);
    fb.resetForTests();
    assert.equal(fb._counter, 0);
    assert.ok(snap(fb, { mode: 'diff' }).startsWith('(new page)'));
    assert.match(snap(fb, { mode: 'full' }), /\[1\] button "A"/);
  });
});

describe('review fixes', () => {
  test('locator is captured before the action (renaming button replays on a fresh page)', async () => {
    const html = '<button id="more">Show more</button>';
    const { d, fb } = load(html);
    d.getElementById('more').addEventListener('click', (e) => (e.currentTarget.textContent = 'Show less'));
    const r = await fb.step({ do: 'click', text: 'Show more' });
    assert.equal(r.ok, true);
    deq(r.locator, { selector: '#more', role: 'button', name: 'Show more' });
    const fresh = load(html);
    const replay = await fresh.fb.step({ do: 'click', locator: json(r.locator) });
    assert.equal(replay.ok, true, replay.error);
  });

  test('custom combobox select records the combobox name before the value changes it', async () => {
    const { d, fb } = load(`
      <div id="cb" role="combobox" aria-controls="lb" tabindex="0">Pick one</div>
      <ul id="lb" role="listbox"><li role="option">Red</li><li role="option">Blue</li></ul>`);
    const cb = d.getElementById('cb');
    for (const o of d.querySelectorAll('[role=option]')) o.addEventListener('click', () => (cb.textContent = o.textContent));
    const r = await fb.step({ do: 'select', selector: '#cb', value: 'Red' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.locator.name, 'Pick one');
  });

  test('check waits for state committed after the event returns (React 18 / Vue style)', async () => {
    const { d, fb } = load('<button id="sw" role="switch" aria-checked="false">Notify</button>');
    const sw = d.getElementById('sw');
    let clicks = 0;
    sw.addEventListener('click', () => {
      clicks++;
      queueMicrotask(() => setTimeout(() => sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'), 30));
    });
    const r = await fb.step({ do: 'check', text: 'Notify' });
    assert.equal(r.ok, true, r.error);
    assert.equal(sw.getAttribute('aria-checked'), 'true');
    assert.equal(clicks, 1);
    // a switch that really does not toggle still fails (after the settle window)
    const broken = load('<button role="switch" aria-checked="false">Dead</button>');
    broken.fb._timing.checkSettle = 60;
    assert.match((await broken.fb.step({ do: 'check', text: 'Dead' })).error, /did not change its checked state/);
  });

  test('press respects the selection: Control+a then a key replaces, Backspace deletes the selection', async () => {
    const { d, fb } = load('<label>Q <input id="q" value="abc"></label>');
    const q = d.getElementById('q');
    assert.equal((await fb.step({ do: 'press', text: 'Q', key: 'Control+a' })).ok, true);
    assert.equal((await fb.step({ do: 'press', text: 'Q', key: 'x' })).ok, true);
    assert.equal(q.value, 'x');
    q.value = 'abc';
    await fb.step({ do: 'press', text: 'Q', key: 'Control+a' });
    await fb.step({ do: 'press', text: 'Q', key: 'Backspace' });
    assert.equal(q.value, '');
    q.value = 'abd';
    q.setSelectionRange(2, 2);
    await fb.step({ do: 'press', text: 'Q', key: 'c' });
    assert.equal(q.value, 'abcd', 'inserted at the caret');
    await fb.step({ do: 'press', text: 'Q', key: 'Backspace' });
    assert.equal(q.value, 'abd');
  });

  test('typed input value attribute never ends up in the locator selector', async () => {
    const form = (i) => `<form id="f${i}"><label>Password <input type="password" name="password"></label></form>`;
    const { d, fb } = load(form(1) + form(2));
    const pw = d.querySelector('#f2 input');
    pw.addEventListener('input', () => pw.setAttribute('value', pw.value)); // React-style attribute sync
    pw.setAttribute('value', 'hunter2-SECRET'); // value attribute already mirrors earlier typing
    const r = await fb.step({ do: 'fill', selector: '#f2 input', value: 'hunter2-SECRET' });
    assert.equal(r.ok, true, r.error);
    assert.equal(JSON.stringify(r.locator).includes('hunter2'), false, JSON.stringify(r.locator));
    // radio/checkbox still use their static value attribute
    const radios = load('<label><input type="radio" name="c" value="red">Red</label><label><input type="radio" name="c" value="blue">Blue</label>');
    const rr = await radios.fb.step({ do: 'check', text: 'Blue' });
    assert.equal(rr.locator.selector, 'input[name="c"][value="blue"]');
  });
});
