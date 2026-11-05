import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpConfig } from './config';
import type { Connection } from './connection';
import { registerTools } from './registry';
import type { ToolDef } from './registry';
import { analysisTools } from './tools/analysis';
import { createAskUserTool } from './tools/interactive';
import { proposalTools } from './tools/proposals';
import { readTools } from './tools/read';
import { writeTools } from './tools/write';

export type ServerOptions = {
  config: McpConfig;
  connection: Pick<Connection, 'ensureFresh' | 'refresh'>;
  /** Host callback for ask_user. Omit when no UI is attached. */
  ask?: { endpoint: string; token: string };
};

export function buildTools(options: ServerOptions): ToolDef[] {
  return [
    ...readTools,
    ...analysisTools,
    ...proposalTools,
    ...(options.ask
      ? [createAskUserTool(options.ask.endpoint, options.ask.token)]
      : []),
    ...writeTools,
  ];
}

export function createServer(options: ServerOptions): McpServer {
  const server = new McpServer({ name: 'actual-budget', version: '1.0.0' });
  registerTools(server, buildTools(options), {
    config: options.config,
    ensureFresh: options.connection.ensureFresh,
    refresh: options.connection.refresh,
  });
  return server;
}
