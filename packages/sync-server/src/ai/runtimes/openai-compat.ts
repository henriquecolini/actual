import { McpBridge } from './mcp-bridge';
import type { RunInput, RunOutcome } from './types';

/**
 * Agent loop for any OpenAI-compatible chat-completions API (OpenRouter,
 * DeepSeek, OpenAI, Gemini, xAI, Ollama, vLLM/LM Studio…). It streams the
 * model's reply, runs the MCP tools the model calls, and repeats until the
 * model answers.
 */

type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type Completion = {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: { total?: number; cost?: number } | null;
};

export type OpenAiInput = RunInput & {
  baseUrl: string;
  apiKey: string | null;
  headers?: Record<string, string>;
  maxTurns?: number;
};

const MAX_TOOL_TEXT = 20_000;
const MAX_CONTEXT_CHARS = 600_000;

/** Folds the SSE `data:` chunks of a chat-completions stream into one completion. */
export function createStreamAccumulator(onDelta: (text: string) => void) {
  const completion: Completion = {
    content: '',
    toolCalls: [],
    finishReason: null,
    usage: null,
  };
  const calls = new Map<number, ToolCall>();

  return {
    push(data: string) {
      if (data === '[DONE]') return;
      const chunk = JSON.parse(data) as {
        error?: { message?: string };
        choices?: {
          delta?: {
            content?: string | null;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          finish_reason?: string | null;
        }[];
        usage?: {
          total_tokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
          cost?: number;
        };
      };
      if (chunk.error) {
        throw new Error(
          chunk.error.message ?? 'The model API returned an error',
        );
      }
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        completion.content += choice.delta.content;
        onDelta(choice.delta.content);
      }
      for (const part of choice?.delta?.tool_calls ?? []) {
        const index = part.index ?? 0;
        const current = calls.get(index) ?? {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.function.name += part.function.name;
        if (part.function?.arguments) {
          current.function.arguments += part.function.arguments;
        }
        calls.set(index, current);
      }
      if (choice?.finish_reason) completion.finishReason = choice.finish_reason;
      if (chunk.usage) {
        completion.usage = {
          total:
            chunk.usage.total_tokens ??
            (chunk.usage.prompt_tokens ?? 0) +
              (chunk.usage.completion_tokens ?? 0),
          cost: chunk.usage.cost,
        };
      }
    },
    result(): Completion {
      completion.toolCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, call]) => ({
          ...call,
          id: call.id || `call_${index}_${Date.now()}`,
        }));
      return completion;
    },
  };
}

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function describeHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return ' — the API key was rejected. Check it in Settings → AI Assistant.';
  }
  if (status === 402) return ' — the account has no credit left.';
  if (status === 404) {
    return ' — unknown model or wrong server URL. Check them in Settings → AI Assistant.';
  }
  if (status === 429) return ' — rate limited by the provider.';
  return '';
}

