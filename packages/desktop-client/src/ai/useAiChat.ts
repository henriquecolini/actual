import { useCallback, useEffect, useRef, useState } from 'react';

import { aiApi, AiApiError, streamChat, toChatMessages } from './api';
import { reduceEvent, settleParts } from './reduceEvent';
import type { AiEvent, ChatMessage, Conversation, MessagePart } from './types';

type ChatState = {
  conversations: Conversation[];
  activeId: string | null;
  messages: ChatMessage[];
  running: boolean;
  /** What the assistant is doing right now ("Opening your budget…"). */
  status: string | null;
  error: string | null;
};

const initial: ChatState = {
  conversations: [],
  activeId: null,
  messages: [],
  running: false,
  status: null,
  error: null,
};

let counter = 0;
const localId = () => `local-${++counter}`;

/** Maps server error codes to a short explanation. */
export function describeAiError(error: unknown): string {
  if (error instanceof AiApiError) {
    switch (error.reason) {
      case 'not-connected':
        return 'The assistant needs a sync server. Connect to one in Settings.';
      case 'budget-not-synced':
        return 'This budget has not been uploaded to the server yet. Sync it first.';
      case 'encrypted-budget-not-supported':
        return 'The assistant cannot read end-to-end encrypted budgets.';
      case 'already-running':
        return 'The assistant is still working on your previous message.';
      case 'server-busy':
        return 'The server is busy right now. Try again in a moment.';
      case 'file-access-not-allowed':
        return 'You do not have access to this budget on the server.';
      default:
        return `Request failed (${error.reason}).`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * State and actions for the assistant chat of one budget file. The server runs
 * the AI and streams events; this folds them into messages.
 */
export function useAiChat(fileId: string | null, language: string) {
  const [state, setState] = useState<ChatState>(initial);
  const abortRef = useRef<AbortController | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = state.activeId;

  const patch = useCallback((update: Partial<ChatState>) => {
    setState(current => ({ ...current, ...update }));
  }, []);

  // Load the conversation list whenever the budget changes.
  useEffect(() => {
    abortRef.current?.abort();
    setState(initial);
    if (!fileId) return;
    let cancelled = false;
    aiApi
      .listConversations(fileId)
      .then(conversations => {
        if (!cancelled) patch({ conversations });
      })
      .catch(error => {
        if (!cancelled) patch({ error: describeAiError(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, patch]);

  const openConversation = useCallback(
    async (id: string) => {
      abortRef.current?.abort();
      try {
        const { messages } = await aiApi.getConversation(id);
        patch({
          activeId: id,
          messages: toChatMessages(messages),
          running: false,
          status: null,
          error: null,
        });
      } catch (error) {
        patch({ error: describeAiError(error) });
      }
    },
    [patch],
  );

  const newConversation = useCallback(() => {
    abortRef.current?.abort();
    patch({
      activeId: null,
      messages: [],
      running: false,
      status: null,
      error: null,
    });
  }, [patch]);

  const removeConversation = useCallback(
    async (id: string) => {
      try {
        await aiApi.deleteConversation(id);
        setState(current => ({
          ...current,
          conversations: current.conversations.filter(c => c.id !== id),
          ...(current.activeId === id
            ? { activeId: null, messages: [], running: false, status: null }
            : {}),
        }));
      } catch (error) {
        patch({ error: describeAiError(error) });
      }
    },
    [patch],
  );

  const updateAssistant = useCallback(
    (assistantId: string, update: (parts: MessagePart[]) => MessagePart[]) => {
      setState(current => ({
        ...current,
        messages: current.messages.map(message =>
          message.id === assistantId
            ? { ...message, parts: update(message.parts) }
            : message,
        ),
      }));
    },
    [],
  );

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || !fileId || state.running) return;

      let conversationId = state.activeId;
      try {
        if (!conversationId) {
          const created = await aiApi.createConversation(fileId);
          conversationId = created.id;
          setState(current => ({
            ...current,
            activeId: created.id,
            conversations: [created, ...current.conversations],
          }));
        }
      } catch (error) {
        patch({ error: describeAiError(error) });
        return;
      }

      const assistantId = localId();
      setState(current => ({
        ...current,
        running: true,
        error: null,
        status: null,
        messages: [
          ...current.messages,
          {
            id: localId(),
            role: 'user',
            parts: [{ type: 'text', text: message }],
          },
          { id: assistantId, role: 'assistant', parts: [] },
        ],
      }));

      const controller = new AbortController();
      abortRef.current = controller;

      const onEvent = (event: AiEvent) => {
        if (event.type === 'status') {
          patch({ status: event.message });
        } else if (event.type === 'error') {
          patch({ error: event.message });
        } else {
          if (event.type === 'text_delta' || event.type === 'tool_use') {
            patch({ status: null });
          }
          updateAssistant(assistantId, parts => reduceEvent(parts, event));
        }
      };

      try {
        await streamChat(
          conversationId,
          message,
          language,
          onEvent,
          controller.signal,
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          patch({ error: describeAiError(error) });
        }
      } finally {
        updateAssistant(assistantId, settleParts);
        patch({ running: false, status: null });
        if (abortRef.current === controller) abortRef.current = null;
        // Titles are generated on the server from the first message.
        if (fileId) {
          aiApi
            .listConversations(fileId)
            .then(conversations => patch({ conversations }))
            .catch(() => undefined);
        }
      }
    },
    [fileId, language, patch, state.activeId, state.running, updateAssistant],
  );

  const stop = useCallback(() => {
    const id = activeRef.current;
    abortRef.current?.abort();
    if (id) aiApi.stop(id).catch(() => undefined);
  }, []);

  const answerQuestion = useCallback(
    async (
      questionId: string,
      resolution: { answer: string; selected?: string[] } | { dismiss: true },
    ) => {
      try {
        await aiApi.answerQuestion(questionId, resolution);
      } catch (error) {
        patch({ error: describeAiError(error) });
      }
    },
    [patch],
  );

  // Leaving the page stops any run still going.
  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    ...state,
    send,
    stop,
    answerQuestion,
    openConversation,
    newConversation,
    removeConversation,
  };
}
