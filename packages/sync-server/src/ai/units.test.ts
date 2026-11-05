import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  resetKeyCache,
} from './crypto';
import { createTranscript } from './events';
import type { AiEvent } from './events';
import {
  askQuestion,
  registerRun,
  resolveQuestion,
  unregisterRun,
} from './questions';
import { historyFromMessages } from './runner';
import { buildClaudeArgs } from './runtimes/claude-code';
import { parseClaudeLine } from './runtimes/claude-stream';
import { toolParameters } from './runtimes/mcp-bridge';
import { createStreamAccumulator, trimContext } from './runtimes/openai-compat';
import type { Message } from './runtimes/openai-compat';

describe('secret encryption', () => {
  afterEach(() => {
    delete process.env.ACTUAL_AI_SECRET_KEY;
    resetKeyCache();
  });

  it('round-trips and never stores plaintext', () => {
    process.env.ACTUAL_AI_SECRET_KEY = 'correct horse battery staple';
    resetKeyCache();
    const encrypted = encryptSecret('sk-or-v1-supersecret');
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain('supersecret');
    expect(decryptSecret(encrypted)).toBe('sk-or-v1-supersecret');
  });

  it('uses a fresh IV each time', () => {
    process.env.ACTUAL_AI_SECRET_KEY = 'k';
    resetKeyCache();
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('rejects tampered data and a different key', () => {
    process.env.ACTUAL_AI_SECRET_KEY = 'key-one';
    resetKeyCache();
    const encrypted = encryptSecret('secret');
    const [p, iv, tag, data] = encrypted.split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 1;
    expect(() =>
      decryptSecret([p, iv, tag, flipped.toString('base64')].join(':')),
    ).toThrow();

    process.env.ACTUAL_AI_SECRET_KEY = 'key-two';
    resetKeyCache();
    expect(() => decryptSecret(encrypted)).toThrow();
  });

  it('masks secrets for display', () => {
    expect(maskSecret('sk-or-v1-abcdefghijkl')).toBe('sk-or-…ijkl');
    expect(maskSecret('short')).toBe('••••');
  });
});

describe('parseClaudeLine', () => {
  const line = (value: unknown) => JSON.stringify(value);

  it('reads the session id from init', () => {
    expect(
      parseClaudeLine(
        line({ type: 'system', subtype: 'init', session_id: 's1' }),
      ).sessionId,
    ).toBe('s1');
  });

  it('turns text deltas, messages and tool calls into events', () => {
    expect(
      parseClaudeLine(
        line({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Hel' },
          },
        }),
      ).events,
    ).toEqual([{ type: 'text_delta', text: 'Hel' }]);

    expect(
      parseClaudeLine(
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Checking…' },
              {
                type: 'tool_use',
                id: 't1',
                name: 'mcp__actual__spending_by',
                input: { start_date: '2026-01-01' },
              },
            ],
          },
        }),
      ).events,
    ).toEqual([
      { type: 'text', text: 'Checking…' },
      {
        type: 'tool_use',
        id: 't1',
        name: 'spending_by',
        input: { start_date: '2026-01-01' },
      },
    ]);
  });

  it('turns tool results into events, flattening content blocks', () => {
    const [event] = parseClaudeLine(
      line({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [
                { type: 'text', text: 'a' },
                { type: 'text', text: 'b' },
              ],
              is_error: false,
            },
          ],
        },
      }),
    ).events;
    expect(event).toEqual({
      type: 'tool_result',
      id: 't1',
      text: 'a\nb',
      isError: false,
    });
  });

  it('reports the final result, and errors', () => {
    const ok = parseClaudeLine(
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        session_id: 's2',
        total_cost_usd: 0.01,
      }),
    );
    expect(ok.result).toMatchObject({
      isError: false,
      text: 'done',
      costUsd: 0.01,
    });
    expect(ok.sessionId).toBe('s2');
    const bad = parseClaudeLine(
      line({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        result: 'x',
      }),
    );
    expect(bad.result?.isError).toBe(true);
  });

  it('ignores junk lines', () => {
    expect(parseClaudeLine('not json').events).toEqual([]);
    expect(parseClaudeLine(line({ type: 'rate_limit_event' })).events).toEqual(
      [],
    );
  });
});

