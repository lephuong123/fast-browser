// stderr diagnostics (stdout is reserved for MCP) + JSONL call log for metrics.
import fs from 'node:fs';
import path from 'node:path';

export function logErr(...args) {
  try {
    process.stderr.write('[fast-browser] ' + args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ') + '\n');
  } catch {
    /* ignore */
  }
}

export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// entry: {tool, action?, ms, ok, steps?, failedStep?, inChars, outChars}; ts added here.
export function createCallLog(logsDir, { now = () => new Date() } = {}) {
  return {
    dir: logsDir,
    write(entry) {
      try {
        const d = now();
        fs.mkdirSync(logsDir, { recursive: true });
        const line = JSON.stringify({ ts: d.toISOString(), ...entry });
        fs.appendFileSync(path.join(logsDir, `calls-${localDay(d)}.jsonl`), line + '\n');
      } catch (e) {
        logErr('call log write failed:', e.message);
      }
    },
  };
}