async function completeOnce(
  input: OpenAiInput,
  body: Record<string, unknown>,
  onDelta: (text: string) => void,
): Promise<Completion> {
  const response = await fetch(
    `${input.baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
        ...(input.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: input.signal,
    },
  );
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 1500);
    throw new ApiError(
      `Model API error ${response.status}${describeHttpError(response.status)} ${text}`.trim(),
      response.status,
    );
  }
  if (!response.body) throw new Error('The model API returned no body');

  const accumulator = createStreamAccumulator(onDelta);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('data:')) accumulator.push(line.slice(5).trim());
    }
  }
  if (buffer.trim().startsWith('data:')) {
    accumulator.push(buffer.trim().slice(5).trim());
  }
  return accumulator.result();
}

const RETRY_DELAYS_MS = [2_000, 8_000, 20_000];

/** One completion, retried on rate limits and server errors. */
async function complete(
  input: OpenAiInput,
  messages: Message[],
  tools: unknown[],
  onDelta: (text: string) => void,
  retryDelays = RETRY_DELAYS_MS,
): Promise<Completion> {
  let body: Record<string, unknown> = {
    model: input.model,
    messages,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    stream: true,
    stream_options: { include_usage: true },
    ...(input.baseUrl.includes('openrouter.ai')
      ? { usage: { include: true } }
      : {}),
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await completeOnce(input, body, onDelta);
    } catch (error) {
      if (input.signal.aborted) throw error;
      const status = error instanceof ApiError ? error.status : 0;
      // Servers without stream_options support: retry without it.
      if (
        status === 400 &&
        'stream_options' in body &&
        /stream_options|include_usage/i.test((error as Error).message)
      ) {
        const { stream_options: _dropped, ...rest } = body;
        body = rest;
        continue;
      }
      const retryable =
        status === 0 ||
        status === 408 ||
        status === 409 ||
        status === 429 ||
        status >= 500;
      if (!retryable || attempt >= retryDelays.length) throw error;
      input.emit({
        type: 'status',
        message: `The model API is busy (${status || 'network'}), retrying…`,
      });
      await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
    }
  }
}

/** Shrinks old tool output so long sessions stay within the context window. */
export function trimContext(messages: Message[]) {
  let size = JSON.stringify(messages).length;
  for (let i = 1; i < messages.length - 12 && size > MAX_CONTEXT_CHARS; i++) {
    const message = messages[i];
    if (message.role === 'tool' && message.content.length > 600) {
      size -= message.content.length - 300;
      message.content = `${message.content.slice(0, 300)}\n…(older output trimmed)`;
    }
  }
}

export async function runOpenAiCompat(input: OpenAiInput): Promise<RunOutcome> {
  const bridge = await McpBridge.connect(input.mcp);
  try {
    const toolDefs = bridge.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    const messages: Message[] = [
      { role: 'system', content: input.systemPrompt },
      ...input.history.map(
        turn => ({ role: turn.role, content: turn.text }) as Message,
      ),
      { role: 'user', content: input.prompt },
    ];

    let totalTokens = 0;
    let cost: number | null = null;
    const maxTurns = input.maxTurns ?? 40;

    for (let turn = 0; turn < maxTurns; turn++) {
      trimContext(messages);
      const completion = await complete(input, messages, toolDefs, text =>
        input.emit({ type: 'text_delta', text }),
      );
      if (completion.usage) {
        totalTokens += completion.usage.total ?? 0;
        if (typeof completion.usage.cost === 'number') {
          cost = (cost ?? 0) + completion.usage.cost;
        }
      }
      if (completion.content.trim()) {
        input.emit({ type: 'text', text: completion.content });
      }
      messages.push({
        role: 'assistant',
        content: completion.content || null,
        ...(completion.toolCalls.length
          ? { tool_calls: completion.toolCalls }
          : {}),
      });

      if (!completion.toolCalls.length) {
        return { usage: { totalTokens, costUsd: cost } };
      }

      for (const call of completion.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments
            ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
            : {};
        } catch {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'Error: the arguments were not valid JSON. Try again.',
          });
          continue;
        }

        input.emit({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: args,
        });
        let output: { text: string; isError: boolean };
        try {
          output = bridge.has(call.function.name)
            ? await bridge.call(call.function.name, args, input.signal)
            : { text: `Unknown tool ${call.function.name}`, isError: true };
        } catch (error) {
          if (input.signal.aborted) throw error;
          output = {
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }
        const text =
          output.text.length > MAX_TOOL_TEXT
            ? `${output.text.slice(0, MAX_TOOL_TEXT)}\n…(truncated)`
            : output.text;
        input.emit({
          type: 'tool_result',
          id: call.id,
          text,
          isError: output.isError,
        });
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      }
    }
    throw new Error(`Stopped after ${maxTurns} steps without finishing.`);
  } finally {
    await bridge.close();
  }
}

/** Quick check that a provider, key and model work: one tiny non-streaming request. */
export async function testOpenAiCompat(options: {
  baseUrl: string;
  apiKey: string | null;
  model: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch(
      `${options.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey
            ? { authorization: `Bearer ${options.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: 'user', content: 'Reply with the single word OK.' },
          ],
          max_tokens: 16,
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );
    if (response.ok) {
      return { ok: true, message: `Connected (${options.model}).` };
    }
    const text = (await response.text().catch(() => '')).slice(0, 300);
    return {
      ok: false,
      message:
        `Error ${response.status}${describeHttpError(response.status)} ${text}`.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach the server: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
