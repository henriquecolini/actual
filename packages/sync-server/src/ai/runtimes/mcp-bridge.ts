import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { McpStdioSpec } from './types';

/** Connects the built-in agent loop to our MCP server and exposes its tools. */

export type BridgedTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolOutput = { text: string; isError: boolean };

/** Long enough for ask_user, which waits for a person. */
const CALL_TIMEOUT_MS = 20 * 60 * 1000;

export function toolParameters(schema: unknown): Record<string, unknown> {
  const base: Record<string, unknown> =
    schema && typeof schema === 'object'
      ? { ...(schema as Record<string, unknown>) }
      : { type: 'object', properties: {} };
  // Some providers reject JSON-schema meta keys.
  delete base.$schema;
  return base;
}

export class McpBridge {
  private client: Client;
  tools: BridgedTool[] = [];

  private constructor(client: Client) {
    this.client = client;
  }

  static async connect(spec: McpStdioSpec): Promise<McpBridge> {
    const client = new Client({ name: 'actual-assistant', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: spec.env,
        stderr: 'ignore',
      }),
    );
    const bridge = new McpBridge(client);
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools) {
        bridge.tools.push({
          name: tool.name,
          description: (tool.description ?? '').slice(0, 4000),
          parameters: toolParameters(tool.inputSchema),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return bridge;
  }

  has(name: string): boolean {
    return this.tools.some(tool => tool.name === name);
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolOutput> {
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      {
        timeout: CALL_TIMEOUT_MS,
        signal,
      },
    );
    const parts = (result.content ?? []) as { type: string; text?: string }[];
    const text = parts
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n');
    return {
      text: text || (result.isError ? 'Tool failed' : 'ok'),
      isError: Boolean(result.isError),
    };
  }

  async close() {
    await this.client.close().catch(() => undefined);
  }
}
