import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { getAccountDb } from '#account-db';
import { config } from '#load-config';

import { createTranscript } from './events';
import type { Emit } from './events';
import { buildSystemPrompt } from './prompt';
import { defaultModel, getProvider } from './providers';
import { registerRun, unregisterRun } from './questions';
import { runClaudeCode } from './runtimes/claude-code';
import { allowlistedEnv } from './runtimes/env';
import { runOpenAiCompat } from './runtimes/openai-compat';
import type { HistoryMessage, McpStdioSpec } from './runtimes/types';
import * as store from './store';

export type BudgetFile = { id: string; groupId: string };

export class AiConfigError extends Error {}

/** The file row the client refers to, or null when it is unknown, deleted or encrypted. */
export function lookupBudgetFile(
  fileId: string,
): BudgetFile | 'encrypted' | null {
  const row = getAccountDb().first(
    'SELECT id, group_id, encrypt_keyid, deleted FROM files WHERE id = ?',
    [fileId],
  ) as {
    id: string;
    group_id: string | null;
    encrypt_keyid: string | null;
    deleted: number;
  } | null;
  if (!row || row.deleted || !row.group_id) return null;
  if (row.encrypt_keyid) return 'encrypted';
  return { id: row.id, groupId: row.group_id };
}

export function userDir(userId: string): string {
  const safe = /^[A-Za-z0-9_-]+$/.test(userId)
    ? userId
    : Buffer.from(userId).toString('hex');
  const root =
    process.env.ACTUAL_AI_DATA_DIR ??
    path.join(path.resolve(config.get('dataDir')), 'ai');
  return path.join(root, safe);
}

function serverUrl(): string {
  return (
    process.env.ACTUAL_AI_SERVER_URL ?? `http://127.0.0.1:${config.get('port')}`
  );
}

function resolveMcpEntry(): string {
  if (process.env.ACTUAL_MCP_PATH) return process.env.ACTUAL_MCP_PATH;
  return createRequire(import.meta.url).resolve('@actual-app/mcp');
}

export function buildMcpSpec(options: {
  userId: string;
  sessionToken: string;
  file: BudgetFile;
  askToken: string;
  home: string;
  /** The user opted in to the assistant changing the budget directly. */
  allowWrites?: boolean;
}): McpStdioSpec {
  return {
    command: process.execPath,
    args: [resolveMcpEntry()],
    env: allowlistedEnv(options.home, {
      ACTUAL_SERVER_URL: serverUrl(),
      ACTUAL_SESSION_TOKEN: options.sessionToken,
      ACTUAL_SYNC_ID: options.file.groupId,
      ACTUAL_DATA_DIR: path.join(userDir(options.userId), 'budget'),
      ACTUAL_ASK_URL: `${serverUrl()}/ai/internal/ask`,
      ACTUAL_ASK_TOKEN: options.askToken,
      // Write tools only when the user turned them on in their AI settings;
      // otherwise the assistant can only propose changes.
      ACTUAL_MCP_WRITE: options.allowWrites ? '1' : '0',
    }),
  };
}

