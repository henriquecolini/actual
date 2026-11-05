// Mirrors packages/sync-server/src/ai (events, stored messages, settings).

export type AiEvent =
  | { type: 'status'; message: string }
  | { type: 'text_delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; text: string; isError: boolean }
  | {
      type: 'question';
      id: string;
      question: string;
      options?: string[];
      multi: boolean;
      allowFreeText: boolean;
      context?: string;
    }
  | {
      type: 'question_resolved';
      id: string;
      answer?: string;
      dismissed?: boolean;
    }
  | { type: 'done'; usage?: { totalTokens?: number; costUsd?: number | null } }
  | { type: 'error'; message: string };

export type ToolPart = {
  type: 'tool';
  id: string;
  name: string;
  input: unknown;
  result?: { text: string; isError: boolean };
};

export type QuestionPart = {
  type: 'question';
  id: string;
  question: string;
  options?: string[];
  multi: boolean;
  allowFreeText?: boolean;
  context?: string;
  answer?: string;
  dismissed?: boolean;
};

export type TextPart = {
  type: 'text';
  text: string;
  /** Still being written. Client-only. */
  streaming?: boolean;
};

export type MessagePart = TextPart | ToolPart | QuestionPart;

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
};

export type Conversation = {
  id: string;
  fileId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type RuntimeId = 'claude_code' | 'openai_compat';

export type AiSettings = {
  runtime: RuntimeId;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  hasSecret: boolean;
  secretPreview: string | null;
  configured: boolean;
  allowWrites: boolean;
};

export type ApiProvider = {
  id: string;
  label: string;
  baseUrl: string;
  needsBaseUrl?: boolean;
  keyOptional?: boolean;
  keyUrl?: string;
  models: string[];
};

export type AiStatus = {
  settings: AiSettings;
  providers: ApiProvider[];
  claudeModels: string[];
};

export type McpTokenInfo = {
  id: string;
  label: string | null;
  createdAt: number;
};
