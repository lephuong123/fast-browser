// Workflows: recording buffer (memory + recording.json mirror), save with param templating, run, show, list, delete.
import fs from 'node:fs';
import path from 'node:path';
import { logErr } from './log.js';

export const NAME_RE = /^[a-z0-9_-]+$/;
const PARAM_RE = /^[A-Za-z0-9_-]+$/;
const TOKEN_SPLIT_RE = /(\{\{[A-Za-z0-9_-]+\}\})/;
const IS_TOKEN_RE = /^\{\{[A-Za-z0-9_-]+\}\}$/;
const TOKEN_RE = /\{\{([A-Za-z0-9_-]+)\}\}/g;
const PAYLOAD_KEYS = ['value', 'checked', 'key', 'url', 'direction', 'amount', 'ms', 'waitText', 'waitSelector', 'noWait'];
const LOCATOR_KEYS = ['selector', 'role', 'name', 'nth'];
const NO_TEMPLATE_KEYS = new Set(['do', 'direction']);
const PASSWORD_HINT_RE = /pass(word|wd)?\b|mật khẩu|mat khau|\bpwd\b/i;

export class WorkflowError extends Error {}

function cleanLocator(loc) {
  if (!loc || typeof loc !== 'object') return undefined;
  const out = {};
  for (const k of LOCATOR_KEYS) if (loc[k] !== undefined && loc[k] !== null) out[k] = loc[k];
  return Object.keys(out).length ? out : undefined;
}

