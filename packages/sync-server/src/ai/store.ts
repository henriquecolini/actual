import crypto from 'node:crypto';

import { getAccountDb } from '#account-db';

import { decryptSecret, encryptSecret } from './crypto';
import type { MessagePart } from './events';
import type { RuntimeId } from './providers';

// Thin typed layer over the account database tables from the ai-assistant
// migration. Every query is scoped by user id.

export type AiSettings = {
  runtime: RuntimeId;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  /** Decrypted. Only ever handed to the runtime that needs it. */
  secret: string | null;
  /** The assistant may change the budget directly instead of only proposing. */
  allowWrites: boolean;
};

type SettingsRow = {
  runtime: RuntimeId;
  provider: string | null;
  base_url: string | null;
  model: string | null;
  secret_enc: string | null;
  allow_writes: number;
};

export function getSettings(userId: string): AiSettings | null {
  const row = getAccountDb().first(
    'SELECT runtime, provider, base_url, model, secret_enc, allow_writes FROM ai_settings WHERE user_id = ?',
    [userId],
  ) as SettingsRow | null;
  if (!row) return null;
  let secret: string | null = null;
  if (row.secret_enc) {
    try {
      secret = decryptSecret(row.secret_enc);
    } catch {
      secret = null; // key changed; the user has to enter it again
    }
  }
  return {
    runtime: row.runtime,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    secret,
    allowWrites: row.allow_writes === 1,
  };
}

export type SettingsUpdate = {
  runtime: RuntimeId;
  provider?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  /** undefined keeps the stored secret; null or '' clears it. */
  secret?: string | null;
  /** undefined keeps the stored choice. */
  allowWrites?: boolean;
};

export function saveSettings(userId: string, update: SettingsUpdate) {
  const existing = getAccountDb().first(
    'SELECT secret_enc, allow_writes FROM ai_settings WHERE user_id = ?',
    [userId],
  ) as { secret_enc: string | null; allow_writes: number } | null;
  const allowWrites = update.allowWrites ?? existing?.allow_writes === 1;

  let secretEnc = existing?.secret_enc ?? null;
  if (update.secret !== undefined) {
    secretEnc = update.secret ? encryptSecret(update.secret) : null;
  }

  getAccountDb().mutate(
    `INSERT INTO ai_settings (user_id, runtime, provider, base_url, model, secret_enc, allow_writes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       runtime = excluded.runtime,
       provider = excluded.provider,
       base_url = excluded.base_url,
       model = excluded.model,
       secret_enc = excluded.secret_enc,
       allow_writes = excluded.allow_writes,
       updated_at = excluded.updated_at`,
    [
      userId,
      update.runtime,
      update.provider ?? null,
      update.baseUrl ?? null,
      update.model ?? null,
      secretEnc,
      allowWrites ? 1 : 0,
      Date.now(),
    ],
  );
}

// ------------------------------------------------------------ conversations

export type Conversation = {
  id: string;
  fileId: string;
  title: string;
  claudeSessionId: string | null;
  createdAt: number;
  updatedAt: number;
};

type ConversationRow = {
  id: string;
  file_id: string;
  title: string;
  claude_session_id: string | null;
  created_at: number;
  updated_at: number;
};

const toConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  fileId: row.file_id,
  title: row.title,
  claudeSessionId: row.claude_session_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function createConversation(
  userId: string,
  fileId: string,
): Conversation {
  const now = Date.now();
  const id = crypto.randomUUID();
  getAccountDb().mutate(
    'INSERT INTO ai_conversations (id, user_id, file_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, userId, fileId, now, now],
  );
  return getConversation(userId, id)!;
}

export function getConversation(
  userId: string,
  id: string,
): Conversation | null {
  const row = getAccountDb().first(
    'SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?',
    [id, userId],
  ) as ConversationRow | null;
  return row ? toConversation(row) : null;
}

