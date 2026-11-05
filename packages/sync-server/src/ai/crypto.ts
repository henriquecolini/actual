import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from '#load-config';

// AES-256-GCM for secrets at rest (Claude tokens, provider API keys). The key
// comes from ACTUAL_AI_SECRET_KEY, or is generated once and kept next to the
// account database. Losing the key just means users re-enter their secrets.

const PREFIX = 'v1';
let cachedKey: Buffer | null = null;

function keyFromEnv(value: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  // Any other string is stretched into a key.
  return crypto.scryptSync(value, 'actual-ai-secrets', 32);
}

export function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.ACTUAL_AI_SECRET_KEY;
  if (fromEnv) {
    cachedKey = keyFromEnv(fromEnv);
    return cachedKey;
  }

  const keyFile = path.join(
    path.resolve(config.get('serverFiles')),
    'ai-secret.key',
  );
  try {
    cachedKey = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    if (cachedKey.length === 32) return cachedKey;
  } catch {
    // generated below
  }
  const generated = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, generated.toString('hex'), { mode: 0o600 });
  cachedKey = generated;
  return cachedKey;
}

/** Test hook: forget the cached key. */
export function resetKeyCache() {
  cachedKey = null;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    PREFIX,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    data.toString('base64'),
  ].join(':');
}

export function decryptSecret(encrypted: string): string {
  const [prefix, iv, tag, data] = encrypted.split(':');
  if (prefix !== PREFIX || !iv || !tag || !data) {
    throw new Error('Unrecognized secret format');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getKey(),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** "sk-or-…a1b2": enough to recognise a stored key without revealing it. */
export function maskSecret(secret: string): string {
  if (secret.length <= 10) return '••••';
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}
