#!/usr/bin/env node
// Entry: stdio MCP server + WS bridge to the Chrome extension. stdout carries MCP only; logs go to stderr.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createBridge } from './bridge.js';
import { createWorkflows } from './workflows.js';
import { createCallLog, logErr } from './log.js';
import { registerTools, SERVER_INSTRUCTIONS } from './tools.js';

export const VERSION = '0.1.0';

// Builds everything except the transport. Call app.bridge.start() then app.mcp.connect(transport).
export function createApp({ env = process.env, bridgeOptions = {} } = {}) {
  const config = loadConfig(env);
  const bridge = createBridge({
    port: config.port,
    extensionId: config.extensionId,
    token: config.token,
    allowedDomains: config.allowedDomains,
    ...bridgeOptions,
  });
  const workflows = createWorkflows({ workflowsDir: config.workflowsDir, recordingPath: config.recordingPath });
  const callLog = createCallLog(config.logsDir);
  const mcp = new McpServer({ name: 'fast-browser', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const handlers = registerTools(mcp, { bridge, workflows, callLog });
  return {
    config,
    bridge,
    workflows,
    callLog,
    mcp,
    handlers,
    async close() {
      await mcp.close().catch(() => {});
      await bridge.close();
    },
  };
}

export async function main() {
  const app = createApp();
  await app.bridge.start(); // on failure (port busy) tools return the error; the MCP server still starts
  await app.mcp.connect(new StdioServerTransport());
  logErr(`MCP server ready (home ${app.config.home})`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((e) => {
    logErr('fatal:', e);
    process.exit(1);
  });
}
