import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Use the alias targets from the workspace config so tests don't need built dist for libs.
import { verifySignedToken } from '../../../packages/revlyra/src/license';
import { signLicenseToken } from '../../../packages/revlyra/src/license/sign';

const dirs: string[] = [];

const dist = join(process.cwd(), 'apps/license-server/dist/index.js');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pkcs8 = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const spki = publicKey.export({ format: 'pem', type: 'spki' }).toString();

const ADMIN = 'license-server-test-admin-key-long';
let port = 0;
let dbPath = '';
let child: ChildProcess | null = null;
const _serverReady = false;

async function waitForPort(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('license server did not become ready');
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
}

async function post(url: string, body: unknown, headers: Record<string, string> = adminHeaders()) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function get(url: string, headers: Record<string, string> = adminHeaders()) {
  const response = await fetch(url, { headers });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

beforeAll(async () => {
  if (!existsSync(dist))
    throw new Error(
      'license server dist missing — run pnpm --filter @revlyra/license-server build',
    );
  const dir = mkdtempSync(join(tmpdir(), 'license-server-test-'));
  dirs.push(dir);
  dbPath = join(dir, 'licenses.db');
  port = 18_000 + (process.pid % 1_000);
  child = spawn(process.execPath, [dist], {
    env: {
      ...process.env,
      LICENSE_PRIVATE_KEY: pkcs8.replace(/\n/gu, '\\n'),
      LICENSE_ADMIN_KEY: ADMIN,
      LICENSE_DB_PATH: dbPath,
      LICENSE_PORT: String(port),
      LICENSE_LOG_LEVEL: 'error',
    },
    stdio: 'ignore',
  });
  await waitForPort(`http://127.0.0.1:${port}/health`);
});

afterAll(() => {
  child?.kill();
  child = null;
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort windows cleanup
    }
  }
});

