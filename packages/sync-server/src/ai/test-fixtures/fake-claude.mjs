#!/usr/bin/env node
// A stand-in for the `claude` CLI used by the server tests. It records how it
// was invoked and replies with stream-json like the real one.
import fs from 'node:fs';
import path from 'node:path';

const stdin = await new Promise(resolve => {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => resolve(data));
});

const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR;
const mcpIndex = args.indexOf('--mcp-config');
const mcpPath = mcpIndex >= 0 ? args[mcpIndex + 1] : null;

const count = fs
  .readdirSync(configDir)
  .filter(f => f.startsWith('invocation-')).length;
fs.writeFileSync(
  path.join(configDir, `invocation-${count + 1}.json`),
  JSON.stringify({
    args,
    stdin,
    cwd: process.cwd(),
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      HOME: process.env.HOME,
      SECRET_SERVER_VAR: process.env.SECRET_SERVER_VAR,
    },
    mcpConfig:
      mcpPath && fs.existsSync(mcpPath)
        ? JSON.parse(fs.readFileSync(mcpPath, 'utf8'))
        : null,
  }),
);

if (stdin.includes('please fail')) {
  process.stderr.write('Error: 401 Invalid authentication credentials\n');
  process.exit(1);
}

const out = line => process.stdout.write(JSON.stringify(line) + '\n');
const resumed = args.includes('--resume');
const session = resumed
  ? args[args.indexOf('--resume') + 1]
  : args[args.indexOf('--session-id') + 1];

out({ type: 'system', subtype: 'init', session_id: session });
out({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: 'Hello ' },
  },
});
out({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'Hello from fake claude' },
      {
        type: 'tool_use',
        id: 'tu1',
        name: 'mcp__actual__get_overview',
        input: {},
      },
    ],
  },
});
out({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tu1',
        content: [{ type: 'text', text: '{"ok":true}' }],
      },
    ],
  },
});
out({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  session_id: session,
  total_cost_usd: 0.01,
});
