export type McpConfig = {
  serverUrl: string;
  sessionToken?: string;
  password?: string;
  syncId: string;
  dataDir: string;
  encryptionPassword?: string;
  /** Adds tools that modify the budget. Never enabled for the in-app chat. */
  allowWrites: boolean;
  /** Re-sync with the server when data is older than this many seconds. */
  refreshAfterSeconds: number;
};

export function readConfig(
  env: Record<string, string | undefined> = process.env,
): McpConfig {
  const missing = (name: string) =>
    new Error(`Missing required environment variable ${name}.`);

  const serverUrl = env.ACTUAL_SERVER_URL;
  if (!serverUrl) throw missing('ACTUAL_SERVER_URL');
  const syncId = env.ACTUAL_SYNC_ID;
  if (!syncId) throw missing('ACTUAL_SYNC_ID');
  const dataDir = env.ACTUAL_DATA_DIR;
  if (!dataDir) throw missing('ACTUAL_DATA_DIR');

  const sessionToken = env.ACTUAL_SESSION_TOKEN || undefined;
  const password = env.ACTUAL_PASSWORD || undefined;
  if (!sessionToken && !password) {
    throw new Error(
      'Authentication required: set ACTUAL_SESSION_TOKEN (works with OpenID) or ACTUAL_PASSWORD.',
    );
  }

  const refresh = Number(env.ACTUAL_MCP_REFRESH_SECONDS ?? 60);

  return {
    serverUrl,
    sessionToken,
    password,
    syncId,
    dataDir,
    encryptionPassword: env.ACTUAL_ENCRYPTION_PASSWORD || undefined,
    allowWrites: env.ACTUAL_MCP_WRITE === '1',
    refreshAfterSeconds: Number.isFinite(refresh) && refresh > 0 ? refresh : 60,
  };
}
