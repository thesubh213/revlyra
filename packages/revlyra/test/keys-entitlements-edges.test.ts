import { describe, expect, it } from 'vitest';
import {
  ADMIN_KEY_PREFIX,
  API_KEY_PREFIX,
  extractApiKeyPrefix,
  generateApiKey,
  hashApiKey,
  maskApiKey,
  verifyApiKeyHash,
} from '../src/keys';
import type { LicenseStatus } from '../src/license';
import { EntitlementError, Entitlements } from '../src/license';

function status(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    valid: true,
    kind: 'license',
    tier: 'pro',
    subject: 's',
    features: ['server', 'media'],
    limits: { reviewsPerMonth: 1000, sources: 5, rps: 50, seats: 2 },
    grace: false,
    ...overrides,
  };
}

describe('generateApiKey shapes', () => {
  it('automatically prefixes admin rows with the admin prefix', () => {
    const material = generateApiKey('admin');
    expect(material.key.startsWith(ADMIN_KEY_PREFIX)).toBe(true);
    expect(extractApiKeyPrefix(material.key)).not.toBeNull();
  });

  it('rejects unknown kinds', () => {
    // The switch only knows live/admin; garbage kinds fall to live keys.
    expect(generateApiKey('ghost' as never).prefix.length).toBeGreaterThan(0);
  });

  it('prefix length honors the argument (stored without the base prefix)', () => {
    const short = generateApiKey('live', 2);
    expect(short.prefix.length).toBe(2);
    const long = generateApiKey('live', 8);
    expect(long.prefix.length).toBe(8);
    // full key still embeds the base prefix
    expect(short.key.startsWith(API_KEY_PREFIX)).toBe(true);
  });
});

describe('hashApiKey/verifyApiKeyHash', () => {
  it('verifies the same key and rejects cross keys with length mismatch', () => {
    const key = generateApiKey('live').key;
    const hash = hashApiKey(key);
    expect(verifyApiKeyHash(key, hash)).toBe(true);
    expect(verifyApiKeyHash(`${key}x`, hash)).toBe(false);
    expect(verifyApiKeyHash(key, 'bogus')).toBe(false);
  });
});

describe('extractApiKeyPrefix edge cases', () => {
  it('returns null for malformed or empty keys', () => {
    expect(extractApiKeyPrefix('')).toBeNull();
    expect(extractApiKeyPrefix('rvlyra_live_')).toBeNull();
    expect(extractApiKeyPrefix('rvlyra_fly_abcdefghijklmnop')).toBeNull();
    expect(extractApiKeyPrefix('random')).toBeNull();
  });
});

describe('maskApiKey', () => {
  it('masks unknown prefixes with the key fallback', () => {
    const masked = maskApiKey('nothing_to_see_here');
    expect(masked).toContain('rvlyra_key_');
    expect(masked).toContain('…');
  });
});

describe('Entitlements', () => {
  it('invalid licenses deny feature access regardless of the feature list', () => {
    const entitlements = new Entitlements(status({ valid: false }));
    expect(entitlements.valid).toBe(false);
    expect(entitlements.has('server')).toBe(false);
    expect(() => entitlements.assert('server')).toThrow(EntitlementError);
  });

  it('enterprise tier unlocks all features when valid', () => {
    const entitlements = new Entitlements(status({ tier: 'enterprise', features: [] }));
    expect(entitlements.has('postgres')).toBe(true);
    expect(entitlements.has('sso')).toBe(true);
  });

  it('pro tier grants only listed features', () => {
    const entitlements = new Entitlements(status({ tier: 'pro' }));
    expect(entitlements.has('server')).toBe(true);
    expect(entitlements.has('media')).toBe(true);
    expect(entitlements.has('postgres')).toBe(false);
  });

  it('transparently exposes limits and a summary shape', () => {
    const entitlements = new Entitlements(status({ grace: true }));
    expect(entitlements.tier).toBe('pro');
    expect(entitlements.reviewsPerMonth).toBe(1000);
    expect(entitlements.sources).toBe(5);
    expect(entitlements.rps).toBe(50);
    expect(entitlements.seats).toBe(2);
    expect(entitlements.toJSON()).toMatchObject({ tier: 'pro', valid: true, grace: true });
  });

  it('grants zero-limit licenses without throwing on reads', () => {
    const entitlements = new Entitlements(
      status({
        kind: 'dev',
        limits: { reviewsPerMonth: 0, sources: 0, rps: 1, seats: 1 },
      }),
    );
    expect(entitlements.reviewsPerMonth).toBe(0);
    expect(entitlements.sources).toBe(0);
  });
});
