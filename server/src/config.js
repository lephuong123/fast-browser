// Config: $FB_HOME/config.json (created with defaults on first run) + env overrides.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logErr } from './log.js';

export const DEFAULT_CONFIG = Object.freeze({
  port: 17890,
  allowedDomains: ['creativeforce.io', 'creativeforce-dev.io', 'atlassian.net', 'atlassian.com', 'localhost', '127.0.0.1'],
});

// ID of the unpacked extension, pinned by the `key` in extension/manifest.json. The bridge only accepts this
// origin unless FB_EXTENSION_ID / config.extensionId says otherwise ("*" = any extension, not recommended).
export const DEFAULT_EXTENSION_ID = 'biombhedndgmjlfaklonbecohcobfndd';

/** Shared secret for the server<->extension handshake: $FB_HOME/token, created on first run. */
export function loadToken(home) {
  const tokenPath = path.join(home, 'token');
  try {
    const t = fs.readFileSync(tokenPath, 'utf8').trim();
    if (/^[0-9a-f]{32,}$/i.test(t)) return { token: t, tokenPath };
    if (t) logErr(`ignoring malformed ${tokenPath}; generating a new token`);
  } catch {
    /* missing */
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  return { token, tokenPath };
}

export function fbHome(env = process.env) {
  return env.FB_HOME ? path.resolve(env.FB_HOME) : path.join(os.homedir(), '.fast-browser');
}

function parsePort(value, source) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid port ${JSON.stringify(value)} from ${source}`);
  return n;
}

function normDomains(list) {
  return [...new Set((list || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
}

export function loadConfig(env = process.env) {
  const home = fbHome(env);
  fs.mkdirSync(home, { recursive: true });
  const configPath = path.join(home, 'config.json');
  let file = {};
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  } else {
    try {
      file = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
    } catch (e) {
      logErr(`cannot parse ${configPath} (${e.message}); using defaults`);
    }
  }
  const merged = { ...DEFAULT_CONFIG, ...file };
  const port = env.FB_PORT !== undefined && env.FB_PORT !== '' ? parsePort(env.FB_PORT, 'FB_PORT') : parsePort(merged.port, configPath);
  const allowedDomains = env.FB_ALLOWED_DOMAINS !== undefined && env.FB_ALLOWED_DOMAINS !== ''
    ? normDomains(env.FB_ALLOWED_DOMAINS.split(','))
    : normDomains(merged.allowedDomains);
  const rawId = env.FB_EXTENSION_ID || merged.extensionId || DEFAULT_EXTENSION_ID;
  const extensionId = rawId === '*' ? null : rawId;
  const { token, tokenPath } = loadToken(home);
  return {
    home,
    configPath,
    port,
    allowedDomains,
    extensionId,
    token,
    tokenPath,
    workflowsDir: path.join(home, 'workflows'),
    logsDir: path.join(home, 'logs'),
    recordingPath: path.join(home, 'recording.json'),
  };
}
