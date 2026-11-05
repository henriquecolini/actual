import { send } from '@actual-app/core/platform/client/connection';

import type {
  AiEvent,
  AiSettings,
  AiStatus,
  ChatMessage,
  Conversation,
  McpTokenInfo,
  MessagePart,
  RuntimeId,
} from './types';

/** A failed call to the server's /ai endpoints. `reason` is the server's machine-readable code. */
export class AiApiError extends Error {
  reason: string;
  status: number;
  constructor(reason: string, status: number) {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}

async function connection(): Promise<{ url: string; token: string }> {
  const [url, token] = await Promise.all([
    send('get-server-url'),
    send('get-user-token'),
  ]);
  if (!url || !token) {
    throw new AiApiError('not-connected', 0);
  }
  return { url: url.replace(/\/$/, ''), token };
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const { url, token } = await connection();
  return fetch(`${url}/ai${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-actual-token': token,
      ...(init.headers ?? {}),
    },
  });
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await call(path, init);
  const body = (await response.json().catch(() => null)) as {
    status?: string;
    reason?: string;
    data?: T;
  } | null;
  if (!response.ok || body?.status === 'error') {
    throw new AiApiError(body?.reason ?? 'request-failed', response.status);
  }
  return body?.data as T;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
});

export type SettingsInput = {
  runtime: RuntimeId;
  provider?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  /** Omit to keep the saved secret; '' clears it. */
  secret?: string;
  /** Omit to keep the saved choice. */
  allowWrites?: boolean;
};

export const aiApi = {
  status: () => json<AiStatus>('/status'),
  saveSettings: (input: SettingsInput) =>
    json<AiSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  testSettings: (input: SettingsInput) =>
    json<{ ok: boolean; message: string }>('/settings/test', post(input)),

  listConversations: (fileId: string) =>
    json<Conversation[]>(`/conversations?fileId=${encodeURIComponent(fileId)}`),
  createConversation: (fileId: string) =>
    json<Conversation>('/conversations', post({ fileId })),
  getConversation: (id: string) =>
    json<{
      conversation: Conversation;
      messages: {
        id: number;
        role: 'user' | 'assistant';
        parts: MessagePart[];
      }[];
    }>(`/conversations/${id}`),
  deleteConversation: (id: string) =>
    json<void>(`/conversations/${id}`, { method: 'DELETE' }),
  stop: (id: string) => json<void>(`/conversations/${id}/stop`, post({})),

  answerQuestion: (
    id: string,
    resolution: { answer: string; selected?: string[] } | { dismiss: true },
  ) => json<void>(`/questions/${id}/answer`, post(resolution)),

  listMcpTokens: () => json<McpTokenInfo[]>('/mcp-tokens'),
  createMcpToken: (label: string) =>
    json<{ id: string; token: string }>('/mcp-tokens', post({ label })),
  revokeMcpToken: (id: string) =>
    json<void>(`/mcp-tokens/${id}`, { method: 'DELETE' }),
};

/** Sends a message and reports each server-sent event until the run ends. */
export async function streamChat(
  conversationId: string,
  message: string,
  language: string,
  onEvent: (event: AiEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await call(`/conversations/${conversationId}/chat`, {
    ...post({ message, language }),
    signal,
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as {
      reason?: string;
    } | null;
    throw new AiApiError(body?.reason ?? 'request-failed', response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split('\n').find(line => line.startsWith('data: '));
      if (data) onEvent(JSON.parse(data.slice(6)) as AiEvent);
    }
  }
}

export function toChatMessages(
  stored: { id: number; role: 'user' | 'assistant'; parts: MessagePart[] }[],
): ChatMessage[] {
  return stored.map(message => ({
    id: String(message.id),
    role: message.role,
    parts: message.parts,
  }));
}
