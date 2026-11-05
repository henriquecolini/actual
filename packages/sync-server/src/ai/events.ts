// One event vocabulary for every runtime. The chat UI only ever sees these.

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
  | { type: 'done'; usage?: AiUsage }
  | { type: 'error'; message: string };

export type AiUsage = {
  totalTokens?: number;
  costUsd?: number | null;
};

export type Emit = (event: AiEvent) => void;

/** What gets saved for an assistant turn, in display order. */
export type MessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      input: unknown;
      result?: { text: string; isError: boolean };
    }
  | {
      type: 'question';
      id: string;
      question: string;
      options?: string[];
      multi: boolean;
      answer?: string;
      dismissed?: boolean;
    };

const MAX_STORED_RESULT = 4000;

/** Folds a stream of events into the parts we persist. */
export function createTranscript() {
  const parts: MessagePart[] = [];
  let pendingText = '';

  const flushText = () => {
    if (pendingText.trim()) parts.push({ type: 'text', text: pendingText });
    pendingText = '';
  };

  const answerQuestion = (id: string, answer: string | null) => {
    const question = parts.find(
      (p): p is Extract<MessagePart, { type: 'question' }> =>
        p.type === 'question' && p.id === id,
    );
    if (!question) return;
    if (answer === null) question.dismissed = true;
    else question.answer = answer;
  };

  return {
    push(event: AiEvent) {
      switch (event.type) {
        case 'text_delta':
          pendingText += event.text;
          break;
        case 'text':
          // A finished message replaces the deltas that built it.
          pendingText = event.text;
          flushText();
          break;
        case 'tool_use':
          flushText();
          parts.push({
            type: 'tool',
            id: event.id,
            name: event.name,
            input: event.input,
          });
          break;
        case 'tool_result': {
          const tool = parts.find(
            (p): p is Extract<MessagePart, { type: 'tool' }> =>
              p.type === 'tool' && p.id === event.id,
          );
          if (tool) {
            // Results can be large; the UI only needs a preview.
            tool.result = {
              text: event.text.slice(0, MAX_STORED_RESULT),
              isError: event.isError,
            };
          }
          break;
        }
        case 'question':
          flushText();
          parts.push({
            type: 'question',
            id: event.id,
            question: event.question,
            options: event.options,
            multi: event.multi,
          });
          break;
        case 'question_resolved':
          answerQuestion(
            event.id,
            event.dismissed ? null : (event.answer ?? ''),
          );
          break;
        default:
          break;
      }
    },
    finish(): MessagePart[] {
      flushText();
      return parts;
    },
  };
}