describe('buildClaudeArgs', () => {
  const base = {
    model: 'sonnet',
    systemPrompt: 'be helpful',
    mcpConfigPath: '/tmp/m.json',
    newSessionId: 'new-id',
  };

  it('locks the agent down to our MCP server', () => {
    const args = buildClaudeArgs(base);
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__actual');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
  });

  it('starts a session, or resumes one', () => {
    expect(buildClaudeArgs(base)).toEqual(
      expect.arrayContaining(['--session-id', 'new-id']),
    );
    const resumed = buildClaudeArgs({ ...base, resumeSessionId: 'old' });
    expect(resumed).toEqual(expect.arrayContaining(['--resume', 'old']));
    expect(resumed).not.toContain('--session-id');
  });
});

describe('createStreamAccumulator', () => {
  const chunk = (delta: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ choices: [{ delta, finish_reason: null }], ...extra });

  it('assembles text and streamed tool-call arguments', () => {
    const deltas: string[] = [];
    const acc = createStreamAccumulator(t => deltas.push(t));
    acc.push(chunk({ content: 'Hel' }));
    acc.push(chunk({ content: 'lo' }));
    acc.push(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'c1',
            function: { name: 'spending_by', arguments: '{"start' },
          },
        ],
      }),
    );
    acc.push(
      chunk({
        tool_calls: [
          { index: 0, function: { arguments: '_date":"2026-01-01"}' } },
        ],
      }),
    );
    acc.push(
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { total_tokens: 42, cost: 0.002 },
      }),
    );
    acc.push('[DONE]');
    const result = acc.result();
    expect(deltas.join('')).toBe('Hello');
    expect(result.content).toBe('Hello');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: 'c1',
      function: {
        name: 'spending_by',
        arguments: '{"start_date":"2026-01-01"}',
      },
    });
    expect(result.usage).toEqual({ total: 42, cost: 0.002 });
  });

  it('gives tool calls without an id one', () => {
    const acc = createStreamAccumulator(() => undefined);
    acc.push(
      chunk({
        tool_calls: [{ index: 0, function: { name: 'x', arguments: '{}' } }],
      }),
    );
    expect(acc.result().toolCalls[0].id).toMatch(/^call_0_/);
  });

  it('surfaces API errors', () => {
    const acc = createStreamAccumulator(() => undefined);
    expect(() =>
      acc.push(JSON.stringify({ error: { message: 'quota exceeded' } })),
    ).toThrow('quota exceeded');
  });
});

describe('trimContext', () => {
  it('shrinks old tool output when the context is huge, keeping recent messages intact', () => {
    const big = 'x'.repeat(100_000);
    const messages: Message[] = [{ role: 'system', content: 's' }];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'tool', tool_call_id: String(i), content: big });
    }
    trimContext(messages);
    expect((messages[1] as { content: string }).content.length).toBeLessThan(
      500,
    );
    expect((messages[20] as { content: string }).content.length).toBe(100_000);
  });
});

