import { describe, expect, it } from 'vitest';
import {
  assertScopes,
  extractApiKeyPrefix,
  generateApiKey,
  hashApiKey,
  maskApiKey,
  verifyApiKeyHash,
} from '../src/keys';

describe('api keys', () => {
  it('generates prefixed, hash-only key material', () => {
    const material = generateApiKey('live');
    expect(material.key.startsWith('rvlyra_live_')).toBe(true);
    expect(extractApiKeyPrefix(material.key)).toBe(material.prefix);
    expect(verifyApiKeyHash(material.key, material.hash)).toBe(true);
    expect(verifyApiKeyHash(`${material.key}x`, material.hash)).toBe(false);
    expect(hashApiKey(material.key)).toBe(material.hash);
    expect(maskApiKey(material.key)).toContain('…');
  });

  it('supports admin prefixes and scopes', () => {
    const material = generateApiKey('admin');
    expect(material.key.startsWith('rvlyra_admin_')).toBe(true);
    expect(assertScopes(['analyze:write'], ['analyze:write'])).toBe(true);
    expect(assertScopes(['analyze:write'], ['admin'])).toBe(false);
    expect(assertScopes(['admin'], ['anything'])).toBe(true);
  });
});
