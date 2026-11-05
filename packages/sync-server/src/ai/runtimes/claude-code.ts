import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { parseClaudeLine } from './claude-stream';
import { allowlistedEnv } from './env';
import type { RunInput, RunOutcome } from './types';

/** Claude Code CLI on the user's own Claude subscription. */

export type ClaudeCodeInput = RunInput & {
  /** Subscription token from `claude setup-token`. */
  token: string;
  /** Per-user directory for Claude's config and saved sessions. */
  configDir: string;
  homeDir: string;
  /** Existing session to continue; otherwise a new one is created. */
  resumeSessionId?: string | null;
  bin?: string;
  timeoutMs?: number;
};

export function buildClaudeArgs(options: {
  model: string;
  systemPrompt: string;
  mcpConfigPath: string;
  resumeSessionId?: string | null;
  newSessionId: string;
}): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Nothing from the machine's own Claude settings, hooks or MCP servers.
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    options.mcpConfigPath,
    // No built-in tools (shell, files, web): only our MCP server.
    '--tools',
    '',
    '--allowedTools',
    'mcp__actual',
    '--permission-mode',
    'dontAsk',
    '--model',
    options.model,
    '--append-system-prompt',
    options.systemPrompt,
  ];
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  else args.push('--session-id', options.newSessionId);
  return args;
}

export async function runClaudeCode(
  input: ClaudeCodeInput,
): Promise<RunOutcome> {
  await fs.mkdir(input.configDir, { recursive: true });
  await fs.mkdir(input.homeDir, { recursive: true });

  // The MCP config holds the session token, so it is private and short-lived.
  const mcpConfigPath = path.join(
    input.configDir,
    `mcp-${crypto.randomUUID().slice(0, 8)}.json`,
  );
  await fs.writeFile(
    mcpConfigPath,
    JSON.stringify({ mcpServers: { actual: { type: 'stdio', ...input.mcp } } }),
    { mode: 0o600 },
  );

  const newSessionId = crypto.randomUUID();
  const args = buildClaudeArgs({
    model: input.model,
    systemPrompt: input.systemPrompt,
    mcpConfigPath,
    resumeSessionId: input.resumeSessionId,
    newSessionId,
  });

  const child = spawn(input.bin ?? 'claude', args, {
    cwd: input.homeDir,
    // The subscription token only; ANTHROPIC_API_KEY is never set, so usage
    // cannot fall through to pay-per-token API billing.
    env: allowlistedEnv(input.homeDir, {
      CLAUDE_CODE_OAUTH_TOKEN: input.token,
      CLAUDE_CONFIG_DIR: input.configDir,
      MCP_TOOL_TIMEOUT: '900000',
      MCP_TIMEOUT: '60000',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stop = () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }
  };
  input.signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, input.timeoutMs ?? 30 * 60 * 1000);
  timer.unref();

  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });

  child.stdin.on('error', () => undefined);
  child.stdin.end(input.prompt);

  let sessionId: string | undefined = input.resumeSessionId ?? newSessionId;
  let result: ReturnType<typeof parseClaudeLine>['result'];

  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const parsed = parseClaudeLine(line);
    if (parsed.sessionId) sessionId = parsed.sessionId;
    if (parsed.result) result = parsed.result;
    for (const event of parsed.events) input.emit(event);
  });

  const exitCode: number | null = await new Promise(resolve => {
    child.on('error', error => {
      stderr += `\n${error.message}`;
      resolve(null);
    });
    child.on('close', code => resolve(code));
  });

  clearTimeout(timer);
  input.signal.removeEventListener('abort', stop);
  await fs.rm(mcpConfigPath, { force: true });

  if (input.signal.aborted) return { sessionId };

  if (!result) {
    throw new Error(describeFailure(exitCode, stderr));
  }
  if (result.isError) {
    throw new Error(describeResultError(result.text, result.subtype));
  }
  return { sessionId, usage: { costUsd: result.costUsd } };
}

function describeFailure(exitCode: number | null, stderr: string): string {
  if (/ENOENT/.test(stderr)) {
    return 'The Claude Code CLI (`claude`) is not installed on the server. Install it (npm i -g @anthropic-ai/claude-code) or set ACTUAL_CLAUDE_BIN.';
  }
  if (/401|authenticat|invalid.*token|oauth/i.test(stderr)) {
    return 'Claude rejected the token. Run `claude setup-token` again and paste the new token in Settings → AI Assistant.';
  }
  const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
  return `Claude Code stopped unexpectedly (exit ${exitCode ?? 'n/a'}). ${tail}`.trim();
}

function describeResultError(
  text: string | null,
  subtype: string | null,
): string {
  if (text && /limit|usage|quota|rate/i.test(text)) {
    return `Your Claude plan's usage limit was reached: ${text.slice(0, 300)}`;
  }
  if (text && /(auth|login|token)/i.test(text)) {
    return 'Claude rejected the token. Run `claude setup-token` again and paste the new token in Settings → AI Assistant.';
  }
  return `Claude finished with an error (${subtype ?? 'unknown'}): ${(text ?? '').slice(0, 400)}`;
}

/** Quick check that a token works: one tiny request, no tools. */
export async function testClaudeToken(options: {
  token: string;
  model: string;
  configDir: string;
  homeDir: string;
  bin?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; message: string }> {
  await fs.mkdir(options.configDir, { recursive: true });
  await fs.mkdir(options.homeDir, { recursive: true });
  const child = spawn(
    options.bin ?? 'claude',
    [
      '-p',
      'Reply with the single word OK.',
      '--output-format',
      'json',
      '--tools',
      '',
      '--setting-sources',
      '',
      '--no-session-persistence',
      '--model',
      options.model,
    ],
    {
      cwd: options.homeDir,
      env: allowlistedEnv(options.homeDir, {
        CLAUDE_CODE_OAUTH_TOKEN: options.token,
        CLAUDE_CONFIG_DIR: options.configDir,
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => (stdout += String(chunk)));
  child.stderr.on('data', chunk => (stderr += String(chunk)));
  const timer = setTimeout(
    () => child.kill('SIGKILL'),
    options.timeoutMs ?? 60_000,
  );

  const code: number | null = await new Promise(resolve => {
    child.on('error', error => {
      stderr += error.message;
      resolve(null);
    });
    child.on('close', exit => resolve(exit));
  });
  clearTimeout(timer);

  try {
    const parsed = JSON.parse(stdout) as {
      is_error?: boolean;
      result?: string;
    };
    if (!parsed.is_error) return { ok: true, message: 'Connected to Claude.' };
    return {
      ok: false,
      message: describeResultError(parsed.result ?? null, 'error'),
    };
  } catch {
    return { ok: false, message: describeFailure(code, stderr) };
  }
}
