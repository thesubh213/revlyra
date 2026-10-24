import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cachedLeaseStatus,
  readLease,
  requestLease,
  verifyLease,
  writeLease,
} from '../src/license';
import { signLicenseToken } from '../src/license/sign';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-lease-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pkcs8 = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

function signLeasePayload(exp: number, installIdHash?: string) {
  return signLicenseToken(
    {
      sub: 'lease-test',
      tier: 'enterprise',
      features: ['server', 'graph'],
      limits: { reviewsPerMonth: 50_000, sources: 25, rps: 100, seats: 10 },
      iat: Math.floor(Date.parse('2026-10-01T00:00:00.000Z') / 1000),
      exp,
      jti: 'lease-jti-1',
      ...(installIdHash ? { installIdHash } : {}),
    },
    pkcs8,
    'rvlyra_lease_v1_',
  );
}

describe('lease file IO', () => {
  it('writeLease persists and readLease returns the same record', () => {
    const dir = tempDir();
    writeLease(dir, {
      token: 'tok',
      obtainedAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    expect(readLease(dir)).toEqual({
      token: 'tok',
      obtainedAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
  });

  it('readLease returns null for missing, corrupt, or shapeless files', () => {
    const dir = tempDir();
    expect(readLease(dir)).toBeNull();
    writeFileSync(join(dir, 'lease.json'), 'not json');
    expect(readLease(dir)).toBeNull();
    writeFileSync(join(dir, 'lease.json'), JSON.stringify({ token: 'x' }));
    expect(readLease(dir)).toBeNull();
  });
});

describe('requestLease with fetcher seam', () => {
  it('posts to /v1/leases and returns token plus expiresAt', async () => {
    const token = signLeasePayload(Math.floor(Date.parse('2026-12-31T00:00:00.000Z') / 1000));
    let sentBody: unknown = null;
    const fetcher: typeof fetch = (async (_input, init) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ token, expiresAt: '2026-12-31T00:00:00.000Z' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as never;
    const result = await requestLease({
      server: 'https://license.example.com////',
      licenseKey: 'rvlyra_dev_x',
      installId: 'install-a',
      fetcher,
    });
    expect(result.token).toBe(token);
    expect(result.expiresAt).toBe('2026-12-31T00:00:00.000Z');
    expect((sentBody as { license: string }).license).toBe('rvlyra_dev_x');
    expect((sentBody as { installId: string }).installId).toBe('install-a');
  });

  it('maps HTTP statuses to LEASE_REQUEST_FAILED_<status>', async () => {
    const fetcher: typeof fetch = (async () => new Response('no', { status: 403 })) as never;
    await expect(
      requestLease({ server: 'https://x', licenseKey: 'k', installId: 'i', fetcher }),
    ).rejects.toThrow('LEASE_REQUEST_FAILED_403');
  });

  it('throws LEASE_TOKEN_MISSING when the response omits a token', async () => {
    const fetcher: typeof fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as never;
    await expect(
      requestLease({ server: 'https://x', licenseKey: 'k', installId: 'i', fetcher }),
    ).rejects.toThrow('LEASE_TOKEN_MISSING');
  });

  it('rejects tokens that use the license prefix instead of the lease prefix', async () => {
    const licenseToken = signLicenseToken(
      {
        sub: 'x',
        tier: 'pro',
        features: [],
        limits: { reviewsPerMonth: 1, sources: 1, rps: 1, seats: 1 },
        iat: 0,
        exp: 1_900_000_000,
        jti: 'k',
      },
      pkcs8,
    );
    const fetcher: typeof fetch = (async () =>
      new Response(JSON.stringify({ token: licenseToken }), { status: 200 })) as never;
    await expect(
      requestLease({ server: 'https://x', licenseKey: 'k', installId: 'i', fetcher }),
    ).rejects.toThrow(/LICENSE_PREFIX_INVALID/u);
  });
});

describe('verifyLease install binding', () => {
  it('mismatched install hashes invalidate the lease', () => {
    const token = signLeasePayload(1_900_000_000, 'hash-a');
    const status = verifyLease(token, publicPem, { installIdHash: 'hash-b' });
    expect(status.valid).toBe(false);
    expect(status.reason).toBe('LEASE_INSTALL_MISMATCH');
    expect(status.features).toEqual([]);
    expect(status.tier).toBe('enterprise');
  });

  it('matching install hash passes through as valid', () => {
    const token = signLeasePayload(1_900_000_000, 'hash-a');
    const status = verifyLease(token, publicPem, { installIdHash: 'hash-a' });
    expect(status.valid).toBe(true);
    expect(status.kind).toBe('lease');
  });

  it('expired leases THROW LICENSE_EXPIRED (verifySignedToken raises before status)', () => {
    const token = signLeasePayload(1_600_000_000);
    expect(() => verifyLease(token, publicPem)).toThrow('LICENSE_EXPIRED');
  });
});

describe('cachedLeaseStatus', () => {
  it('validates a written lease and respects install binding and expiry', () => {
    const dir = tempDir();
    const token = signLeasePayload(1_900_000_000, 'hash-a');
    writeLease(dir, {
      token,
      obtainedAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
    const status = cachedLeaseStatus(
      dir,
      publicPem,
      'hash-a',
      new Date('2026-10-24T00:00:00.000Z'),
    );
    expect(status?.valid).toBe(true);
    expect(cachedLeaseStatus(dir, publicPem, 'hash-b')).toBeNull();
    expect(
      cachedLeaseStatus(dir, publicPem, 'hash-a', new Date('2035-01-01T00:00:00.000Z')),
    ).toBeNull();
    // A corrupt file yields null.
    writeFileSync(join(dir, 'lease.json'), '{}');
    expect(cachedLeaseStatus(dir, publicPem, 'hash-a')).toBeNull();
  });
});
