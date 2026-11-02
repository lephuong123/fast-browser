# Fast Browser — build spec (contract shared by all components)

Source design: "Giải pháp Fast Browser — MCP + Chrome extension" (2026-11-02).
Phase 1 scope. Decisions taken = the doc's "Đề xuất" column:
DOM-simulated input (no CDP) · client = Claude Code · workflows in `~/.fast-browser/workflows` ·
domain allowlist ON · extension in plain JS, no build step · benchmark tasks chosen later by the user.

## Repo layout

```
fast-browser/
  SPEC.md                 this file (the contract)
  README.md               install + usage (Vietnamese ok, code identifiers English)
  package.json            npm workspaces root: scripts test, test:e2e
  server/                 Node 20, ESM, deps: @modelcontextprotocol/sdk, ws, zod
    src/index.js          entry: stdio MCP server + WS bridge
    src/bridge.js         WS server on 127.0.0.1, request/response with ids, timeouts
    src/tools.js          the 7 MCP tools (schemas + handlers)
    src/workflows.js      recording buffer, save/run/show/list/delete, param templating
    src/config.js         config load (~/.fast-browser/config.json + env)
    src/log.js            JSONL call log for metrics
    test/*.test.js        node:test, with a fake extension WS client
  extension/              Chrome MV3, plain JS, loaded unpacked
    manifest.json
    background.js         service worker (type: module): WS client, tabs, runner, screenshot, eval
    runner.js             pure step-loop logic (ES module, dependency-injected → unit-testable)
    page.js               content logic injected into pages (IIFE, defines globalThis.__fb)
    test/*.test.js        node:test + jsdom for page.js, runner.js with fakes
  e2e/                    Playwright (bundled Chromium, --load-extension) + local fixture pages
```

## Transport: server ⇄ extension

- Server listens WebSocket on `127.0.0.1:${FB_PORT||17890}`. Reject upgrade unless `Origin` starts with
  `chrome-extension://`; if `FB_EXTENSION_ID` set, Origin must equal `chrome-extension://<id>`.
  Only one extension connection at a time (newest wins, old one closed).
- If the port is busy, the MCP server still starts; every tool returns a clear error
  ("port 17890 in use — another Fast Browser server is running; close it or set FB_PORT").
- Extension reconnects with backoff (0.5s → max 5s). Keep SW alive: WS traffic + `chrome.alarms` every 30s
  (Chrome ≥116 keeps SW alive while a WS is active and exchanging messages; extension sends `{type:"ping"}` every 20s).
- Messages are JSON:
  - server → ext request: `{id, type:"req", method, params}`
  - ext → server response: `{id, type:"res", ok:true, result}` or `{id, type:"res", ok:false, error:{message, snapshot?}}`
  - ext → server on connect: `{type:"hello", version, extensionId}`; server replies `{type:"config", allowedDomains:[...]}`.
  - ext → server: `{type:"ping"}`, server ignores (or `pong`).
- Server request timeout: 60s default, `browser_act` 120s.

## Extension methods (`method` → params → result)

