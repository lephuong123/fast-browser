// The 7 MCP tools: zod schemas, handlers (callable directly for tests), text formatting, call logging.
import { z } from 'zod';
import { ACT_TIMEOUT_MS } from './bridge.js';
import { describeStep, WorkflowError } from './workflows.js';

export const SERVER_INSTRUCTIONS = [
  'Fast Browser drives the user\'s real Chrome (logged-in sessions) through an extension.',
  '- Batch many actions into one browser_act call (fill a whole form + submit in one go).',
  '- Each browser_act / browser_tabs result already contains a diff snapshot: rely on it instead of re-snapshotting.',
  '- Refs ([n]) come from snapshots; text+role or selector also work as targets.',
  '- For repeated tasks call browser_workflow list first and prefer browser_workflow run when a saved workflow fits.',
  '- After doing a task by hand that will recur: browser_workflow reset before, save (with params) after.',
  '- For data reads prefer browser_eval with fetch() against the app\'s own API over clicking through the UI.',
  '- Use browser_extract for text/tables/links; browser_screenshot only for canvas/charts/visual checks.',
  '- On a failed step, fix it from the returned snapshot and continue with one browser_act call.',
  '- Only allowlisted domains are reachable (~/.fast-browser/config.json allowedDomains).',
].join('\n');

const ACTION_KINDS = ['click', 'fill', 'select', 'check', 'press', 'hover', 'scroll', 'wait', 'navigate'];

const LocatorSchema = z
  .object({ selector: z.string().optional(), role: z.string().optional(), name: z.string().optional(), nth: z.number().int().optional() })
  .passthrough();

export const ActionSchema = z.object({
  do: z.enum(ACTION_KINDS),
  ref: z.number().int().positive().optional(),
  text: z.string().optional(),
  role: z.string().optional(),
  selector: z.string().optional(),
  locator: LocatorSchema.optional(),
  value: z.string().optional(),
  checked: z.boolean().optional(),
  key: z.string().optional(),
  url: z.string().optional(),
  direction: z.enum(['down', 'up']).optional(),
  amount: z.number().optional(),
  ms: z.number().nonnegative().optional(),
  waitText: z.string().optional(),
  waitSelector: z.string().optional(),
  noWait: z.boolean().optional(),
});

const tabId = z.number().int().optional();

export const TOOL_DEFS = {
  browser_tabs: {
    description: 'List/open/switch/close tabs. goto/new/select return a page snapshot.',
    inputSchema: {
      action: z.enum(['list', 'goto', 'new', 'select', 'close']),
      url: z.string().optional(),
      tabId,
    },
  },
  browser_snapshot: {
    description: 'Page snapshot: interactive elements with [ref]s. mode diff (vs last) | viewport (default) | full; region = CSS scope.',
    inputSchema: {
      mode: z.enum(['diff', 'viewport', 'full']).optional(),
      region: z.string().optional(),
      tabId,
    },
  },
  browser_act: {
    description:
      'Run up to 50 actions in one call; stops at first failure; returns per-step results + diff snapshot. ' +
      'Action: {do: click|fill|select|check|press|hover|scroll|wait|navigate, target: ref|text(+role)|selector, ' +
      'value, checked, key, url, direction, amount, ms, waitText, waitSelector, noWait}.',
    inputSchema: {
      actions: z.array(ActionSchema).min(1).max(50),
      tabId,
    },
  },
  browser_extract: {
    description: 'Extract page content as text (default), markdown tables, or links. region = CSS scope.',
    inputSchema: {
      kind: z.enum(['text', 'table', 'links']).optional(),
      region: z.string().optional(),
      maxChars: z.number().int().positive().optional(),
      tabId,
    },
  },
  browser_eval: {
    description: 'Run JS in the page (async function body; use return). Result must be JSON-serialisable. Good for fetch() to the app API.',
    inputSchema: { code: z.string().min(1), tabId },
  },
  browser_screenshot: {
    description: 'JPEG of the visible tab. Use only when visuals matter (canvas, charts).',
    inputSchema: {
      maxWidth: z.number().int().positive().optional(),
      quality: z.number().int().min(1).max(100).optional(),
      tabId,
    },
  },
  browser_workflow: {
    description:
      'Saved workflows. list | run {name, params} | save {name, description, params: {name: value-to-templatise}} ' +
      '(saves steps recorded since reset) | show {name} | reset | delete {name}.',
    inputSchema: {
      action: z.enum(['list', 'run', 'save', 'show', 'reset', 'delete']),
      name: z.string().optional(),
      description: z.string().optional(),
      params: z.record(z.string()).optional(),
    },
  },
};

