import type { Emit } from '#ai/events';

export type McpStdioSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type HistoryMessage = { role: 'user' | 'assistant'; text: string };

export type RunInput = {
  systemPrompt: string;
  /** The new user message. */
  prompt: string;
  /** Earlier turns, for runtimes without session resume. */
  history: HistoryMessage[];
  model: string;
  /** Our MCP server, started by the runtime. */
  mcp: McpStdioSpec;
  signal: AbortSignal;
  emit: Emit;
};

export type RunOutcome = {
  /** Claude Code session to resume next turn. */
  sessionId?: string;
  usage?: { totalTokens?: number; costUsd?: number | null };
};