All methods take optional `tabId`; default = the "current tab" the SW tracks
(last tab created/selected/goto'd by us, else the active tab of the last focused window).

| method | params | result |
|---|---|---|
| `tabs.list` | – | `{tabs:[{tabId,title,url,active,current}]}` |
| `tabs.goto` | `{url, tabId?}` | `{tabId, snapshot}` (after load + DOM stable) |
| `tabs.new` | `{url?}` | `{tabId, snapshot?}` |
| `tabs.select` | `{tabId}` | `{tabId, snapshot}` |
| `tabs.close` | `{tabId}` | `{closed:tabId}` |
| `page.snapshot` | `{mode:"diff"\|"viewport"\|"full", region?:css}` | `{text}` |
| `page.act` | `{actions:[Action], record:boolean}` | `ActResult` |
| `page.extract` | `{kind:"text"\|"table"\|"links", region?:css, maxChars?:number}` | `{text, truncated}` |
| `page.eval` | `{code}` | `{value}` (JSON-serialisable) |
| `page.screenshot` | `{maxWidth?:number=1024, quality?:number=60}` | `{dataBase64, mimeType:"image/jpeg"}` |

Allowlist: before any method touching a tab, and before navigating (`tabs.goto`, `tabs.new` with url, action
`navigate`), the SW checks the host against `allowedDomains` (from server config message). Match = host equals
entry or ends with `.entry`; entry `*` allows all; `localhost`/`127.0.0.1` allowed only if listed.
Violation → error `domain not allowed: <host> (add it to ~/.fast-browser/config.json allowedDomains)`.
`chrome://`, Chrome Web Store and other un-injectable pages → clear error.

## Action (element of `browser_act.actions`, max 50)

```
{ do: "click"|"fill"|"select"|"check"|"press"|"hover"|"scroll"|"wait"|"navigate",
  // target (one of) — not needed for wait/navigate/scroll-by/press-without-target:
  ref?: number,                 // from snapshot
  text?: string, role?: string, // accessible name (exact match first, then case-insensitive contains), optional role filter
  selector?: string,            // CSS
  locator?: Locator,            // used by workflow replay (see below)
  // payload:
  value?: string,               // fill: text; select: option label or value
  checked?: boolean,            // check: default true
  key?: string,                 // press: "Enter", "Tab", "Escape", "ArrowDown", "Control+a" …
  url?: string,                 // navigate
  direction?: "down"|"up", amount?: number, // scroll (px, default one viewport); with a target → scrollIntoView
  ms?: number, waitText?: string, waitSelector?: string, // wait: for text/selector to appear (timeout ms, default 5000) or plain ms
  noWait?: boolean              // skip the DOM-stable wait after this step
}
```

Locator recorded for each successful targeted step: `{selector, role, name, nth?}` — `selector` is the most stable
CSS found (id if not auto-generated-looking, `[data-testid]`/`[data-test]`/`[name]`/`[aria-label]`, else a short
structural path); `role`,`name` = computed role and accessible name.

Replay resolution of `locator`: query `selector`; if exactly one element and its accessible name equals `name`
(normalised whitespace, case-insensitive) → use it. Otherwise fall back to role+name search. Still nothing → step fails.

## Runner semantics (`page.act`, lives in the extension SW, `runner.js`)

For each action i: ensure page script injected (inject `page.js` via `chrome.scripting.executeScript` if
`globalThis.__fb` missing) → send step to page → page resolves target, performs action, returns
`{ok, locator?, error?}` → unless `noWait`: if the tab started navigating (tabs.onUpdated status `loading` or URL
change), wait for `complete` (timeout 15s), re-inject, then wait DOM-stable; otherwise page waits DOM-stable.
`navigate` action is executed by the SW (`chrome.tabs.update`). Stop at the first failing step.

`ActResult`:
```
{ steps:[{i, do, ok, error?, locator?}],   // only executed steps
  completed: boolean,
  snapshot: string }   // completed → diff snapshot vs. the snapshot before the batch
                      // failed     → error explanation already in steps[i].error + FULL viewport snapshot
```
Step error messages must be self-explanatory, e.g.
`no element matches text "Lưu" role=button; closest: [5] button "Lưu lại", [9] button "Lưu nháp"`,
`ref 12 is stale (element removed); take a new snapshot`, `element [4] is disabled`.

## DOM-stable wait (page.js)

MutationObserver on document (subtree, attributes, childList, characterData). Resolve when no mutation for 300ms,
hard cap 2500ms; also wait `document.readyState !== "loading"`.

## Snapshot format (page.js)

```
<document.title>
<location.href>
scroll <0-100>%
[modal] (only if a modal is open; then only the modal's subtree is listed)

— <heading text>              (h1–h3 / role=heading encountered in document order, only if followed by listed items)
[<ref>] <role> "<name>" <state…>
```
- Listed: interactive elements (a[href], button, input, select, textarea, [contenteditable], summary, roles
  button/link/checkbox/radio/tab/menuitem/option/switch/combobox/textbox/searchbox/slider, `[onclick]`, `tabindex>=0`),
  visible (non-zero box, not visibility:hidden/display:none, not aria-hidden), and in viewport for mode `viewport`
  (default) / `diff`; whole document for `full`; inside `region` if given.
- Modal = topmost visible `dialog[open]`, `[aria-modal=true]`, or `[role=dialog]`/`[role=alertdialog]`.
- States: `value="…"` (inputs, truncated 60 chars, passwords shown as `value="••••"`), `selected="…"` (select /
  combobox), `checked`, `disabled`, `expanded`/`collapsed`, `required`, `focused`. Names truncated to 80 chars.
- Refs: positive integers, stable for the lifetime of the document (WeakMap element→ref, counter on `globalThis.__fb`).
- Diff vs previous snapshot of the same document (lines keyed by ref): `+ ` new, `~ ` changed, `- ` gone
  (`- [7] button "X"`), header lines re-sent only if title/url changed. Empty diff → `(no changes)`.
  If the document changed (navigation), diff = full viewport snapshot prefixed by `(new page)`.
- Every `page.snapshot` / act stores the current line map as the baseline for the next diff.

## Action implementation notes (page.js)

- click: scrollIntoView({block:"center"}), dispatch pointerdown/mousedown/pointerup/mouseup/click with coordinates,
  focus where focusable. Disabled → error.
- fill: focus, select all, set via native value setter (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set`)
  then `input` + `change` events (React-compatible); contenteditable → `document.execCommand('insertText')` fallback to textContent.
  Password fields: record the step value as `{{password}}` in the locator-level record (server never stores real value).
- select: native `<select>` by option label or value (+ input/change). Custom combobox: click it, then click the option
  by name.
- check: set to `checked` (default true) by clicking only if state differs.
- press: keydown/keypress/keyup on target or activeElement; Enter on input inside a form → `form.requestSubmit()` if
  no handler prevented default.
- hover: pointerover/mouseover/mouseenter/mousemove.
- scroll: window or nearest scrollable ancestor / target scrollIntoView.
- wait: poll every 100ms for waitText (in innerText) / waitSelector, or sleep ms.

## extract (page.js)

- text: `innerText` of region or `main`/`[role=main]`/body, whitespace collapsed, truncated to `maxChars` (default 8000).
- table: every visible `<table>` (and `[role=table]`/`[role=grid]`) in region → markdown tables.
- links: `- [text](absolute href)` unique, in order.

## eval (background.js)

`chrome.scripting.executeScript({world:"MAIN", func:(code)=>(async()=>{ const AsyncFunction=(async()=>{}).constructor; return await new AsyncFunction(code)(); })(), args:[code]})`
Result must be JSON-serialisable (wrap with JSON round-trip, cap 100k chars). CSP `unsafe-eval` block → error
explaining the limitation and suggesting `browser_extract`.

## screenshot (background.js)

`chrome.tabs.captureVisibleTab(windowId,{format:"jpeg",quality})` (tab must be active — select it first),
downscale to `maxWidth` with `OffscreenCanvas` + `createImageBitmap`, return base64.

## MCP tools (server) — exactly 7

| tool | input | maps to |
|---|---|---|
| `browser_tabs` | `{action:"list"\|"goto"\|"new"\|"select"\|"close", url?, tabId?}` | `tabs.*` |
| `browser_snapshot` | `{mode?:"diff"\|"viewport"\|"full", region?, tabId?}` | `page.snapshot` |
| `browser_act` | `{actions:Action[1..50], tabId?}` | `page.act` (record = server recording on) |
| `browser_extract` | `{kind?:"text"\|"table"\|"links", region?, maxChars?, tabId?}` | `page.extract` |
| `browser_eval` | `{code, tabId?}` | `page.eval` |
| `browser_screenshot` | `{maxWidth?, quality?, tabId?}` | `page.screenshot` → MCP image content |
| `browser_workflow` | `{action:"list"\|"run"\|"save"\|"show"\|"reset"\|"delete", name?, description?, params?:{[k]:string}}` | server-side |

Tool descriptions are short (token cost). Server `instructions` (sent at MCP initialize), ≈10 lines:
batch many actions per `browser_act`; rely on returned diffs instead of re-snapshotting; prefer `browser_workflow run`
when a saved workflow fits (call `list` first for repeated tasks); prefer `browser_eval` + `fetch` against the app's
own API over clicking through UI for data reads; screenshot only for canvas/charts; on a failed step, fix from the
returned snapshot and continue with one call.

Text results: plain text (not JSON) where possible — `browser_act` returns e.g.
```
✓ 1 fill [1] textbox "Email"
✓ 2 select [3] combobox "Trạng thái"
✗ 3 click: no element matches …
--- snapshot ---
…
```

## Workflows (server, `src/workflows.js`)

- Recording buffer (in memory, also mirrored to `~/.fast-browser/recording.json`): every successful step of every
  `browser_act` call since the last `reset` is appended as `{do, locator?, value?, checked?, key?, url?, direction?,
  amount?, ms?, waitText?, waitSelector?, noWait?}` (ref/text/selector replaced by `locator`). `browser_tabs goto`
  is recorded as a `navigate` step.
- `save {name, description?, params}`: for each param `k=v`, replace every occurrence of `v` in string fields with
  `{{k}}`. Password-field fills are always `{{password}}` (auto-added param). Write
  `~/.fast-browser/workflows/<name>.json` = `{name, description, params:[names], steps, createdAt, updatedAt}`.
  Name: `[a-z0-9-_]+`. Save over an existing name overwrites (that is the "fix and re-save" path).
- `run {name, params}`: substitute, missing param → error listing required params; send as one `page.act`
  (record=false). Result text = act result + `workflow "<name>" completed` or `failed at step i — finish with
  browser_act, then browser_workflow save name=<name>` .
- `show` prints steps human-readably; `list` names + descriptions + params; `delete` removes the file.

## Config (`~/.fast-browser/config.json`, created with defaults on first run)

```json
{ "port": 17890,
  "allowedDomains": ["creativeforce.io", "creativeforce-dev.io", "atlassian.net", "atlassian.com", "localhost", "127.0.0.1"] }
```
Env overrides: `FB_PORT`, `FB_EXTENSION_ID`, `FB_ALLOWED_DOMAINS` (comma list), `FB_HOME` (default `~/.fast-browser`,
used by tests to isolate).

## Metrics log

Every tool call appends one JSONL line to `$FB_HOME/logs/calls-YYYY-MM-DD.jsonl`:
`{ts, tool, action?, ms, ok, steps?, failedStep?, inChars, outChars}`. A script `server/src/stats.js` prints per-day
counts (calls per tool, avg ms, failure rate) — this is the benchmark data source.

## Tests (must pass with `npm test` at repo root, no network)

- page.js in jsdom: snapshot lines/states/refs stable, modal-only, diff +/~/-, each action, error messages with
  "closest" candidates, locator generation + replay fallback, extract text/table/links, DOM-stable wait cap.
  (jsdom has no layout: page.js must treat "visible/in-viewport" through a small overridable helper so tests can stub it.)
- runner.js with fake chrome deps: navigation mid-batch, stop at first failure, re-inject.
- server: tool handlers against a fake WS extension; origin rejection; workflow save/param templating/run/missing
  params; password never written; busy-port error.
- e2e (`npm run test:e2e`, separate): Playwright Chromium with the unpacked extension, local fixture site
  (form page, page that navigates on submit, modal, table), driven through the real MCP server over stdio with the MCP
  client SDK. Covers: tabs goto → act batch with navigation mid-way → diff → extract table → workflow
  reset/save/run with a new param → allowlist rejection.

## Amendments after build + review (2026-11-02)

These override the sections above.
- **Mutual auth on the bridge.** Shared secret in `$FB_HOME/token` (pasted once into the extension popup).
  `hello` carries `nonce`; server answers `config` with `nonce` + `proof` (HMAC); extension answers `{type:"auth", proof}`;
  server sends `{type:"ready"}`. Extension ignores config/requests until the server has proved itself.
  Close codes: 4001 no auth in 10s, 4002 hello without nonce, 4003 bad proof. Only an authenticated connection may
  replace the current one.
- **Pinned extension id.** `manifest.json` has a fixed `key` → id `biombhedndgmjlfaklonbecohcobfndd`; the server accepts
  only that origin by default. `FB_EXTENSION_ID="*"` disables pinning.
- **Allowlist ceiling** in the popup: the server may narrow the list but never widen it.
- **Allowlist checked before every step** (url and pendingUrl), plus an in-page `location.hostname` guard before any
  page call or eval. `tabs.list` shows `(not allowed: host)` without title for other tabs. Loopback (127/8, ::1,
  *.localhost, 0.0.0.0) needs an explicit entry even with `*`.
- **Workflow templating** touches only `value`, `waitText`, `text`, `locator.name` and the path/query/hash of `url`
  — never selector, role, nth, key, waitSelector or scheme/host/port.
- **Locator** is captured before the action runs. `[value=…]` selectors only for radio/checkbox; password fills drop
  any `[value=` selector server-side.
- **page.js** returns `{error}` instead of throwing; `step()` does not wait — the runner calls `waitStable()`.
  `press Escape` closes a native `<dialog>` (cancel event first). `check` waits up to 500 ms for the state to flip.
- A tab already in `loading` before a step is not treated as a navigation.