class ToolInputError extends Error {}

function need(cond, message) {
  if (!cond) throw new ToolInputError(message);
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function errorResult(e) {
  let msg = e?.message || String(e);
  if (e?.snapshot) msg += `\n--- snapshot ---\n${e.snapshot}`;
  return text(`error: ${msg}`, true);
}

function stepTarget(action = {}, step = {}) {
  const parts = [];
  if (action.ref !== undefined) parts.push(`[${action.ref}]`);
  const loc = step.locator || action.locator;
  if (loc && (loc.role || loc.name !== undefined)) parts.push([loc.role, loc.name !== undefined ? JSON.stringify(loc.name) : null].filter(Boolean).join(' '));
  else if (action.text !== undefined) parts.push([action.role, JSON.stringify(action.text)].filter(Boolean).join(' '));
  else if (action.selector) parts.push(action.selector);
  else if (loc?.selector) parts.push(loc.selector);
  if (action.do === 'navigate' && action.url) parts.push(action.url);
  if (action.do === 'press' && action.key) parts.push(action.key);
  if (action.do === 'scroll' && action.direction) parts.push(action.direction);
  return parts.join(' ');
}

// ActResult -> plain text. Step numbers are 1-based positions in the batch.
export function formatActResult(actions, result = {}) {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const lines = steps.map((s, j) => {
    const action = actions[j] || { do: s.do };
    const target = stepTarget(action, s);
    const head = `${j + 1} ${s.do || action.do}${target ? ' ' + target : ''}`;
    return s.ok ? `✓ ${head}` : `✗ ${head}: ${s.error || 'failed'}`;
  });
  const failed = steps.findIndex((s) => !s.ok);
  if (!result.completed && failed >= 0 && actions.length > steps.length) {
    lines.push(`(steps ${steps.length + 1}-${actions.length} not run)`);
  }
  lines.push('--- snapshot ---');
  lines.push(result.snapshot || '(no snapshot)');
  return lines.join('\n');
}

function actMeta(result = {}) {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const failed = steps.findIndex((s) => !s.ok);
  return { steps: steps.length, ...(failed >= 0 ? { failedStep: failed + 1 } : {}) };
}

function formatTabs(tabs = []) {
  if (!tabs.length) return '(no tabs)';
  return tabs
    .map((t) => `${t.current ? '*' : ' '} [${t.tabId}] ${t.title || '(untitled)'} — ${t.url || ''}${t.active ? ' (active)' : ''}`)
    .join('\n');
}

function formatValue(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

function formatWorkflow(wf) {
  const lines = [`${wf.name}${wf.description ? ' — ' + wf.description : ''}`];
  lines.push(`params: ${wf.params?.length ? wf.params.join(', ') : '(none)'}`);
  (wf.steps || []).forEach((s, i) => lines.push(`${i + 1}. ${describeStep(s)}`));
  return lines.join('\n');
}

// Methods that act on one tab and default to the extension's single, global "current tab".
const TAB_METHODS = new Set(['tabs.goto', 'page.snapshot', 'page.act', 'page.extract', 'page.eval', 'page.screenshot']);
const TAB_GONE = /^tab \d+ not found/;

export function createToolHandlers({ bridge, workflows, callLog, recordingOn = () => true }) {
  // Several sessions can share one extension (bridge.shared). The extension's "current tab" is global, so each
  // session remembers its own tab (the last one it opened / navigated / selected) and sends it explicitly.
  let sessionTab = null;

  function track(method, params, r) {
    if ((method === 'tabs.new' || method === 'tabs.goto' || method === 'tabs.select') && Number.isInteger(r?.tabId)) sessionTab = r.tabId;
    if (method === 'tabs.close' && (r?.closed ?? params.tabId) === sessionTab) sessionTab = null;
  }

  async function req(method, params, opts) {
    const p = clean(params || {});
    const implicit = TAB_METHODS.has(method) && p.tabId === undefined;
    if (implicit && sessionTab != null) p.tabId = sessionTab;
    else if (implicit && bridge.shared) {
      // No tab of our own yet: the global current tab may belong to another session.
      if (method !== 'tabs.goto') {
        throw new ToolInputError('another session is using this browser too — open your own tab first (browser_tabs action=new or goto), or pass tabId');
      }
      method = 'tabs.new'; // goto without a tab → open a fresh tab instead of navigating someone else's
    }
    try {
      const r = await bridge.request(method, p, opts);
      track(method, p, r);
      return r;
    } catch (e) {
      if (!(implicit && p.tabId === sessionTab && sessionTab != null && TAB_GONE.test(e?.message || ''))) throw e;
      sessionTab = null; // our tab was closed by hand: fall back once to the old default behaviour
      return req(method, { ...params, tabId: undefined }, opts);
    }
  }

  const impl = {
    async browser_tabs(args) {
      const { action, url, tabId: id } = args;
      switch (action) {
        case 'list':
          return text(formatTabs((await req('tabs.list', {}))?.tabs));
        case 'goto': {
          need(url, 'browser_tabs goto needs url');
          const r = await req('tabs.goto', { url, tabId: id });
          if (recordingOn()) workflows.record([{ action: { do: 'navigate', url }, result: { ok: true } }]);
          return text(`tab ${r?.tabId}\n${r?.snapshot ?? ''}`.trimEnd());
        }
        case 'new': {
          const r = await req('tabs.new', { url });
          return text(`tab ${r?.tabId}${r?.snapshot ? '\n' + r.snapshot : ''}`);
        }
        case 'select': {
          need(id !== undefined, 'browser_tabs select needs tabId');
          const r = await req('tabs.select', { tabId: id });
          return text(`tab ${r?.tabId}\n${r?.snapshot ?? ''}`.trimEnd());
        }
        case 'close': {
          need(id !== undefined, 'browser_tabs close needs tabId');
          const r = await req('tabs.close', { tabId: id });
          return text(`closed tab ${r?.closed ?? id}`);
        }
        default:
          throw new ToolInputError(`unknown action ${action}`);
      }
    },

    async browser_snapshot(args) {
      const r = await req('page.snapshot', { mode: args.mode || 'viewport', region: args.region, tabId: args.tabId });
      return text(r?.text ?? '');
    },

    async browser_act(args, meta) {
      const actions = args.actions;
      const record = recordingOn();
      const r = await req('page.act', { actions, record, tabId: args.tabId }, { timeoutMs: ACT_TIMEOUT_MS });
      Object.assign(meta, actMeta(r));
      if (record) {
        const steps = Array.isArray(r?.steps) ? r.steps : [];
        workflows.record(steps.map((s, j) => ({ action: actions[j], result: s })).filter((p) => p.result.ok));
      }
      return text(formatActResult(actions, r), !r?.completed);
    },

    async browser_extract(args) {
      const r = await req('page.extract', { kind: args.kind || 'text', region: args.region, maxChars: args.maxChars, tabId: args.tabId });
      let out = r?.text ?? '';
      if (r?.truncated) out += '\n…(truncated — narrow with region or raise maxChars)';
      return text(out || '(empty)');
    },

    async browser_eval(args) {
      const r = await req('page.eval', { code: args.code, tabId: args.tabId });
      return text(formatValue(r?.value));
    },

    async browser_screenshot(args) {
      const r = await req('page.screenshot', { maxWidth: args.maxWidth ?? 1024, quality: args.quality ?? 60, tabId: args.tabId });
      need(r?.dataBase64, 'extension returned no image data');
      return { content: [{ type: 'image', data: r.dataBase64, mimeType: r.mimeType || 'image/jpeg' }] };
    },

    async browser_workflow(args, meta) {
      const { action, name, description, params } = args;
      switch (action) {
        case 'list': {
          const all = workflows.list();
          if (!all.length) return text('no saved workflows');
          return text(
            all
              .map((w) => `${w.name}${w.params.length ? `(${w.params.join(', ')})` : ''}${w.description ? ' — ' + w.description : ''}`)
              .join('\n'),
          );
        }
        case 'show': {
          if (!name) {
            const rec = workflows.recording;
            if (!rec.length) return text('recording is empty (nothing since last reset)');
            return text(['recording (since last reset):', ...rec.map((s, i) => `${i + 1}. ${describeStep(s)}`)].join('\n'));
          }
          return text(formatWorkflow(workflows.load(name)));
        }
        case 'reset': {
          const n = workflows.reset();
          return text(`recording reset (${n} step${n === 1 ? '' : 's'} dropped)`);
        }
        case 'save': {
          need(name, 'browser_workflow save needs name');
          const wf = workflows.save({ name, description, params: params || {} });
          return text(
            `saved workflow "${wf.name}" (${wf.steps.length} steps, params: ${wf.params.length ? wf.params.join(', ') : 'none'})\n` +
              formatWorkflow(wf).split('\n').slice(2).join('\n'),
          );
        }
        case 'delete': {
          need(name, 'browser_workflow delete needs name');
          workflows.remove(name);
          return text(`deleted workflow "${name}"`);
        }
        case 'run': {
          need(name, 'browser_workflow run needs name');
          const { workflow, actions } = workflows.prepareRun(name, params || {});
          const r = await req('page.act', { actions, record: false }, { timeoutMs: ACT_TIMEOUT_MS });
          Object.assign(meta, actMeta(r));
          let out = formatActResult(actions, r);
          if (r?.completed) {
            out += `\nworkflow "${name}" completed`;
            return text(out);
          }
          const steps = Array.isArray(r?.steps) ? r.steps : [];
          const failedAt = steps.findIndex((s) => !s.ok);
          const okCount = failedAt >= 0 ? failedAt : steps.length;
          // Seed the recording with the steps that worked (still templated) so "finish + save" rebuilds the whole workflow.
          workflows.replaceRecording((workflow.steps || []).slice(0, okCount));
          out += `\nworkflow "${name}" failed at step ${okCount + 1} — finish with browser_act, then browser_workflow save name=${name}`;
          out += `\n(recording now holds the ${okCount} step${okCount === 1 ? '' : 's'} that worked; pass the same params to save)`;
          return text(out, true);
        }
        default:
          throw new ToolInputError(`unknown action ${action}`);
      }
    },
  };

  const handlers = {};
  for (const [tool, fn] of Object.entries(impl)) {
    handlers[tool] = async (args = {}) => {
      const t0 = Date.now();
      const meta = {};
      let result;
      try {
        result = await fn(args, meta);
      } catch (e) {
        result = errorResult(e);
      }
      const outChars = (result.content || []).reduce((n, c) => n + (c.text?.length || c.data?.length || 0), 0);
      callLog?.write(
        clean({
          tool,
          action: args.action ?? (tool === 'browser_extract' ? args.kind || 'text' : tool === 'browser_snapshot' ? args.mode || 'viewport' : undefined),
          ms: Date.now() - t0,
          ok: !result.isError,
          steps: meta.steps,
          failedStep: meta.failedStep,
          inChars: JSON.stringify(args).length,
          outChars,
        }),
      );
      return result;
    };
  }
  return handlers;
}

export function registerTools(server, ctx) {
  const handlers = createToolHandlers(ctx);
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    server.registerTool(name, { description: def.description, inputSchema: def.inputSchema }, (args) => handlers[name](args));
  }
  return handlers;
}

export { WorkflowError };