export function listConversations(
  userId: string,
  fileId: string,
  limit = 50,
): Conversation[] {
  const rows = getAccountDb().all(
    'SELECT * FROM ai_conversations WHERE user_id = ? AND file_id = ? ORDER BY updated_at DESC LIMIT ?',
    [userId, fileId, limit],
  ) as ConversationRow[];
  return rows.map(toConversation);
}

export function updateConversation(
  userId: string,
  id: string,
  patch: { title?: string; claudeSessionId?: string },
) {
  const sets: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [Date.now()];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.claudeSessionId !== undefined) {
    sets.push('claude_session_id = ?');
    params.push(patch.claudeSessionId);
  }
  getAccountDb().mutate(
    `UPDATE ai_conversations SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
    [...params, id, userId],
  );
}

export function deleteConversation(userId: string, id: string) {
  const db = getAccountDb();
  db.transaction(() => {
    db.mutate(
      'DELETE FROM ai_messages WHERE conversation_id IN (SELECT id FROM ai_conversations WHERE id = ? AND user_id = ?)',
      [id, userId],
    );
    db.mutate('DELETE FROM ai_conversations WHERE id = ? AND user_id = ?', [
      id,
      userId,
    ]);
  });
}

// ----------------------------------------------------------------- messages

export type StoredMessage = {
  id: number;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  createdAt: number;
};

export function addMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  parts: MessagePart[],
) {
  getAccountDb().mutate(
    'INSERT INTO ai_messages (conversation_id, role, content_json, created_at) VALUES (?, ?, ?, ?)',
    [conversationId, role, JSON.stringify(parts), Date.now()],
  );
}

/** Messages of a conversation the user owns, oldest first. */
export function getMessages(
  userId: string,
  conversationId: string,
): StoredMessage[] {
  const rows = getAccountDb().all(
    `SELECT m.id, m.role, m.content_json, m.created_at
     FROM ai_messages m
     JOIN ai_conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = ? AND c.user_id = ?
     ORDER BY m.id`,
    [conversationId, userId],
  ) as {
    id: number;
    role: 'user' | 'assistant';
    content_json: string;
    created_at: number;
  }[];
  return rows.map(row => ({
    id: row.id,
    role: row.role,
    parts: JSON.parse(row.content_json) as MessagePart[],
    createdAt: row.created_at,
  }));
}

// --------------------------------------------------------------- MCP tokens

export type McpTokenInfo = {
  id: string;
  label: string | null;
  createdAt: number;
};

/** Creates a never-expiring session for an external MCP client. Returns the token once. */
export function createMcpToken(userId: string, label: string | null) {
  const db = getAccountDb();
  const token = crypto.randomBytes(32).toString('hex');
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.mutate(
      'INSERT INTO sessions (token, expires_at, user_id, auth_method) VALUES (?, ?, ?, ?)',
      [token, -1, userId, 'mcp-token'],
    );
    db.mutate(
      'INSERT INTO ai_mcp_tokens (id, user_id, label, session_token, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, userId, label, token, Date.now()],
    );
  });
  return { id, token };
}

export function listMcpTokens(userId: string): McpTokenInfo[] {
  const rows = getAccountDb().all(
    'SELECT id, label, created_at FROM ai_mcp_tokens WHERE user_id = ? ORDER BY created_at DESC',
    [userId],
  ) as { id: string; label: string | null; created_at: number }[];
  return rows.map(r => ({ id: r.id, label: r.label, createdAt: r.created_at }));
}

export function revokeMcpToken(userId: string, id: string): boolean {
  const db = getAccountDb();
  const row = db.first(
    'SELECT session_token FROM ai_mcp_tokens WHERE id = ? AND user_id = ?',
    [id, userId],
  ) as { session_token: string } | null;
  if (!row) return false;
  db.transaction(() => {
    db.mutate('DELETE FROM sessions WHERE token = ? AND user_id = ?', [
      row.session_token,
      userId,
    ]);
    db.mutate('DELETE FROM ai_mcp_tokens WHERE id = ?', [id]);
  });
  return true;
}
