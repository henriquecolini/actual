import crypto from 'node:crypto';

import type { Emit } from './events';

// `ask_user` plumbing. The MCP server runs in a child process with no UI, so
// when the model asks something it calls back into this server (bearer = a
// per-run secret). We show the question on the chat stream and hold the HTTP
// call open until the person answers, dismisses it, or the run ends.

export type AskPayload = {
  question: string;
  options?: string[];
  multi?: boolean;
  allow_free_text?: boolean;
  context?: string;
};

export type AskResponse =
  | { status: 'answered'; answer: string; selected?: string[] }
  | { status: 'dismissed' | 'timeout' };

export type Resolution =
  | { dismiss: true }
  | { answer: string; selected?: string[] };

type Run = { userId: string; emit: Emit };
type Pending = {
  userId: string;
  runToken: string;
  resolve: (response: AskResponse) => void;
  timer: NodeJS.Timeout;
};

const QUESTION_TIMEOUT_MS = 15 * 60 * 1000;

const runs = new Map<string, Run>();
const pending = new Map<string, Pending>();

export function registerRun(run: Run): string {
  const token = crypto.randomBytes(24).toString('hex');
  runs.set(token, run);
  return token;
}

/** Ends a run: anything it was still waiting on is dismissed. */
export function unregisterRun(token: string) {
  for (const [id, entry] of pending) {
    if (entry.runToken === token) settle(id, { status: 'dismissed' }, false);
  }
  runs.delete(token);
}

export function isKnownRun(token: string): boolean {
  return runs.has(token);
}

function settle(id: string, response: AskResponse, notify = true) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (notify) {
    const run = runs.get(entry.runToken);
    run?.emit(
      response.status === 'answered'
        ? { type: 'question_resolved', id, answer: response.answer }
        : { type: 'question_resolved', id, dismissed: true },
    );
  }
  entry.resolve(response);
}

export function askQuestion(
  runToken: string,
  payload: AskPayload,
): Promise<AskResponse> {
  const run = runs.get(runToken);
  if (!run) return Promise.resolve({ status: 'dismissed' });

  const id = crypto.randomUUID();
  const options = payload.options?.length ? payload.options : undefined;

  return new Promise<AskResponse>(resolve => {
    const timer = setTimeout(
      () => settle(id, { status: 'timeout' }),
      QUESTION_TIMEOUT_MS,
    );
    timer.unref();
    pending.set(id, { userId: run.userId, runToken, resolve, timer });
    run.emit({
      type: 'question',
      id,
      question: payload.question,
      options,
      multi: Boolean(payload.multi && options),
      allowFreeText: payload.allow_free_text ?? !options,
      context: payload.context,
    });
  });
}

/** The person's reply from the UI. False when it is not theirs or already settled. */
export function resolveQuestion(
  userId: string,
  id: string,
  resolution: Resolution,
): boolean {
  const entry = pending.get(id);
  if (!entry || entry.userId !== userId) return false;
  settle(
    id,
    'dismiss' in resolution
      ? { status: 'dismissed' }
      : {
          status: 'answered',
          answer: resolution.answer,
          selected: resolution.selected,
        },
  );
  return true;
}
