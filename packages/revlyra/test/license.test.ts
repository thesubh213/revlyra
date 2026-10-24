import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installIdHash, readOrCreateInstallId, resolveLicense, writeLease } from '../src/license';
import {
  devLicensePath,
  generateDevLicenseKey,
  registerDevLicense,
  verifyDevLicense,
} from '../src/license/dev';
import { Entitlements } from '../src/license/entitlements';
import { signLicenseToken } from '../src/license/sign';
import { verifySignedToken } from '../src/license/token';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-license-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dev licenses', () => {
  it('registers and verifies a local dev key', () => {
    const dir = tempDir();
    const key = generateDevLicenseKey();
    const record = registerDevLicense(dir, key);
    expect(record.tier).toBe('dev');

    const status = verifyDevLicense(dir, key);
    expect(status.valid).toBe(true);
    expect(status.features).toContain('server');

    expect(verifyDevLicense(dir, generateDevLicenseKey()).valid).toBe(false);
  });

  it('rejects expired dev keys', () => {
    const dir = tempDir();
    const key = generateDevLicenseKey();
    registerDevLicense(dir, key);
    const file = devLicensePath(dir);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    record.expiresAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(file, JSON.stringify(record));
    expect(verifyDevLicense(dir, key).reason).toBe('DEV_LICENSE_EXPIRED');
  });
});

describe('signed licenses', () => {
  it('verifies an Ed25519 token and rejects tampering/expiry', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const payload = {
      sub: 'tenant_acme',
      tier: 'pro' as const,
      features: ['server', 'media'],
      limits: { reviewsPerMonth: 1000, sources: 2, rps: 10, seats: 1 },
      iat: Math.floor(Date.now() / 1000) - 10,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: 'lic_1',
    };
    const token = signLicenseToken(payload, privatePem);
    expect(verifySignedToken(token, publicPem).sub).toBe('tenant_acme');

    const tampered = `${token.slice(0, -2)}aa`;
    expect(() => verifySignedToken(tampered, publicPem)).toThrow();

    const expired = signLicenseToken(
      { ...payload, exp: Math.floor(Date.now() / 1000) - 5 },
      privatePem,
    );
    expect(() => verifySignedToken(expired, publicPem)).toThrow(/EXPIRED/u);
  });

  it('resolves a dev license without network access', async () => {
    const dir = tempDir();
    const key = generateDevLicenseKey();
    registerDevLicense(dir, key);
    const { status, entitlements } = await resolveLicense({
      configDir: dir,
      licenseKey: key,
      allowOnline: false,
    });
    expect(status.valid).toBe(true);
    expect(entitlements.has('server')).toBe(true);
    expect(entitlements.has('transformer')).toBe(false);
  });

  it('requires a lease when online enforcement is configured and honors the grace window', async () => {
    const dir = tempDir();
    const key = generateDevLicenseKey();
    registerDevLicense(dir, key);
    const installId = readOrCreateInstallId(dir);
    expect(installIdHash(installId)).toHaveLength(64);

    const fetcher = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const base = {
      configDir: dir,
      licenseKey: key,
      publicKey: 'dummy',
      licenseServer: 'http://127.0.0.1:1',
      graceDays: 7,
      fetcher,
    };

    const missingLease = await resolveLicense(base);
    expect(missingLease.status.valid).toBe(false);
    expect(missingLease.status.reason).toBe('LEASE_REQUIRED_UNREACHABLE');

    writeLease(dir, {
      token: 'cached-token',
      obtainedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const inGrace = await resolveLicense(base);
    expect(inGrace.status.valid).toBe(true);
    expect(inGrace.status.grace).toBe(true);
    expect(inGrace.status.reason).toBe('LEASE_OFFLINE_GRACE');

    writeLease(dir, {
      token: 'cached-token',
      obtainedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    });
    const pastGrace = await resolveLicense(base);
    expect(pastGrace.status.valid).toBe(false);
    expect(pastGrace.status.reason).toBe('LEASE_GRACE_EXPIRED');
  });

  it('enforces entitlements', () => {
    const entitlements = new Entitlements({
      valid: true,
      kind: 'license',
      tier: 'pro',
      subject: 'acme',
      features: ['server'],
      limits: { reviewsPerMonth: 10, sources: 1, rps: 1, seats: 1 },
      grace: false,
    });
    expect(() => entitlements.assert('server')).not.toThrow();
    expect(() => entitlements.assert('transformer')).toThrow(/not included/u);
  });
});
