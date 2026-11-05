import { z } from 'zod';

import { defineTool } from '#registry';

export type AskResponse =
  | { status: 'answered'; answer: string; selected?: string[] }
  | { status: 'dismissed' | 'timeout' };

const WAIT_MS = 15 * 60 * 1000;

/**
 * `ask_user` blocks until the person answers in the chat. The MCP process has no
 * UI of its own, so it calls back into the host app, which shows the question
 * and returns the answer. Only registered when the host gave us an endpoint.
 */
export function createAskUserTool(endpoint: string, token: string) {
  return defineTool({
    name: 'ask_user',
    description:
      'Ask the user a question and wait for the answer. Prefer this over guessing whenever a choice is theirs to make (which category, which period, whether to proceed). Offer 2-6 short options when the answer is a choice; the user can always type something else. Ask one thing at a time. Do not use it for questions you can answer from the budget data.',
    shape: {
      question: z.string().describe('A short, specific question'),
      options: z
        .array(z.string())
        .min(2)
        .max(8)
        .optional()
        .describe('Choices to offer as buttons'),
      multi: z.boolean().optional().describe('Allow selecting several options'),
      allow_free_text: z
        .boolean()
        .optional()
        .describe('Let the user type their own answer (default true)'),
      context: z
        .string()
        .optional()
        .describe('One sentence on why you are asking'),
    },
    handler: async args => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(WAIT_MS),
      });
      if (!response.ok) {
        throw new Error(`Could not ask the user (HTTP ${response.status}).`);
      }
      const result = (await response.json()) as AskResponse;
      if (result.status === 'answered') {
        return { answer: result.answer, selected: result.selected };
      }
      return {
        status: result.status,
        note:
          result.status === 'timeout'
            ? 'The user did not answer. Continue without it or ask again later.'
            : 'The user dismissed the question. Do not ask it again; proceed with a sensible default or stop.',
      };
    },
  });
}
