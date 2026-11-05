import type { AiEvent } from '#ai/events';

// Pure parser for `claude -p --output-format stream-json --verbose
// --include-partial-messages`: one JSON object per line → normalized events.

export type ParsedLine = {
  events: AiEvent[];
  sessionId?: string;
  result?: {
    isError: boolean;
    text: string | null;
    costUsd: number | null;
    subtype: string | null;
  };
};

const TOOL_PREFIX = /^mcp__actual__/;

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text: unknown }).text);
        }
        return '';
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

export function parseClaudeLine(line: string): ParsedLine {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { events: [] };
  }

  const type = event.type;
  if (type === 'system' && event.subtype === 'init') {
    return { events: [], sessionId: event.session_id as string | undefined };
  }

  if (type === 'stream_event') {
    const inner = event.event as
      | { type?: string; delta?: { type?: string; text?: string } }
      | undefined;
    if (
      inner?.type === 'content_block_delta' &&
      inner.delta?.type === 'text_delta' &&
      inner.delta.text
    ) {
      return { events: [{ type: 'text_delta', text: inner.delta.text }] };
    }
    return { events: [] };
  }

  if (type === 'assistant') {
    const message = event.message as
      | { content?: Record<string, unknown>[] }
      | undefined;
    const events: AiEvent[] = [];
    for (const block of message?.content ?? []) {
      if (block.type === 'text' && String(block.text).trim()) {
        events.push({ type: 'text', text: String(block.text) });
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'tool_use',
          id: String(block.id),
          name: String(block.name).replace(TOOL_PREFIX, ''),
          input: block.input,
        });
      }
    }
    return { events };
  }

  if (type === 'user') {
    const message = event.message as
      | { content?: Record<string, unknown>[] | string }
      | undefined;
    const events: AiEvent[] = [];
    if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          events.push({
            type: 'tool_result',
            id: String(block.tool_use_id),
            text: toolResultText(block.content),
            isError: Boolean(block.is_error),
          });
        }
      }
    }
    return { events };
  }

  if (type === 'result') {
    return {
      events: [],
      sessionId: (event.session_id as string) ?? undefined,
      result: {
        isError: Boolean(event.is_error) || event.subtype !== 'success',
        text: (event.result as string) ?? null,
        costUsd: (event.total_cost_usd as number) ?? null,
        subtype: (event.subtype as string) ?? null,
      },
    };
  }

  return { events: [] };
}
