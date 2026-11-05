import type { AiEvent, MessagePart } from './types';

/**
 * Applies one stream event to the assistant message being built. Pure: returns
 * a new parts array. Streaming text lives in a trailing text part flagged
 * `streaming`, which a final `text` event replaces.
 */
export function reduceEvent(
  parts: MessagePart[],
  event: AiEvent,
): MessagePart[] {
  const last = parts[parts.length - 1];

  switch (event.type) {
    case 'text_delta': {
      if (last?.type === 'text' && last.streaming) {
        return [
          ...parts.slice(0, -1),
          { ...last, text: last.text + event.text },
        ];
      }
      return [...parts, { type: 'text', text: event.text, streaming: true }];
    }

    case 'text': {
      if (last?.type === 'text' && last.streaming) {
        return [...parts.slice(0, -1), { type: 'text', text: event.text }];
      }
      return [...parts, { type: 'text', text: event.text }];
    }

    case 'tool_use': {
      // A tool call ends any text that was still streaming.
      const settled = parts.map(part =>
        part.type === 'text' && part.streaming
          ? { type: 'text' as const, text: part.text }
          : part,
      );
      return [
        ...settled,
        { type: 'tool', id: event.id, name: event.name, input: event.input },
      ];
    }

    case 'tool_result':
      return parts.map(part =>
        part.type === 'tool' && part.id === event.id
          ? { ...part, result: { text: event.text, isError: event.isError } }
          : part,
      );

    case 'question':
      return [
        ...parts,
        {
          type: 'question',
          id: event.id,
          question: event.question,
          options: event.options,
          multi: event.multi,
          allowFreeText: event.allowFreeText,
          context: event.context,
        },
      ];

    case 'question_resolved':
      return parts.map(part =>
        part.type === 'question' && part.id === event.id
          ? event.dismissed
            ? { ...part, dismissed: true }
            : { ...part, answer: event.answer ?? '' }
          : part,
      );

    default:
      return parts;
  }
}

/** Marks any text still flagged as streaming as finished. */
export function settleParts(parts: MessagePart[]): MessagePart[] {
  return parts.map(part =>
    part.type === 'text' && part.streaming
      ? { type: 'text' as const, text: part.text }
      : part,
  );
}
