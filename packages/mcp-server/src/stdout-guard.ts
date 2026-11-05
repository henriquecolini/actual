import { Writable } from 'node:stream';

// stdout carries the MCP protocol, but loot-core logs to it. This module must be
// imported first: it keeps a private handle on the real stdout for the
// protocol and sends everything else written to stdout to stderr.
const realWrite = process.stdout.write.bind(process.stdout) as (
  chunk: unknown,
  encoding: unknown,
  callback: unknown,
) => boolean;

export const protocolOut = new Writable({
  write(chunk, encoding, callback) {
    realWrite(chunk, encoding, callback);
  },
});

process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
  (process.stderr.write as (...args: unknown[]) => boolean)(
    chunk,
    ...rest,
  )) as typeof process.stdout.write;

for (const method of ['log', 'info', 'debug'] as const) {
  console[method] = (...args: unknown[]) => console.error(...args);
}
