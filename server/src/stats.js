#!/usr/bin/env node
// Prints per-day call stats from $FB_HOME/logs/calls-YYYY-MM-DD.jsonl.
// Usage: node src/stats.js [YYYY-MM-DD ...]   (no args = all days)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fbHome } from './config.js';

const FILE_RE = /^calls-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function readLogs(logsDir, days = []) {
  if (!fs.existsSync(logsDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(logsDir).sort()) {
    const m = FILE_RE.exec(f);
    if (!m || (days.length && !days.includes(m[1]))) continue;
    const entries = [];
    for (const line of fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* skip bad line */
      }
    }
    out.push({ day: m[1], entries });
  }
  return out;
}

export function summarize(entries) {
  const byTool = new Map();
  for (const e of entries) {
    const t = byTool.get(e.tool) || { tool: e.tool, calls: 0, totalMs: 0, failures: 0, steps: 0 };
    t.calls++;
    t.totalMs += Number(e.ms) || 0;
    if (!e.ok) t.failures++;
    t.steps += Number(e.steps) || 0;
    byTool.set(e.tool, t);
  }
  const tools = [...byTool.values()]
    .sort((a, b) => b.calls - a.calls)
    .map((t) => ({ ...t, avgMs: t.calls ? Math.round(t.totalMs / t.calls) : 0, failureRate: t.calls ? t.failures / t.calls : 0 }));
  const calls = entries.length;
  const failures = entries.filter((e) => !e.ok).length;
  const totalMs = entries.reduce((n, e) => n + (Number(e.ms) || 0), 0);
  return {
    calls,
    failures,
    avgMs: calls ? Math.round(totalMs / calls) : 0,
    failureRate: calls ? failures / calls : 0,
    outChars: entries.reduce((n, e) => n + (Number(e.outChars) || 0), 0),
    tools,
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

export function formatStats(days) {
  if (!days.length) return 'no call logs yet';
  const lines = [];
  for (const { day, entries } of days) {
    const s = summarize(entries);
    lines.push(`${day}  calls ${s.calls}  avg ${s.avgMs}ms  fail ${pct(s.failureRate)}  outChars ${s.outChars}`);
    for (const t of s.tools) {
      lines.push(`  ${t.tool.padEnd(20)} ${String(t.calls).padStart(5)} calls  avg ${String(t.avgMs).padStart(6)}ms  fail ${pct(t.failureRate).padStart(6)}${t.steps ? `  steps ${t.steps}` : ''}`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const logsDir = path.join(fbHome(), 'logs');
  process.stdout.write(formatStats(readLogs(logsDir, process.argv.slice(2))) + '\n');
}
