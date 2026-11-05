import path from 'node:path';

import express from 'express';
import type { Request, Response } from 'express';

import { maskSecret } from './ai/crypto';
import {
  API_PROVIDERS,
  CLAUDE_MODELS,
  defaultModel,
  getProvider,
} from './ai/providers';
import type { RuntimeId } from './ai/providers';
import { askQuestion, isKnownRun, resolveQuestion } from './ai/questions';
import type { AskPayload } from './ai/questions';
import {
  AiConfigError,
  lookupBudgetFile,
  runChatTurn,
  userDir,
} from './ai/runner';
import { testClaudeToken } from './ai/runtimes/claude-code';
import { testOpenAiCompat } from './ai/runtimes/openai-compat';
import * as store from './ai/store';
import * as UserService from './services/user-service';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from './util/middlewares';

const app = express();
export { app as handlers };

app.use(express.json({ limit: '256kb' }));

const MAX_CONCURRENT_RUNS = 4;
const MAX_MESSAGE_LENGTH = 8000;
const activeRuns = new Map<string, AbortController>(); // one per user

function isLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

// --------------------------------------------------- called by the MCP child
// The MCP server has no UI. It posts the model's question here (bearer = the
// run's secret, loopback only) and waits for the person to answer in the chat.
app.post('/internal/ask', async (req, res) => {
  const token = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1];
  if (!isLoopback(req) || !token || !isKnownRun(token)) {
    res.status(401).send({ status: 'error', reason: 'unauthorized' });
    return;
  }
  const body = (req.body ?? {}) as Partial<AskPayload>;
  if (typeof body.question !== 'string' || !body.question.trim()) {
    res.status(400).send({ status: 'error', reason: 'invalid-question' });
    return;
  }
  const closed = new AbortController();
  res.on('close', () => closed.abort());
  const response = await askQuestion(token, {
    question: body.question.slice(0, 1000),
    options: Array.isArray(body.options)
      ? body.options
          .filter(o => typeof o === 'string')
          .slice(0, 8)
          .map(o => o.slice(0, 200))
      : undefined,
    multi: Boolean(body.multi),
    allow_free_text: body.allow_free_text,
    context:
      typeof body.context === 'string' ? body.context.slice(0, 500) : undefined,
  });
  res.send(response);
});

app.use(requestLoggerMiddleware);
app.use(validateSessionMiddleware);

function userId(res: Response): string {
  return res.locals.user_id as string;
}

function sessionToken(req: Request): string {
  const header = req.headers['x-actual-token'];
  return (Array.isArray(header) ? header[0] : header) ?? '';
}

function bad(res: Response, reason: string, status = 400) {
  res.status(status).send({ status: 'error', reason });
}

// ------------------------------------------------------------------ settings

function describeSettings(id: string) {
  const settings = store.getSettings(id);
  return {
    runtime: settings?.runtime ?? 'claude_code',
    provider: settings?.provider ?? null,
    baseUrl: settings?.baseUrl ?? null,
    model: settings?.model ?? null,
    hasSecret: Boolean(settings?.secret),
    secretPreview: settings?.secret ? maskSecret(settings.secret) : null,
    configured: Boolean(settings),
  };
}

app.get('/status', (_req, res) => {
  res.send({
    status: 'ok',
    data: {
      settings: describeSettings(userId(res)),
      providers: API_PROVIDERS,
      claudeModels: CLAUDE_MODELS,
    },
  });
});

function parseSettings(body: Record<string, unknown>) {
  const runtime = body.runtime;
  if (runtime !== 'claude_code' && runtime !== 'openai_compat') return null;
  const text = (value: unknown, max = 500) =>
    typeof value === 'string' && value.trim()
      ? value.trim().slice(0, max)
      : null;
  return {
    runtime: runtime as RuntimeId,
    provider: text(body.provider, 50),
    baseUrl: text(body.baseUrl),
    model: text(body.model, 200),
    secret:
      body.secret === undefined
        ? undefined
        : typeof body.secret === 'string'
          ? body.secret.trim()
          : null,
  };
}

app.put('/settings', (req, res) => {
  const parsed = parseSettings((req.body ?? {}) as Record<string, unknown>);
  if (!parsed) return bad(res, 'invalid-runtime');
  if (parsed.baseUrl && !/^https?:\/\//.test(parsed.baseUrl)) {
    return bad(res, 'invalid-base-url');
  }
  if (
    parsed.runtime === 'openai_compat' &&
    parsed.provider &&
    !getProvider(parsed.provider)
  ) {
    return bad(res, 'unknown-provider');
  }
  store.saveSettings(userId(res), parsed);
  res.send({ status: 'ok', data: describeSettings(userId(res)) });
});

app.post('/settings/test', async (req, res) => {
  const id = userId(res);
  // Test what the form currently holds; a blank secret means "the saved one".
  const parsed = parseSettings((req.body ?? {}) as Record<string, unknown>);
  const saved = store.getSettings(id);
  if (!parsed) return bad(res, 'invalid-runtime');
  const secret = parsed.secret || saved?.secret || null;
  const model = parsed.model || defaultModel(parsed.runtime, parsed.provider);

  if (parsed.runtime === 'claude_code') {
    if (!secret) {
      return res.send({
        status: 'ok',
        data: { ok: false, message: 'Paste your Claude token first.' },
      });
    }
    const base = path.join(userDir(id));
    const result = await testClaudeToken({
      token: secret,
      model,
      configDir: path.join(base, 'claude'),
      homeDir: path.join(base, 'home'),
      bin: process.env.ACTUAL_CLAUDE_BIN,
    });
    return res.send({ status: 'ok', data: result });
  }

  const provider = getProvider(parsed.provider);
  const baseUrl = parsed.baseUrl || provider?.baseUrl;
  if (!baseUrl) {
    return res.send({
      status: 'ok',
      data: { ok: false, message: 'Choose a provider or enter a server URL.' },
    });
  }
  if (!secret && !provider?.keyOptional) {
    return res.send({
      status: 'ok',
      data: { ok: false, message: 'Enter your API key first.' },
    });
  }
  if (!model) {
    return res.send({
      status: 'ok',
      data: { ok: false, message: 'Choose a model.' },
    });
  }
  res.send({
    status: 'ok',
    data: await testOpenAiCompat({ baseUrl, apiKey: secret, model }),
  });
});

