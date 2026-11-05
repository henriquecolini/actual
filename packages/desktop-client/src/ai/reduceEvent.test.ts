import { describe, expect, it } from 'vitest';

import { reduceEvent, settleParts } from './reduceEvent';
import type { AiEvent, MessagePart } from './types';

const run = (events: AiEvent[], start: MessagePart[] = []) =>
  events.reduce(reduceEvent, start);

describe('reduceEvent', () => {
  it('grows streaming text, then replaces it with the final text', () => {
    const streaming = run([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
    ]);
    expect(streaming).toEqual([
      { type: 'text', text: 'Hello', streaming: true },
    ]);
    expect(run([{ type: 'text', text: 'Hello!' }], streaming)).toEqual([
      { type: 'text', text: 'Hello!' },
    ]);
  });

  it('adds a final text even when nothing was streamed', () => {
    expect(run([{ type: 'text', text: 'Hi' }])).toEqual([
      { type: 'text', text: 'Hi' },
    ]);
  });

  it('settles streaming text when a tool call starts, and attaches the result', () => {
    const parts = run([
      { type: 'text_delta', text: 'Checking' },
      { type: 'tool_use', id: 't1', name: 'spending_by', input: { a: 1 } },
      { type: 'tool_result', id: 't1', text: 'rows', isError: false },
    ]);
    expect(parts).toEqual([
      { type: 'text', text: 'Checking' },
      {
        type: 'tool',
        id: 't1',
        name: 'spending_by',
        input: { a: 1 },
        result: { text: 'rows', isError: false },
      },
    ]);
  });

  it('starts a new text part after a tool call', () => {
    const parts = run([
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
      { type: 'text_delta', text: 'After' },
    ]);
    expect(parts.map(p => p.type)).toEqual(['tool', 'text']);
  });

  it('tracks a question until it is answered or dismissed', () => {
    const asked = run([
      {
        type: 'question',
        id: 'q',
        question: 'Which?',
        options: ['A', 'B'],
        multi: false,
        allowFreeText: false,
      },
    ]);
    expect(asked[0]).toMatchObject({
      type: 'question',
      question: 'Which?',
      options: ['A', 'B'],
    });
    expect(
      run([{ type: 'question_resolved', id: 'q', answer: 'A' }], asked)[0],
    ).toMatchObject({ answer: 'A' });
    expect(
      run([{ type: 'question_resolved', id: 'q', dismissed: true }], asked)[0],
    ).toMatchObject({ dismissed: true });
  });

  it('ignores events that do not change the message', () => {
    const start: MessagePart[] = [{ type: 'text', text: 'x' }];
    expect(
      run([{ type: 'status', message: 'Opening' }, { type: 'done' }], start),
    ).toBe(start);
  });

  it('settleParts ends streaming', () => {
    expect(settleParts([{ type: 'text', text: 'x', streaming: true }])).toEqual(
      [{ type: 'text', text: 'x' }],
    );
  });
});