// A fill into a password field: flagged by the extension, or recognisable from the locator/target.
export function isPasswordFill(action, stepResult = {}) {
  if (action?.do !== 'fill') return false;
  const loc = stepResult.locator || action.locator || {};
  if (stepResult.password === true || loc.password === true) return true;
  if (loc.type === 'password' || loc.inputType === 'password') return true;
  if (stepResult.value === '{{password}}' || loc.value === '{{password}}') return true;
  const hints = [loc.selector, loc.name, action.selector, action.text].filter((s) => typeof s === 'string');
  return hints.some((s) => /type=["']?password/i.test(s) || PASSWORD_HINT_RE.test(s));
}

// Turn an executed action + its step result into the stored, replayable step (ref/text/selector -> locator).
export function toRecordedStep(action, stepResult = {}) {
  const step = { do: action.do };
  const locator = cleanLocator(stepResult.locator) || cleanLocator(action.locator);
  if (locator) step.locator = locator;
  else {
    // No locator came back (e.g. untargeted step); keep stable target fields, never the ephemeral ref.
    if (typeof action.text === 'string') step.text = action.text;
    if (typeof action.role === 'string') step.role = action.role;
    if (typeof action.selector === 'string') step.selector = action.selector;
  }
  for (const k of PAYLOAD_KEYS) if (action[k] !== undefined) step[k] = action[k];
  if (isPasswordFill(action, stepResult)) {
    step.value = '{{password}}';
    // Defence in depth: a selector built from a controlled input's value attribute would carry the secret.
    if (step.locator && typeof step.locator.selector === 'string' && /\[value[~|^$*]?=/i.test(step.locator.selector)) {
      delete step.locator.selector;
    }
  }
  return step;
}

function mapStrings(value, fn, key) {
  if (typeof value === 'string') return NO_TEMPLATE_KEYS.has(key) ? value : fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn, k);
    return out;
  }
  return value;
}

// Fields that carry user data and are templated on save. Structural fields (locator.selector/role/nth, key,
// waitSelector, direction, do) are never touched: a short value such as "5" would otherwise corrupt
// "tr:nth-of-type(5)" or a port in a URL. For url only the path/query/hash is templated, never scheme/host/port.
const TEMPLATE_STEP_KEYS = new Set(['value', 'waitText', 'text']);
const TEMPLATE_LOCATOR_KEYS = new Set(['name']);
const URL_ORIGIN_RE = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([\s\S]*)$/i;

function makeTemplater(params) {
  const pairs = Object.entries(params)
    .filter(([, v]) => typeof v === 'string' && v.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  if (!pairs.length) return null;
  return (s) => {
    let parts = s.split(TOKEN_SPLIT_RE);
    for (const [k, v] of pairs) {
      parts = parts.flatMap((part) => {
        if (IS_TOKEN_RE.test(part)) return [part];
        return part.split(v).flatMap((p, i) => (i === 0 ? [p] : [`{{${k}}}`, p]));
      });
    }
    return parts.join('');
  };
}

function templateUrl(url, tpl) {
  const m = URL_ORIGIN_RE.exec(url);
  return m ? m[1] + tpl(m[2]) : tpl(url);
}

// Replace occurrences of each param value with {{name}} in user-data fields only; never touches {{tokens}}.
export function templateSteps(steps, params = {}) {
  const out = structuredClone(steps);
  const tpl = makeTemplater(params);
  if (!tpl) return out;
  for (const step of out) {
    if (!step || typeof step !== 'object') continue;
    for (const k of Object.keys(step)) {
      if (typeof step[k] !== 'string') continue;
      if (TEMPLATE_STEP_KEYS.has(k)) step[k] = tpl(step[k]);
      else if (k === 'url') step[k] = templateUrl(step[k], tpl);
    }
    if (step.locator && typeof step.locator === 'object') {
      for (const k of Object.keys(step.locator)) {
        if (TEMPLATE_LOCATOR_KEYS.has(k) && typeof step.locator[k] === 'string') step.locator[k] = tpl(step.locator[k]);
      }
    }
  }
  return out;
}

export function findParams(steps) {
  const names = new Set();
  mapStrings(steps, (s) => {
    for (const m of s.matchAll(TOKEN_RE)) names.add(m[1]);
    return s;
  });
  return [...names];
}

export function substituteSteps(steps, params = {}) {
  return mapStrings(steps, (s) => s.replace(TOKEN_RE, (all, k) => (Object.hasOwn(params, k) ? String(params[k]) : all)));
}

function describeTarget(step) {
  const loc = step.locator;
  if (loc) {
    const rn = [loc.role, loc.name !== undefined ? JSON.stringify(loc.name) : null].filter(Boolean).join(' ');
    return rn || loc.selector || '';
  }
  if (step.text !== undefined) return [step.role, JSON.stringify(step.text)].filter(Boolean).join(' ');
  return step.selector || '';
}

export function describeStep(step) {
  const bits = [step.do, describeTarget(step)];
  switch (step.do) {
    case 'navigate':
      bits.push(step.url);
      break;
    case 'fill':
    case 'select':
      bits.push('= ' + JSON.stringify(step.value ?? ''));
      break;
    case 'check':
      bits.push(step.checked === false ? '= off' : '= on');
      break;
    case 'press':
      bits.push(step.key);
      break;
    case 'scroll':
      if (step.direction) bits.push(step.direction);
      if (step.amount !== undefined) bits.push(`${step.amount}px`);
      break;
    case 'wait':
      if (step.waitText !== undefined) bits.push('text ' + JSON.stringify(step.waitText));
      if (step.waitSelector !== undefined) bits.push('selector ' + step.waitSelector);
      if (step.ms !== undefined) bits.push(`${step.ms}ms`);
      break;
    default:
      break;
  }
  return bits.filter((b) => b !== undefined && b !== null && b !== '').join(' ');
}

export function createWorkflows({ workflowsDir, recordingPath, now = () => new Date() }) {
  let recording = [];
  if (recordingPath && fs.existsSync(recordingPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(recordingPath, 'utf8'));
      if (Array.isArray(data?.steps)) recording = data.steps;
    } catch (e) {
      logErr(`ignoring unreadable ${recordingPath}: ${e.message}`);
    }
  }

  function persistRecording() {
    if (!recordingPath) return;
    try {
      fs.mkdirSync(path.dirname(recordingPath), { recursive: true });
      fs.writeFileSync(recordingPath, JSON.stringify({ steps: recording }, null, 2) + '\n');
    } catch (e) {
      logErr('cannot write recording:', e.message);
    }
  }

  function fileFor(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new WorkflowError(`invalid workflow name ${JSON.stringify(name ?? '')}: use [a-z0-9-_]+`);
    }
    return path.join(workflowsDir, `${name}.json`);
  }

  function listAll() {
    if (!fs.existsSync(workflowsDir)) return [];
    const out = [];
    for (const f of fs.readdirSync(workflowsDir).sort()) {
      if (!f.endsWith('.json')) continue;
      try {
        const w = JSON.parse(fs.readFileSync(path.join(workflowsDir, f), 'utf8'));
        out.push({ name: w.name || f.slice(0, -5), description: w.description || '', params: w.params || [], steps: w.steps || [] });
      } catch (e) {
        logErr(`skipping unreadable workflow ${f}: ${e.message}`);
      }
    }
    return out;
  }

  function load(name) {
    const file = fileFor(name);
    if (!fs.existsSync(file)) {
      const known = listAll().map((w) => w.name);
      throw new WorkflowError(`no workflow "${name}"` + (known.length ? ` (saved: ${known.join(', ')})` : ' (none saved yet)'));
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  return {
    get recording() {
      return recording;
    },
    reset() {
      const n = recording.length;
      recording = [];
      persistRecording();
      return n;
    },
    // Append successful steps; pairs = [{action, result}] in executed order.
    record(pairs) {
      let added = 0;
      for (const { action, result } of pairs) {
        if (!action || result?.ok === false) continue;
        recording.push(toRecordedStep(action, result || {}));
        added++;
      }
      if (added) persistRecording();
      return added;
    },
    replaceRecording(steps) {
      recording = structuredClone(steps);
      persistRecording();
    },
    save({ name, description, params = {} }) {
      const file = fileFor(name);
      if (!recording.length) throw new WorkflowError('nothing recorded since the last reset — run browser_act steps first');
      for (const k of Object.keys(params)) {
        if (!PARAM_RE.test(k)) throw new WorkflowError(`invalid param name ${JSON.stringify(k)}: use [A-Za-z0-9_-]+`);
      }
      const steps = templateSteps(recording, params);
      const names = [...new Set([...Object.keys(params), ...findParams(steps)])];
      const ts = now().toISOString();
      let createdAt = ts;
      let prevDescription;
      if (fs.existsSync(file)) {
        try {
          const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
          createdAt = prev.createdAt || ts;
          prevDescription = prev.description;
        } catch {
          /* overwrite */
        }
      }
      const wf = { name, description: description ?? prevDescription ?? '', params: names, steps, createdAt, updatedAt: ts };
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(wf, null, 2) + '\n');
      return wf;
    },
    prepareRun(name, params = {}) {
      const wf = load(name);
      const required = [...new Set([...(wf.params || []), ...findParams(wf.steps || [])])];
      const missing = required.filter((k) => typeof params[k] !== 'string');
      if (missing.length) {
        throw new WorkflowError(`workflow "${name}" needs params: ${required.join(', ')} (missing: ${missing.join(', ')})`);
      }
      return { workflow: wf, actions: substituteSteps(wf.steps || [], params) };
    },
    load,
    list: listAll,
    remove(name) {
      const file = fileFor(name);
      if (!fs.existsSync(file)) throw new WorkflowError(`no workflow "${name}"`);
      fs.unlinkSync(file);
    },
  };
}
