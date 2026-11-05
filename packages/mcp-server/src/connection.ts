import * as api from '@actual-app/api';

import type { McpConfig } from './config';

export type Connection = {
  ensureFresh: () => Promise<void>;
  refresh: () => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Opens the budget once for the lifetime of the process. loot-core holds a
 * single open budget, so each MCP server process serves exactly one budget.
 */
export async function connect(config: McpConfig): Promise<Connection> {
  if (config.sessionToken) {
    await api.init({
      serverURL: config.serverUrl,
      dataDir: config.dataDir,
      sessionToken: config.sessionToken,
    });
  } else if (config.password) {
    await api.init({
      serverURL: config.serverUrl,
      dataDir: config.dataDir,
      password: config.password,
    });
  } else {
    throw new Error('No credentials configured.');
  }

  // downloadBudget loads and syncs the budget when it already exists locally,
  // and registers the end-to-end encryption key when one is given.
  await api.downloadBudget(config.syncId, {
    password: config.encryptionPassword,
  });

  let lastSync = Date.now();
  let syncing: Promise<void> | null = null;

  const refresh = async () => {
    syncing ??= api
      .sync()
      .then(() => {
        lastSync = Date.now();
      })
      .finally(() => {
        syncing = null;
      });
    await syncing;
  };

  return {
    refresh,
    ensureFresh: async () => {
      if (Date.now() - lastSync > config.refreshAfterSeconds * 1000) {
        await refresh();
      }
    },
    close: async () => {
      await api.shutdown();
    },
  };
}
