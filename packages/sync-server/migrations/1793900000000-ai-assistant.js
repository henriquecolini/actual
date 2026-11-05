import { getAccountDb } from '../src/account-db';

export const up = async function () {
  const accountDb = getAccountDb();

  accountDb.exec(`
    -- Per-user AI agent configuration. The secret (Claude token or API key) is
    -- stored encrypted; see src/ai/crypto.ts.
    CREATE TABLE IF NOT EXISTS ai_settings
      (user_id TEXT NOT NULL PRIMARY KEY,
       runtime TEXT NOT NULL DEFAULT 'claude_code',
       provider TEXT,
       base_url TEXT,
       model TEXT,
       secret_enc TEXT,
       updated_at INTEGER);

    CREATE TABLE IF NOT EXISTS ai_conversations
      (id TEXT NOT NULL PRIMARY KEY,
       user_id TEXT NOT NULL,
       file_id TEXT NOT NULL,
       title TEXT NOT NULL DEFAULT 'New conversation',
       claude_session_id TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL);

    CREATE INDEX IF NOT EXISTS ai_conversations_user
      ON ai_conversations (user_id, file_id, updated_at);

    CREATE TABLE IF NOT EXISTS ai_messages
      (id INTEGER PRIMARY KEY AUTOINCREMENT,
       conversation_id TEXT NOT NULL,
       role TEXT NOT NULL,
       content_json TEXT NOT NULL,
       created_at INTEGER NOT NULL);

    CREATE INDEX IF NOT EXISTS ai_messages_conversation
      ON ai_messages (conversation_id, id);

    -- Long-lived tokens for external MCP clients (e.g. Claude Code on a desktop).
    -- Each one is backed by a never-expiring row in sessions.
    CREATE TABLE IF NOT EXISTS ai_mcp_tokens
      (id TEXT NOT NULL PRIMARY KEY,
       user_id TEXT NOT NULL,
       label TEXT,
       session_token TEXT NOT NULL,
       created_at INTEGER NOT NULL);
  `);
};

export const down = async function () {
  const accountDb = getAccountDb();

  accountDb.exec(`
    DROP TABLE IF EXISTS ai_mcp_tokens;
    DROP TABLE IF EXISTS ai_messages;
    DROP TABLE IF EXISTS ai_conversations;
    DROP TABLE IF EXISTS ai_settings;
  `);
};