// ------------------------------------------------------------- conversations

function requireFile(req: Request, res: Response, fileId: unknown) {
  if (typeof fileId !== 'string' || !fileId) {
    bad(res, 'file-id-required');
    return null;
  }
  if (!UserService.canAccessActiveFile(fileId, userId(res))) {
    bad(res, 'file-access-not-allowed', 403);
    return null;
  }
  return fileId;
}

app.get('/conversations', (req, res) => {
  const fileId = requireFile(req, res, req.query.fileId);
  if (!fileId) return;
  res.send({
    status: 'ok',
    data: store.listConversations(userId(res), fileId),
  });
});

app.post('/conversations', (req, res) => {
  const fileId = requireFile(
    req,
    res,
    (req.body as { fileId?: unknown })?.fileId,
  );
  if (!fileId) return;
  res.send({
    status: 'ok',
    data: store.createConversation(userId(res), fileId),
  });
});

app.get('/conversations/:id', (req, res) => {
  const conversation = store.getConversation(userId(res), req.params.id);
  if (!conversation) return bad(res, 'not-found', 404);
  res.send({
    status: 'ok',
    data: {
      conversation,
      messages: store.getMessages(userId(res), conversation.id),
    },
  });
});

app.delete('/conversations/:id', (req, res) => {
  activeRuns.get(userId(res))?.abort();
  store.deleteConversation(userId(res), req.params.id);
  res.send({ status: 'ok' });
});

app.post('/conversations/:id/stop', (_req, res) => {
  activeRuns.get(userId(res))?.abort();
  res.send({ status: 'ok' });
});

app.post('/questions/:id/answer', (req, res) => {
  const body = (req.body ?? {}) as {
    answer?: unknown;
    selected?: unknown;
    dismiss?: unknown;
  };
  const resolution = body.dismiss
    ? ({ dismiss: true } as const)
    : typeof body.answer === 'string' && body.answer.trim()
      ? {
          answer: body.answer.slice(0, 2000),
          selected: Array.isArray(body.selected)
            ? body.selected.filter((s): s is string => typeof s === 'string')
            : undefined,
        }
      : null;
  if (!resolution) return bad(res, 'answer-required');
  if (!resolveQuestion(userId(res), req.params.id, resolution)) {
    return bad(res, 'question-not-found', 404);
  }
  res.send({ status: 'ok' });
});

// ---------------------------------------------------------------- the chat

app.post('/conversations/:id/chat', async (req, res) => {
  const id = userId(res);
  const body = (req.body ?? {}) as { message?: unknown; language?: unknown };
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return bad(res, 'message-required');
  if (message.length > MAX_MESSAGE_LENGTH) return bad(res, 'message-too-long');

  const conversation = store.getConversation(id, req.params.id);
  if (!conversation) return bad(res, 'not-found', 404);
  if (!UserService.canAccessActiveFile(conversation.fileId, id)) {
    return bad(res, 'file-access-not-allowed', 403);
  }
  const file = lookupBudgetFile(conversation.fileId);
  if (file === 'encrypted') return bad(res, 'encrypted-budget-not-supported');
  if (!file) return bad(res, 'budget-not-synced');

  if (activeRuns.has(id)) return bad(res, 'already-running', 409);
  if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
    return bad(res, 'server-busy', 429);
  }

  const controller = new AbortController();
  activeRuns.set(id, controller);

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (event: unknown) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, 15_000);
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    await runChatTurn({
      userId: id,
      sessionToken: sessionToken(req),
      conversation,
      file,
      message,
      language:
        typeof body.language === 'string' ? body.language.slice(0, 20) : null,
      emit: send,
      signal: controller.signal,
    });
  } catch (error) {
    send({
      type: 'error',
      message:
        error instanceof AiConfigError
          ? error.message
          : `Something went wrong: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    clearInterval(heartbeat);
    activeRuns.delete(id);
    if (!res.writableEnded) res.end();
  }
});

// ------------------------------------------------------- external MCP tokens

app.get('/mcp-tokens', (_req, res) => {
  res.send({ status: 'ok', data: store.listMcpTokens(userId(res)) });
});

app.post('/mcp-tokens', (req, res) => {
  const label = (req.body as { label?: unknown })?.label;
  const created = store.createMcpToken(
    userId(res),
    typeof label === 'string' && label.trim()
      ? label.trim().slice(0, 100)
      : null,
  );
  // The token is shown once; it is a full session for this user.
  res.send({ status: 'ok', data: { id: created.id, token: created.token } });
});

app.delete('/mcp-tokens/:id', (req, res) => {
  if (!store.revokeMcpToken(userId(res), req.params.id)) {
    return bad(res, 'not-found', 404);
  }
  res.send({ status: 'ok' });
});