/** Earlier turns as plain text, for runtimes that cannot resume a session. */
export function historyFromMessages(
  messages: store.StoredMessage[],
): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (const message of messages.slice(-30)) {
    const text = message.parts
      .map(part => {
        if (part.type === 'text') return part.text;
        if (part.type === 'question') {
          return part.answer
            ? `[I asked: "${part.question}" — the user answered: "${part.answer}"]`
            : `[I asked: "${part.question}" — no answer]`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
    const tools = message.parts
      .filter(part => part.type === 'tool')
      .map(part => (part.type === 'tool' ? part.name : ''));
    const note = tools.length
      ? `\n\n[tools used: ${[...new Set(tools)].join(', ')}]`
      : '';
    if (text || note) history.push({ role: message.role, text: text + note });
  }
  return history;
}

export type TurnInput = {
  userId: string;
  sessionToken: string;
  conversation: store.Conversation;
  file: BudgetFile;
  message: string;
  language?: string | null;
  emit: Emit;
  signal: AbortSignal;
};

/** Runs one user message to completion, streaming events and saving the transcript. */
export async function runChatTurn(input: TurnInput): Promise<void> {
  const settings = store.getSettings(input.userId);
  if (!settings) {
    throw new AiConfigError(
      'Set up your AI assistant first (Settings → AI Assistant).',
    );
  }

  const provider = getProvider(settings.provider);
  const model =
    settings.model || defaultModel(settings.runtime, settings.provider);
  if (settings.runtime === 'claude_code' && !settings.secret) {
    throw new AiConfigError(
      'Your Claude token is missing. Run `claude setup-token` on your computer and paste it in Settings → AI Assistant.',
    );
  }
  if (settings.runtime === 'openai_compat') {
    const baseUrl = settings.baseUrl || provider?.baseUrl;
    if (!baseUrl) {
      throw new AiConfigError(
        'Choose a provider or enter a server URL in Settings → AI Assistant.',
      );
    }
    if (!settings.secret && !provider?.keyOptional) {
      throw new AiConfigError(
        'Your API key is missing. Add it in Settings → AI Assistant.',
      );
    }
    if (!model) {
      throw new AiConfigError('Choose a model in Settings → AI Assistant.');
    }
  }

  const previous = store.getMessages(input.userId, input.conversation.id);
  store.addMessage(input.conversation.id, 'user', [
    { type: 'text', text: input.message },
  ]);
  if (previous.length === 0) {
    store.updateConversation(input.userId, input.conversation.id, {
      title:
        input.message.replace(/\s+/g, ' ').trim().slice(0, 60) ||
        'New conversation',
    });
  }

  const transcript = createTranscript();
  const emit: Emit = event => {
    transcript.push(event);
    input.emit(event);
  };

  const home = path.join(userDir(input.userId), 'home');
  await fs.mkdir(path.join(userDir(input.userId), 'budget'), {
    recursive: true,
  });
  const askToken = registerRun({ userId: input.userId, emit });
  const mcp = buildMcpSpec({
    userId: input.userId,
    sessionToken: input.sessionToken,
    file: input.file,
    askToken,
    home,
    allowWrites: settings.allowWrites,
  });
  const systemPrompt = buildSystemPrompt({
    language: input.language,
    allowWrites: settings.allowWrites,
  });

  let failure: string | null = null;
  try {
    emit({ type: 'status', message: 'Opening your budget…' });
    if (settings.runtime === 'claude_code') {
      const outcome = await runClaudeCode({
        systemPrompt,
        prompt: input.message,
        history: [],
        model,
        mcp,
        signal: input.signal,
        emit,
        token: settings.secret!,
        configDir: path.join(userDir(input.userId), 'claude'),
        homeDir: home,
        resumeSessionId: input.conversation.claudeSessionId,
        bin: process.env.ACTUAL_CLAUDE_BIN,
      });
      if (
        outcome.sessionId &&
        outcome.sessionId !== input.conversation.claudeSessionId
      ) {
        store.updateConversation(input.userId, input.conversation.id, {
          claudeSessionId: outcome.sessionId,
        });
      }
      if (!input.signal.aborted) emit({ type: 'done', usage: outcome.usage });
    } else {
      const outcome = await runOpenAiCompat({
        systemPrompt,
        prompt: input.message,
        history: historyFromMessages(previous),
        model,
        mcp,
        signal: input.signal,
        emit,
        baseUrl: settings.baseUrl || provider!.baseUrl,
        apiKey: settings.secret,
      });
      if (!input.signal.aborted) emit({ type: 'done', usage: outcome.usage });
    }
  } catch (error) {
    if (!input.signal.aborted) {
      failure = error instanceof Error ? error.message : String(error);
      input.emit({ type: 'error', message: failure });
    }
  } finally {
    unregisterRun(askToken);
    const parts = transcript.finish();
    if (input.signal.aborted) parts.push({ type: 'text', text: '_(stopped)_' });
    if (failure) parts.push({ type: 'text', text: `_(error: ${failure})_` });
    if (parts.length) {
      store.addMessage(input.conversation.id, 'assistant', parts);
    }
    store.updateConversation(input.userId, input.conversation.id, {});
  }
}