describe('toolParameters', () => {
  it('drops $schema, which some providers reject', () => {
    expect(
      toolParameters({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {},
      }),
    ).toEqual({ type: 'object', properties: {} });
    expect(toolParameters(undefined)).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('createTranscript', () => {
  it('builds ordered parts and attaches results and answers', () => {
    const t = createTranscript();
    const events: AiEvent[] = [
      { type: 'text_delta', text: 'Let me ' },
      { type: 'text_delta', text: 'look.' },
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'a', name: 'spending_by', input: { x: 1 } },
      { type: 'tool_result', id: 'a', text: 'rows', isError: false },
      {
        type: 'question',
        id: 'q',
        question: 'Which?',
        options: ['A', 'B'],
        multi: false,
        allowFreeText: false,
      },
      { type: 'question_resolved', id: 'q', answer: 'A' },
      { type: 'text_delta', text: 'Done' },
    ];
    events.forEach(e => t.push(e));
    expect(t.finish()).toEqual([
      { type: 'text', text: 'Let me look.' },
      {
        type: 'tool',
        id: 'a',
        name: 'spending_by',
        input: { x: 1 },
        result: { text: 'rows', isError: false },
      },
      {
        type: 'question',
        id: 'q',
        question: 'Which?',
        options: ['A', 'B'],
        multi: false,
        answer: 'A',
      },
      { type: 'text', text: 'Done' },
    ]);
  });

  it('marks dismissed questions', () => {
    const t = createTranscript();
    t.push({
      type: 'question',
      id: 'q',
      question: '?',
      multi: false,
      allowFreeText: true,
    });
    t.push({ type: 'question_resolved', id: 'q', dismissed: true });
    expect(t.finish()[0]).toMatchObject({ type: 'question', dismissed: true });
  });
});

describe('historyFromMessages', () => {
  it('keeps text and answered questions, and notes which tools were used', () => {
    const history = historyFromMessages([
      {
        id: 1,
        role: 'user',
        parts: [{ type: 'text', text: 'categorize' }],
        createdAt: 0,
      },
      {
        id: 2,
        role: 'assistant',
        createdAt: 0,
        parts: [
          { type: 'tool', id: 'a', name: 'uncategorized_summary', input: {} },
          {
            type: 'question',
            id: 'q',
            question: 'Which?',
            multi: false,
            answer: 'Food',
          },
          { type: 'text', text: 'ok' },
        ],
      },
    ]);
    expect(history[0]).toEqual({ role: 'user', text: 'categorize' });
    expect(history[1].text).toContain('answered: "Food"');
    expect(history[1].text).toContain('[tools used: uncategorized_summary]');
  });
});

describe('ask_user questions', () => {
  it('shows the question on the run and returns the answer', async () => {
    const events: AiEvent[] = [];
    const token = registerRun({ userId: 'u1', emit: e => events.push(e) });
    const pending = askQuestion(token, {
      question: 'Which?',
      options: ['A', 'B'],
    });
    const asked = events.find(e => e.type === 'question');
    expect(asked).toMatchObject({
      question: 'Which?',
      options: ['A', 'B'],
      multi: false,
      allowFreeText: false,
    });

    expect(
      resolveQuestion('u1', (asked as { id: string }).id, {
        answer: 'B',
        selected: ['B'],
      }),
    ).toBe(true);
    expect(await pending).toEqual({
      status: 'answered',
      answer: 'B',
      selected: ['B'],
    });
    expect(events.at(-1)).toMatchObject({
      type: 'question_resolved',
      answer: 'B',
    });
    unregisterRun(token);
  });

  it('only lets the owner answer', async () => {
    const events: AiEvent[] = [];
    const token = registerRun({ userId: 'u1', emit: e => events.push(e) });
    void askQuestion(token, { question: 'x' });
    const id = (events[0] as { id: string }).id;
    expect(resolveQuestion('someone-else', id, { answer: 'hi' })).toBe(false);
    unregisterRun(token);
  });

  it('dismisses pending questions when the run ends, and for unknown runs', async () => {
    const token = registerRun({ userId: 'u1', emit: () => undefined });
    const pending = askQuestion(token, { question: 'x' });
    unregisterRun(token);
    expect(await pending).toEqual({ status: 'dismissed' });
    expect(await askQuestion('unknown', { question: 'x' })).toEqual({
      status: 'dismissed',
    });
  });

  it('allows free text by default when there are no options', () => {
    const events: AiEvent[] = [];
    const token = registerRun({ userId: 'u1', emit: e => events.push(e) });
    void askQuestion(token, { question: 'Why?' });
    expect(events[0]).toMatchObject({ allowFreeText: true, multi: false });
    unregisterRun(token);
  });

  it('times out', async () => {
    vi.useFakeTimers();
    const token = registerRun({ userId: 'u1', emit: () => undefined });
    const pending = askQuestion(token, { question: 'x' });
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(await pending).toEqual({ status: 'timeout' });
    unregisterRun(token);
    vi.useRealTimers();
  });
});
