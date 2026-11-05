import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getAccountDb } from './account-db';
import { handlers } from './app-ai';

// genericAdmin / genericUser sessions come from vitest.globalSetup.js.
const ADMIN = { 'x-actual-token': 'valid-token' };
const USER = { 'x-actual-token': 'valid-token-user' };

const FILE_ID = 'ai-test-file';
const GROUP_ID = 'ai-test-group';

const here = path.dirname(fileURLToPath(import.meta.url));

type SseEvent = Record<string, unknown> & { type: string };

// eslint-disable-next-line typescript/no-explicit-any -- test helper reading untyped API JSON
const json = async (response: Response): Promise<any> => response.json();

/** Reads a server-sent-event response, calling `onEvent` for each event. */
async function readStream(
  response: Response,
  onEvent: (event: SseEvent) => Promise<void> | void,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const decoder = new TextDecoder();
  const reader = response.body!.getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split('\n').find(l => l.startsWith('data: '));
      if (data) {
        const event = JSON.parse(data.slice(6)) as SseEvent;
        events.push(event);
        await onEvent(event);
      }
    }
  }
  return events;
}

describe('AI assistant API', () => {
  beforeAll(() => {
    const db = getAccountDb();
    db.mutate('DELETE FROM files WHERE id = ?', [FILE_ID]);
    db.mutate(
      'INSERT INTO files (id, group_id, deleted, owner) VALUES (?, ?, 0, ?)',
      [FILE_ID, GROUP_ID, 'genericAdmin'],
    );
  });

  afterAll(() => {
    const db = getAccountDb();
    db.mutate('DELETE FROM files WHERE id = ?', [FILE_ID]);
    db.mutate('DELETE FROM ai_messages');
    db.mutate('DELETE FROM ai_conversations');
    db.mutate('DELETE FROM ai_settings');
    db.mutate('DELETE FROM ai_mcp_tokens');
    db.mutate("DELETE FROM sessions WHERE auth_method = 'mcp-token'");
  });

  it('requires a session', async () => {
    const response = await request(handlers).get('/status');
    expect(response.status).toBe(401);
  });

  describe('settings', () => {
    it('stores the secret encrypted and never returns it', async () => {
      const put = await request(handlers)
        .put('/settings')
        .set(ADMIN)
        .send({
          runtime: 'openai_compat',
          provider: 'deepseek',
          model: 'deepseek-chat',
          secret: 'sk-abcdefghijklmnop',
        })
        .expect(200);
      expect(put.body.data).toMatchObject({
        runtime: 'openai_compat',
        provider: 'deepseek',
        hasSecret: true,
        secretPreview: 'sk-abc…mnop',
      });
      expect(JSON.stringify(put.body)).not.toContain('sk-abcdefghijklmnop');

      const row = getAccountDb().first(
        'SELECT secret_enc FROM ai_settings WHERE user_id = ?',
        ['genericAdmin'],
      ) as { secret_enc: string };
      expect(row.secret_enc.startsWith('v1:')).toBe(true);
      expect(row.secret_enc).not.toContain('abcdefghijklmnop');
    });

    it('keeps the secret when it is omitted, and clears it when emptied', async () => {
      await request(handlers)
        .put('/settings')
        .set(ADMIN)
        .send({
          runtime: 'openai_compat',
          provider: 'deepseek',
          model: 'deepseek-reasoner',
        })
        .expect(200);
      let status = await request(handlers)
        .get('/status')
        .set(ADMIN)
        .expect(200);
      expect(status.body.data.settings).toMatchObject({
        hasSecret: true,
        model: 'deepseek-reasoner',
      });

      await request(handlers)
        .put('/settings')
        .set(ADMIN)
        .send({ runtime: 'openai_compat', provider: 'deepseek', secret: '' })
        .expect(200);
      status = await request(handlers).get('/status').set(ADMIN).expect(200);
      expect(status.body.data.settings.hasSecret).toBe(false);
    });

    it('is per user', async () => {
      const status = await request(handlers)
        .get('/status')
        .set(USER)
        .expect(200);
      expect(status.body.data.settings).toMatchObject({
        configured: false,
        hasSecret: false,
      });
    });

    it('validates input and lists provider presets', async () => {
      await request(handlers)
        .put('/settings')
        .set(ADMIN)
        .send({ runtime: 'nope' })
        .expect(400);
      await request(handlers)
        .put('/settings')
        .set(ADMIN)
        .send({
          runtime: 'openai_compat',
          provider: 'custom',
          baseUrl: 'ftp://x',
        })
        .expect(400);
      await request(handlers)
        .put('/settings')
        .set(ADMIN)
        .send({ runtime: 'openai_compat', provider: 'unknown' })
        .expect(400);
      const status = await request(handlers)
        .get('/status')
        .set(ADMIN)
        .expect(200);
      const ids = status.body.data.providers.map((p: { id: string }) => p.id);
      expect(ids).toEqual(
        expect.arrayContaining(['openrouter', 'deepseek', 'openai', 'custom']),
      );
    });
  });

  describe('conversations', () => {
    it('are scoped to the owner and to files they can access', async () => {
      const created = await request(handlers)
        .post('/conversations')
        .set(ADMIN)
        .send({ fileId: FILE_ID })
        .expect(200);
      const id = created.body.data.id as string;

      expect(
        (
          await request(handlers)
            .get(`/conversations?fileId=${FILE_ID}`)
            .set(ADMIN)
            .expect(200)
        ).body.data,
      ).toHaveLength(1);
      await request(handlers)
        .get(`/conversations/${id}`)
        .set(ADMIN)
        .expect(200);

      // Another user: cannot see, read or delete it, and cannot use the file.
      await request(handlers).get(`/conversations/${id}`).set(USER).expect(404);
      await request(handlers)
        .post('/conversations')
        .set(USER)
        .send({ fileId: FILE_ID })
        .expect(403);
      await request(handlers)
        .get(`/conversations?fileId=${FILE_ID}`)
        .set(USER)
        .expect(403);
      await request(handlers)
        .delete(`/conversations/${id}`)
        .set(USER)
        .expect(200);
      await request(handlers)
        .get(`/conversations/${id}`)
        .set(ADMIN)
        .expect(200);

      await request(handlers)
        .delete(`/conversations/${id}`)
        .set(ADMIN)
        .expect(200);
      await request(handlers)
        .get(`/conversations/${id}`)
        .set(ADMIN)
        .expect(404);
    });

    it('rejects unknown files', async () => {
      const missing = await request(handlers)
        .post('/conversations')
        .set(ADMIN)
        .send({ fileId: 'missing' });
      const none = await request(handlers)
        .post('/conversations')
        .set(ADMIN)
        .send({});
      expect([missing.status, none.status]).toEqual([403, 400]);
    });
  });

  describe('external MCP tokens', () => {
    it('creates a never-expiring session, lists it without the token, and revokes it', async () => {
      const created = await request(handlers)
        .post('/mcp-tokens')
        .set(ADMIN)
        .send({ label: 'laptop' })
        .expect(200);
      const { id, token } = created.body.data as { id: string; token: string };
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      const session = getAccountDb().first(
        'SELECT user_id, expires_at FROM sessions WHERE token = ?',
        [token],
      ) as { user_id: string; expires_at: number };
      expect(session).toEqual({ user_id: 'genericAdmin', expires_at: -1 });

      const list = await request(handlers)
        .get('/mcp-tokens')
        .set(ADMIN)
        .expect(200);
      expect(list.body.data).toEqual([
        expect.objectContaining({ id, label: 'laptop' }),
      ]);
      expect(JSON.stringify(list.body)).not.toContain(token);

      // The token authenticates as its owner.
      await request(handlers)
        .get('/status')
        .set({ 'x-actual-token': token })
        .expect(200);
      // Other users cannot revoke it.
      await request(handlers).delete(`/mcp-tokens/${id}`).set(USER).expect(404);

      await request(handlers)
        .delete(`/mcp-tokens/${id}`)
        .set(ADMIN)
        .expect(200);
      await request(handlers)
        .get('/status')
        .set({ 'x-actual-token': token })
        .expect(401);
    });
  });

  describe('ask_user callback', () => {
    it('only accepts a known run secret', async () => {
      const anonymous = await request(handlers)
        .post('/internal/ask')
        .send({ question: 'x' });
      const unknown = await request(handlers)
        .post('/internal/ask')
        .set('authorization', 'Bearer nope')
        .send({ question: 'x' });
      expect([anonymous.status, unknown.status]).toEqual([401, 401]);
    });
  });

  describe('chat', () => {
    it('refuses to run before the assistant is configured', async () => {
      getAccountDb().mutate('DELETE FROM ai_settings WHERE user_id = ?', [
        'genericAdmin',
      ]);
      const { body } = await request(handlers)
        .post('/conversations')
        .set(ADMIN)
        .send({ fileId: FILE_ID });
      const wrapper = express().use('/ai', handlers);
      const server = wrapper.listen(0);
      const port = (server.address() as AddressInfo).port;
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/ai/conversations/${body.data.id}/chat`,
          {
            method: 'POST',
            headers: { ...ADMIN, 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'hello' }),
          },
        );
        const events = await readStream(response, () => undefined);
        expect(events.at(-1)).toMatchObject({ type: 'error' });
        expect(String(events.at(-1)?.message)).toContain(
          'Set up your AI assistant',
        );
      } finally {
        server.close();
      }
    });

    it('rejects empty messages and unknown conversations', async () => {
      const unknown = await request(handlers)
        .post('/conversations/nope/chat')
        .set(ADMIN)
        .send({ message: 'hi' });
      const { body } = await request(handlers)
        .post('/conversations')
        .set(ADMIN)
        .send({ fileId: FILE_ID });
      const empty = await request(handlers)
        .post(`/conversations/${body.data.id}/chat`)
        .set(ADMIN)
        .send({ message: '   ' });
      expect([unknown.status, empty.status]).toEqual([404, 400]);
    });
  });
});

describe('end to end: model → MCP tool → ask_user → answer → reply', () => {
  let modelServer: http.Server;
  let appServer: http.Server;
  let appUrl: string;
  let modelUrl: string;
  let dataDir: string;
  const received: { auth?: string; models: string[] } = { models: [] };

  // A scripted OpenAI-compatible model: call `echo`, then ask the user, then answer.
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-e2e-'));
    process.env.ACTUAL_AI_DATA_DIR = dataDir;
    process.env.ACTUAL_MCP_PATH = path.join(
      here,
      'ai/test-fixtures/fake-mcp.mjs',
    );

    modelServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as {
          model: string;
          messages: { role: string; content?: string; tool_calls?: unknown }[];
        };
        received.auth = req.headers.authorization;
        received.models.push(body.model);
        const toolMessages = body.messages.filter(m => m.role === 'tool');
        const sse = (data: unknown) =>
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        res.writeHead(200, { 'content-type': 'text/event-stream' });

        const toolCall = (id: string, name: string, args: unknown) =>
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id,
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });

        if (toolMessages.length === 0) {
          sse({
            choices: [
              { delta: { content: 'Let me check. ' }, finish_reason: null },
            ],
          });
          toolCall('call_echo', 'echo', { text: 'hi' });
        } else if (toolMessages.length === 1) {
          toolCall('call_ask', 'ask_user', {
            question: 'Which category?',
            options: ['Food', 'Rent'],
          });
        } else {
          const answer = JSON.parse(toolMessages[1].content ?? '{}')
            .answer as string;
          sse({
            choices: [
              {
                delta: { content: `Great, using ${answer}.` },
                finish_reason: 'stop',
              },
            ],
          });
        }
        sse({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { total_tokens: 7 },
        });
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>(resolve =>
      modelServer.listen(0, '127.0.0.1', resolve),
    );
    modelUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;

    appServer = express().use('/ai', handlers).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => appServer.once('listening', resolve));
    appUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
    process.env.ACTUAL_AI_SERVER_URL = appUrl;

    const db = getAccountDb();
    db.mutate('DELETE FROM files WHERE id = ?', [FILE_ID]);
    db.mutate(
      'INSERT INTO files (id, group_id, deleted, owner) VALUES (?, ?, 0, ?)',
      [FILE_ID, GROUP_ID, 'genericAdmin'],
    );
  });

  afterAll(async () => {
    modelServer.close();
    appServer.close();
    delete process.env.ACTUAL_AI_DATA_DIR;
    delete process.env.ACTUAL_MCP_PATH;
    delete process.env.ACTUAL_AI_SERVER_URL;
    fs.rmSync(dataDir, { recursive: true, force: true });
    const db = getAccountDb();
    db.mutate('DELETE FROM files WHERE id = ?', [FILE_ID]);
    db.mutate('DELETE FROM ai_messages');
    db.mutate('DELETE FROM ai_conversations');
    db.mutate('DELETE FROM ai_settings');
  });

  const api = (p: string, init: RequestInit = {}) =>
    fetch(`${appUrl}/ai${p}`, {
      ...init,
      headers: {
        ...ADMIN,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

  const createConversation = async () =>
    (
      await json(
        await api('/conversations', {
          method: 'POST',
          body: JSON.stringify({ fileId: FILE_ID }),
        }),
      )
    ).data;

  it('streams the whole exchange, asks a question, and saves the transcript', async () => {
    await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        runtime: 'openai_compat',
        provider: 'custom',
        baseUrl: modelUrl,
        model: 'test-model',
        secret: 'sk-test',
      }),
    });
    const conversation = await createConversation();

    const response = await api(`/conversations/${conversation.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: 'Help me categorize' }),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const events = await readStream(response, async event => {
      if (event.type === 'question') {
        // The person taps an option in the chat.
        const answered = await api(`/questions/${String(event.id)}/answer`, {
          method: 'POST',
          body: JSON.stringify({ answer: 'Food', selected: ['Food'] }),
        });
        expect(answered.status).toBe(200);
      }
    });

    const types = events.map(e => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'text_delta',
        'tool_use',
        'tool_result',
        'question',
        'question_resolved',
        'text',
        'done',
      ]),
    );
    expect(types).not.toContain('error');

    const question = events.find(e => e.type === 'question')!;
    expect(question).toMatchObject({
      question: 'Which category?',
      options: ['Food', 'Rent'],
      multi: false,
      allowFreeText: false,
    });
    const echo = events.find(
      e => e.type === 'tool_result' && e.id === 'call_echo',
    )!;
    expect(echo).toMatchObject({ text: 'echo:hi', isError: false });
    expect(events.filter(e => e.type === 'text').at(-1)).toMatchObject({
      text: 'Great, using Food.',
    });

    // The provider got the user's key and model.
    expect(received.auth).toBe('Bearer sk-test');
    expect(new Set(received.models)).toEqual(new Set(['test-model']));

    // Transcript and title were saved.
    const saved = (await json(await api(`/conversations/${conversation.id}`)))
      .data;
    expect(saved.conversation.title).toBe('Help me categorize');
    expect(saved.messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
    const parts = saved.messages[1].parts as {
      type: string;
      name?: string;
      answer?: string;
      text?: string;
    }[];
    expect(parts.map(p => p.type)).toEqual([
      'text',
      'tool',
      'tool',
      'question',
      'text',
    ]);
    expect(parts.find(p => p.type === 'question')).toMatchObject({
      answer: 'Food',
    });
    expect(parts.at(-1)).toMatchObject({ text: 'Great, using Food.' });
  });

  it('stops a run when the client disconnects, and allows a new one', async () => {
    const conversation = await createConversation();
    const controller = new AbortController();
    const response = await api(`/conversations/${conversation.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: 'Another' }),
      signal: controller.signal,
    });
    // Wait for the question (the run is now blocked on a person), then walk away.
    await readStream(response, event => {
      if (event.type === 'question') controller.abort();
    }).catch(() => undefined);

    // The server releases the user's slot once the abort propagates.
    let status = 0;
    for (let i = 0; i < 40 && status !== 200; i++) {
      await new Promise(r => setTimeout(r, 100));
      const retry = await api(`/conversations/${conversation.id}/chat`, {
        method: 'POST',
        body: JSON.stringify({ message: 'Again' }),
      });
      status = retry.status;
      if (status === 200) {
        // Answer so this run can finish cleanly.
        await readStream(retry, async e => {
          if (e.type === 'question') {
            await api(`/questions/${String(e.id)}/answer`, {
              method: 'POST',
              body: JSON.stringify({ answer: 'Rent' }),
            });
          }
        });
      }
    }
    expect(status).toBe(200);
  });
});

describe('Claude subscription runtime (with a fake claude CLI)', () => {
  let appServer: http.Server;
  let appUrl: string;
  let dataDir: string;
  let stateDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-claude-'));
    process.env.ACTUAL_AI_DATA_DIR = dataDir;
    process.env.ACTUAL_MCP_PATH = path.join(
      here,
      'ai/test-fixtures/fake-mcp.mjs',
    );
    const fake = path.join(here, 'ai/test-fixtures/fake-claude.mjs');
    fs.chmodSync(fake, 0o755);
    process.env.ACTUAL_CLAUDE_BIN = fake;
    // Neither of these may reach the agent process.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-must-not-leak';
    process.env.SECRET_SERVER_VAR = 'server-secret';

    appServer = express().use('/ai', handlers).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => appServer.once('listening', resolve));
    appUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
    process.env.ACTUAL_AI_SERVER_URL = appUrl;
    stateDir = path.join(dataDir, 'genericAdmin', 'claude');

    const db = getAccountDb();
    db.mutate('DELETE FROM files WHERE id = ?', [FILE_ID]);
    db.mutate(
      'INSERT INTO files (id, group_id, deleted, owner) VALUES (?, ?, 0, ?)',
      [FILE_ID, GROUP_ID, 'genericAdmin'],
    );
  });

  afterAll(() => {
    appServer.close();
    for (const key of [
      'ACTUAL_AI_DATA_DIR',
      'ACTUAL_MCP_PATH',
      'ACTUAL_CLAUDE_BIN',
      'ANTHROPIC_API_KEY',
      'SECRET_SERVER_VAR',
      'ACTUAL_AI_SERVER_URL',
    ]) {
      delete process.env[key];
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    const db = getAccountDb();
    db.mutate('DELETE FROM files WHERE id = ?', [FILE_ID]);
    db.mutate('DELETE FROM ai_messages');
    db.mutate('DELETE FROM ai_conversations');
    db.mutate('DELETE FROM ai_settings');
  });

  const api = (p: string, init: RequestInit = {}) =>
    fetch(`${appUrl}/ai${p}`, {
      ...init,
      headers: {
        ...ADMIN,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  const invocation = (n: number) =>
    JSON.parse(
      fs.readFileSync(path.join(stateDir, `invocation-${n}.json`), 'utf8'),
    );
  const chat = async (conversationId: string, message: string) =>
    readStream(
      await api(`/conversations/${conversationId}/chat`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      }),
      () => undefined,
    );

  it('runs the CLI with the user token only, locked to our MCP server, and resumes the session', async () => {
    await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        runtime: 'claude_code',
        model: 'sonnet',
        secret: 'sk-ant-oat01-usertoken',
      }),
    });
    const created = await json(
      await api('/conversations', {
        method: 'POST',
        body: JSON.stringify({ fileId: FILE_ID }),
      }),
    );
    const conversationId = created.data.id as string;

    const events = await chat(conversationId, 'What did I spend on food?');
    expect(events.map(e => e.type)).toEqual(
      expect.arrayContaining([
        'text_delta',
        'text',
        'tool_use',
        'tool_result',
        'done',
      ]),
    );
    expect(events.find(e => e.type === 'tool_use')).toMatchObject({
      id: 'tu1',
      name: 'get_overview',
    });
    expect(events.find(e => e.type === 'tool_result')).toMatchObject({
      id: 'tu1',
      text: '{"ok":true}',
    });
    expect(events.at(-1)?.type).toBe('done');

    const first = invocation(1);
    expect(first.stdin).toBe('What did I spend on food?');
    expect(first.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-usertoken');
    // Billing and server secrets must not reach the agent.
    expect(first.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(first.env.SECRET_SERVER_VAR).toBeUndefined();
    expect(first.env.HOME).toContain('genericAdmin');
    expect(first.args).toEqual(
      expect.arrayContaining([
        '--strict-mcp-config',
        '--allowedTools',
        'mcp__actual',
        '--session-id',
        '--model',
        'sonnet',
      ]),
    );
    expect(first.args[first.args.indexOf('--tools') + 1]).toBe('');
    expect(first.args[first.args.indexOf('--setting-sources') + 1]).toBe('');
    // The system prompt carries the assistant's rules.
    expect(
      first.args[first.args.indexOf('--append-system-prompt') + 1],
    ).toContain('propose');

    // Our MCP server, with the session token and no write access.
    const server = first.mcpConfig.mcpServers.actual;
    expect(server.type).toBe('stdio');
    expect(server.env).toMatchObject({
      ACTUAL_SESSION_TOKEN: 'valid-token',
      ACTUAL_SYNC_ID: GROUP_ID,
      ACTUAL_MCP_WRITE: '0',
    });
    expect(server.env.ANTHROPIC_API_KEY).toBeUndefined();
    // The config (which holds the session token) is removed afterwards.
    expect(fs.readdirSync(stateDir).filter(f => f.startsWith('mcp-'))).toEqual(
      [],
    );

    // The next message continues the same Claude session.
    await chat(conversationId, 'And on transport?');
    const second = invocation(2);
    const sessionId = first.args[first.args.indexOf('--session-id') + 1];
    expect(second.args[second.args.indexOf('--resume') + 1]).toBe(sessionId);
    expect(second.args).not.toContain('--session-id');
  });

  it('explains authentication failures in plain words', async () => {
    const created = await json(
      await api('/conversations', {
        method: 'POST',
        body: JSON.stringify({ fileId: FILE_ID }),
      }),
    );
    const events = await chat(created.data.id as string, 'please fail');
    const error = events.find(e => e.type === 'error');
    expect(String(error?.message)).toContain('claude setup-token');
  });
});
