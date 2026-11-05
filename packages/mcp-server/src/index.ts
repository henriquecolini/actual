import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { readConfig } from './config';
import { connect } from './connection';
import { createServer } from './server';
import { protocolOut } from './stdout-guard';

async function main() {
  const config = readConfig();
  const connection = await connect(config);

  const askEndpoint = process.env.ACTUAL_ASK_URL;
  const askToken = process.env.ACTUAL_ASK_TOKEN;
  const server = createServer({
    config,
    connection,
    ask:
      askEndpoint && askToken
        ? { endpoint: askEndpoint, token: askToken }
        : undefined,
  });

  const shutdown = async () => {
    try {
      await connection.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);

  await server.connect(new StdioServerTransport(process.stdin, protocolOut));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
