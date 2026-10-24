import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  invalidStatus,
  LEASE_PREFIX,
  LICENSE_PREFIX,
  parseLicenseToken,
  statusFromPayload,
  verifySignedToken,
} from '../src/license';
import { signLicenseToken } from '../src/license/sign';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pkcs8 = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

const PAYLOAD = {
  sub: 'test-subject',
  tier: 'pro' as const,
  features: ['server', 'media'],
  limits: { reviewsPerMonth: 750_000, sources: 25, rps: 100, seats: 10 },
  iat: 1_770_000_000, // 2026-02-01T23:20:00Z
  exp: 1_900_000_000,
  jti: 'test-jti',
};

describe('parseLicenseToken', () => {
  it('rejects wrong prefixes and malformed formats', () => {
    expect(() => parseLicenseToken('garbage-token')).toThrow('LICENSE_PREFIX_INVALID');
    expect(() => parseLicenseToken('garbage-token', LEASE_PREFIX)).toThrow(
      'LICENSE_PREFIX_INVALID',
    );
    expect(() =>
      parseLicenseToken('rvlyra_lic_v1_ZXh0cmEK،extra'.replace('،extra', '.a.b.c')),
    ).toThrow('LICENSE_FORMAT_INVALID');
    expect(() => parseLicenseToken('rvlyra_lic_v1_nopayload.signature.part')).toThrow(
      'LICENSE_FORMAT_INVALID',
    );
  });

  it('rejects invalid JSON payloads', () => {
    const bogus = `${LICENSE_PREFIX}${Buffer.from('{ broken json').toString('base64url')}.${Buffer.from('sig').toString('base64url')}`;
    expect(() => parseLicenseToken(bogus)).toThrow('LICENSE_PAYLOAD_INVALID');
  });

  it('parses body.signature with the license payload', () => {
    const token = signLicenseToken(PAYLOAD, pkcs8);
    const parsed = parseLicenseToken(token, LICENSE_PREFIX);
    expect(parsed.payload.sub).toBe('test-subject');
    expect(parsed.prefix).toBe(LICENSE_PREFIX);
  });
});

describe('verifySignedToken', () => {
  it('accepts valid tokens and rejects tampering', () => {
    const token = signLicenseToken(PAYLOAD, pkcs8);
    expect(verifySignedToken(token, publicPem).jti).toBe('test-jti');
    const tampered = `${token.slice(0, -4)}aaaa`;
    expect(() => verifySignedToken(tampered, publicPem)).toThrow('LICENSE_SIGNATURE_INVALID');
  });

  it('rejecting leases and licenses with wrong signatures', () => {
    const other = generateKeyPairSync('ed25519');
    const otherKey = other.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    expect(() => verifySignedToken(signLicenseToken(PAYLOAD, pkcs8), otherKey)).toThrow(
      'LICENSE_SIGNATURE_INVALID',
    );
  });

  it('rejects not-yet-valid and expired tokens with second precision', () => {
    const now = new Date('2026-10-24T00:00:00.000Z');
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const future = signLicenseToken({ ...PAYLOAD, nbf: nowSeconds + 60 }, pkcs8);
    expect(() => verifySignedToken(future, publicPem, { now })).toThrow('LICENSE_NOT_YET_VALID');

    const past = signLicenseToken({ ...PAYLOAD, exp: nowSeconds }, pkcs8);
    expect(() => verifySignedToken(past, publicPem, { now })).toThrow('LICENSE_EXPIRED');

    // One second later is valid.
    const boundary = signLicenseToken({ ...PAYLOAD, exp: nowSeconds + 1 }, pkcs8);
    expect(verifySignedToken(boundary, publicPem, { now }).jti).toBe('test-jti');
  });

  it('splice token parts with the lease prefix', () => {
    const leaseToken = signLicenseToken(PAYLOAD, pkcs8, LEASE_PREFIX);
    expect(verifySignedToken(leaseToken, publicPem, { prefix: LEASE_PREFIX }).jti).toBe('test-jti');
    expect(leaseToken.startsWith(LEASE_PREFIX)).toBe(true);
  });
});

describe('statusFromPayload / invalidStatus', () => {
  it('marks expiry and issue dates from second-precision payloads', () => {
    const status = statusFromPayload(
      { ...PAYLOAD, exp: 1_900_000_000, iat: 1_700_000_000 },
      'license',
    );
    expect(status.valid).toBe(true);
    expect(status.tier).toBe('pro');
    expect(status.expiresAt).toBe(new Date(1_900_000_000 * 1000).toISOString());
    expect(status.issuedAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(status.grace).toBe(false);
  });

  it('sets grace when requested', () => {
    const status = statusFromPayload(PAYLOAD, 'lease', true);
    expect(status.grace).toBe(true);
    expect(status.kind).toBe('lease');
  });

  it('invalidStatus snapshots dev defaults with the given reason', () => {
    const status = invalidStatus('LICENSE_KEY_MISSING', 'none');
    expect(status).toMatchObject({
      valid: false,
      kind: 'none',
      tier: 'dev',
      subject: '',
      features: [],
      grace: false,
      reason: 'LICENSE_KEY_MISSING',
    });
    expect(Object.isFrozen(status.limits!)).toBe(false); // a plain object
    expect(status.limits!.reviewsPerMonth).toBe(10_000);
  });
});

describe('prefix constants', () => {
  it('are stable public tokens', () => {
    expect(LICENSE_PREFIX).toBe('rvlyra_lic_v1_');
    expect(LEASE_PREFIX).toBe('rvlyra_lease_v1_');
  });
});
