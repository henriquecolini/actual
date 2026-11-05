// A tiny stand-in for the real MCP server, used by the server tests. It has an
// `echo` tool and an `ask_user` tool that calls back into the host like the
// real one does.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake-actual', version: '1.0.0' });

server.registerTool(
  'echo',
  { description: 'Echo text back', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
);

server.registerTool(
  'ask_user',
  {
    description: 'Ask the user',
    inputSchema: {
      question: z.string(),
      options: z.array(z.string()).optional(),
    },
  },
  async args => {
    const response = await fetch(process.env.ACTUAL_ASK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.ACTUAL_ASK_TOKEN}`,
      },
      body: JSON.stringify(args),
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(await response.json()) }],
    };
  },
);

await server.connect(new StdioServerTransport());
