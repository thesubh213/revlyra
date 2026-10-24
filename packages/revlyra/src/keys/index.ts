import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const API_KEY_PREFIX = 'rvlyra_live_';
export const ADMIN_KEY_PREFIX = 'rvlyra_admin_';

export const SCOPES = ['analyze:write', 'feedback:write', 'scan:write', 'admin'] as const;

export type Scope = (typeof SCOPES)[number];

export interface ApiKeyMaterial {
  key: string;
  prefix: string;
  hash: string;
  last4: string;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateApiKey(kind: 'live' | 'admin' = 'live', prefixLength = 8): ApiKeyMaterial {
  // Prefixes must be underscore-free so extractApiKeyPrefix/maskApiKey stay
  // unambiguous; base64url also contains '-' and '_'.
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const raw = randomBytes(prefixLength * 2);
  let prefix = '';
  for (let index = 0; index < raw.length && prefix.length < prefixLength; index += 1) {
    const char = alphabet[raw[index]! % alphabet.length];
    if (char) prefix += char;
  }
  const secret = randomBytes(32).toString('base64url');
  const base = kind === 'admin' ? ADMIN_KEY_PREFIX : API_KEY_PREFIX;
  const key = `${base}${prefix}_${secret}`;
  return {
    key,
    prefix,
    hash: hashApiKey(key),
    last4: secret.slice(-4),
  };
}

export function verifyApiKeyHash(presented: string, storedHash: string): boolean {
  const computed = hashApiKey(presented);
  if (computed.length !== storedHash.length) return false;
  return timingSafeEqual(Buffer.from(computed, 'utf8'), Buffer.from(storedHash, 'utf8'));
}

export function extractApiKeyPrefix(key: string): string | null {
  const base = key.startsWith(ADMIN_KEY_PREFIX)
    ? ADMIN_KEY_PREFIX
    : key.startsWith(API_KEY_PREFIX)
      ? API_KEY_PREFIX
      : null;
  if (!base) return null;
  const rest = key.slice(base.length);
  const underscore = rest.indexOf('_');
  if (underscore <= 0) return null;
  return rest.slice(0, underscore);
}

export function maskApiKey(key: string): string {
  const prefix = extractApiKeyPrefix(key) ?? 'key';
  return `rvlyra_${prefix}_…${key.slice(-4)}`;
}

export function assertScopes(allowed: string[], required: string[]): boolean {
  if (allowed.includes('admin')) return true;
  return required.every((scope) => allowed.includes(scope));
}