describe.skipIf(!existsSync(dist))('license server over HTTP', () => {
  const base = () => `http://127.0.0.1:${port}`;

  it('health and public key are unauthenticated', async () => {
    const health = await get(`${base()}/health`, {});
    expect(health.data).toMatchObject({ status: 'ok', service: 'revlyra-license-server' });
    const key = await get(`${base()}/v1/public-key`, {});
    expect(key.data.publicKey).toContain('BEGIN PUBLIC KEY');
  });

  it('admin auth gates license issuance', async () => {
    const denied = await fetch(`${base()}/v1/licenses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: 'x' }),
    });
    expect(denied.status).toBe(401);
    expect((await denied.json()).error?.code).toBe('AUTH_INVALID');

    const wrong = await post(
      `${base()}/v1/health-wrong`,
      {},
      { authorization: 'Bearer nope-long-enough' },
    );
    expect(wrong.status).toBe(401);
  });

  it('issues, lists, inspects, and revokes licenses', async () => {
    const issue = await post(`${base()}/v1/licenses`, {
      sub: 'acme',
      tier: 'pro',
      features: ['server'],
      limits: { reviewsPerMonth: 1000, sources: 2, rps: 10, seats: 1 },
      expiresInDays: 30,
    });
    expect(issue.status).toBe(201);
    expect(issue.data.license.startsWith('rvlyra_lic_v1_')).toBe(true);
    const jti = issue.data.jti as string;

    const listed = (await get(`${base()}/v1/licenses`)).data.licenses as Array<
      Record<string, unknown>
    >;
    expect(listed.some((row) => row.jti === jti)).toBe(true);

    const inspected = await get(`${base()}/v1/licenses/${jti}`);
    expect(inspected.data.license.jti).toBe(jti);

    const revoked = await post(`${base()}/v1/licenses/${jti}/revoke`, {});
    expect(revoked.data.revoked).toBe(true);
    // second revoke is idempotent
    expect((await post(`${base()}/v1/licenses/${jti}/revoke`, {})).data.revoked).toBe(true);

    await expect(get(`${base()}/v1/licenses/nope-${Date.now()}`)).resolves.toMatchObject({
      status: 404,
    });
  });

  it('leases are unauthenticated client-facing with seat limits', async () => {
    const issue = await post(`${base()}/v1/licenses`, {
      sub: 'seat-test',
      tier: 'pro',
      features: ['server'],
      limits: { reviewsPerMonth: 1000, sources: 2, rps: 10, seats: 1 },
    });
    const license = issue.data.license as string;
    // verify it decodes with our public key
    const payload = verifySignedToken(license, spki);
    expect(payload.sub).toBe('seat-test');

    const lease1 = await post(`${base()}/v1/leases`, { license, installId: 'install-a' }, {});
    expect(lease1.status).toBe(200);
    const lease = verifySignedToken(lease1.data.token, spki, { prefix: 'rvlyra_lease_v1_' });
    expect(lease.installIdHash).toHaveLength(64);
    expect(lease.tier).toBe('pro');

    // second distinct install hits the seat cap
    const lease2 = await post(`${base()}/v1/leases`, { license, installId: 'install-b' }, {});
    expect(lease2.status).toBe(403);
    expect(lease2.data.error.code).toBe('SEAT_LIMIT_REACHED');

    // same install renew is fine even at cap
    const renew = await post(`${base()}/v1/leases`, { license, installId: 'install-a' }, {});
    expect(renew.status).toBe(200);
  });

  it('license lifecycle rejection paths for leases', async () => {
    // expired license
    const now = Math.floor(Date.now() / 1000);
    const expired = signLicenseToken(
      {
        sub: 'exp',
        tier: 'pro',
        features: [],
        limits: { reviewsPerMonth: 1, sources: 1, rps: 1, seats: 1 },
        iat: now - 5000,
        exp: now - 3600,
        jti: 'expired-jti',
      },
      pkcs8,
    );
    const expiredLease = await post(
      `${base()}/v1/leases`,
      { license: expired, installId: 'x' },
      {},
    );
    expect(expiredLease.status).toBe(403);
    expect(expiredLease.data.error.code).toBe('LICENSE_INVALID');

    // unknown license row (valid signature but jti not in DB)
    const unknown = signLicenseToken(
      {
        sub: 'ghost',
        tier: 'pro',
        features: [],
        limits: { reviewsPerMonth: 1, sources: 1, rps: 1, seats: 1 },
        iat: now,
        exp: now + 3600,
        jti: 'never-issued',
      },
      pkcs8,
    );
    const unknownLease = await post(
      `${base()}/v1/leases`,
      { license: unknown, installId: 'x' },
      {},
    );
    expect(unknownLease.status).toBe(403);
    expect(unknownLease.data.error.code).toBe('LICENSE_REVOKED_OR_UNKNOWN');

    // install-bound licenses reject foreign installs
    const hash = createHash('sha256').update('install-b', 'utf8').digest('hex');
    const issued = await post(`${base()}/v1/licenses`, {
      sub: 'bound',
      tier: 'pro',
      features: [],
      limits: { reviewsPerMonth: 1, sources: 1, rps: 1, seats: 1 },
      installIdHash: hash,
    });
    const boundLease = await post(
      `${base()}/v1/leases`,
      { license: issued.data.license, installId: 'install-c' },
      {},
    );
    expect(boundLease.data.error.code).toBe('LICENSE_BOUND_TO_OTHER_INSTALL');
  });

  it('rejects schema-invalid license payloads', async () => {
    void statSync;
    const bad = await post(`${base()}/v1/licenses`, {
      sub: 'x',
      tier: 'dev', // issuance never produces dev keys
      features: [],
      limits: { reviewsPerMonth: 0, sources: 0, rps: 1, seats: 1 },
    });
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe('VALIDATION_ERROR');

    const badHash = await post(`${base()}/v1/licenses`, {
      sub: 'x',
      tier: 'pro',
      features: [],
      limits: { reviewsPerMonth: 0, sources: 0, rps: 1, seats: 1 },
      installIdHash: 'not-64',
    });
    expect(badHash.status).toBe(400);
    const badDays = await post(`${base()}/v1/licenses`, {
      sub: 'x',
      tier: 'pro',
      features: [],
      limits: { reviewsPerMonth: 0, sources: 0, rps: 1, seats: 1 },
      expiresInDays: 5000,
    });
    expect(badDays.status).toBe(400);
  });

  it('database file is materialized at the configured path', () => {
    expect(existsSync(dbPath)).toBe(true);
  });
});
