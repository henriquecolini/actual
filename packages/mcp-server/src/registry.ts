import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import type { McpConfig } from './config';

export type ToolContext = {
  config: McpConfig;
  /** Pulls the latest changes from the server if the local copy is stale. */
  ensureFresh: () => Promise<void>;
  /** Forces a sync with the server. */
  refresh: () => Promise<void>;
};

type Shape = Record<string, z.ZodType>;

export type ToolDef<S extends Shape = Shape> = {
  name: string;
  description: string;
  shape: S;
  /** Only registered when writes are enabled. */
  write?: boolean;
  handler: (
    args: { [K in keyof S]: z.infer<S[K]> },
    ctx: ToolContext,
  ) => Promise<unknown>;
};

export function defineTool<S extends Shape>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(
    value,
    (_key, val) => (val === null ? undefined : val),
    1,
  );
}

export function registerTools(
  server: McpServer,
  tools: ToolDef[],
  ctx: ToolContext,
) {
  for (const tool of tools) {
    if (tool.write && !ctx.config.allowWrites) continue;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.shape },
      async (args: Record<string, unknown>) => {
        try {
          await ctx.ensureFresh();
          const result = await tool.handler(args ?? {}, ctx);
          return {
            content: [
              {
                type: 'text' as const,
                text: serialize(result ?? { ok: true }),
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },
    );
  }
}
