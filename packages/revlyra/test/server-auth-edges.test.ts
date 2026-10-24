import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE_MODEL, getPolicyPreset } from '@revlyra/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { ReviewService } from '../src/engine/service';
import { generateApiKey } from '../src/keys';
import { Entitlements } from '../src/license';
import { buildServer } from '../src/server/app';
import { SqliteStore } from '../src/store/sqlite';

const ADMIN = 'rvlyra_admin_test_key_abc123456';
const dirs: string[] = [];
const stores: SqliteStore[] = [];
const apps: FastifyInstance[] = [];

async function bootstrap(
  adminKey: string,
): Promise<{ store: SqliteStore; app: FastifyInstance; apiKey: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-auth-'));
  dirs.push(dir);
  const config = loadConfig({
    cwd: dir,
    overrides: {
      database: { driver: 'sqlite', path: ':memory:' },
      privacy: { pepper: 'test-pepper-that-is-long-enough' },
      server: { host: '127.0.0.1', port: 0 },
      limits: { reviewsPerMonth: 5000, sources: 20, rps: 1000, maxBatch: 100 } as never,
      license: { key: '' },
    },
  });
  config.adminKey = adminKey;
  const store = new SqliteStore(':memory:');
  await store.migrate();
  await store.ensureTenant('default');
  stores.push(store);
  const entitlements = new Entitlements({
    valid: true,
    kind: 'dev',
    tier: 'enterprise',
    subject: 'test',
    features: ['server', 'media', 'campaigns', 'graph'],
    limits: { reviewsPerMonth: 5000, sources: 20, rps: 1000, seats: 10 },
    grace: false,
  });
  const service = new ReviewService({
    store,
    config,
    entitlements,
    policy: getPolicyPreset('balanced'),
    model: BASELINE_MODEL,
  });
  const material = generateApiKey('live');
  await store.createApiKey({
    tenantId: 'default',
    prefix: material.prefix,
    keyHash: material.hash,
    scopes: ['analyze:write', 'feedback:write', 'scan:write'],
  });
  const app = await buildServer({ config, store, service, logger: false });
  await app.ready();
  apps.push(app);
  return { store, app, apiKey: material.key };
}

describe('auth hook edge matrix', () => {
  let store: SqliteStore;
  let app: FastifyInstance;
  let _apiKey = '';

  beforeAll(async () => {
    ({ store, app, _apiKey } = await bootstrap(ADMIN));
  });

  afterAll(() => {
    for (const app2 of apps.splice(0)) void app2.close();
    for (const store2 of stores.splice(0)) void store2.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('revoked keys are rejected like unknown keys', async () => {
    const revoked = generateApiKey('live');
    await store.createApiKey({
      tenantId: 'default',
      prefix: revoked.prefix,
      keyHash: revoked.hash,
      scopes: ['analyze:write'],
    });
    const keys = await store.listApiKeys('default');
    const toRevoke = keys.find((k) => k.prefix === revoked.prefix)!;
    await store.revokeApiKey('default', toRevoke.id);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/campaigns',
      headers: { authorization: `Bearer ${revoked.key}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_INVALID_KEY');
  });

  it('expired keys are rejected at the <= now boundary', async () => {
    const expired = generateApiKey('live');
    await store.createApiKey({
      tenantId: 'default',
      prefix: expired.prefix,
      keyHash: expired.hash,
      scopes: ['analyze:write'],
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/campaigns',
      headers: { authorization: `Bearer ${expired.key}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_INVALID_KEY');
  });

  it('scope-gated routes reject keys lacking the scope', async () => {
    const readonly = generateApiKey('live');
    await store.createApiKey({
      tenantId: 'default',
      prefix: readonly.prefix,
      keyHash: readonly.hash,
      scopes: ['analyze:write'],
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/scan',
      headers: { authorization: `Bearer ${readonly.key}` },
      payload: { sourceId: 's1' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('SCOPE_FORBIDDEN');
  });

  it('tenant API keys can never reach admin routes even with the admin scope', async () => {
    const elevated = generateApiKey('live');
    await store.createApiKey({
      tenantId: 'default',
      prefix: elevated.prefix,
      keyHash: elevated.hash,
      scopes: ['admin'],
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit',
      headers: { authorization: `Bearer ${elevated.key}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('admin routing picks up the x-revlyra-tenant header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/keys',
      headers: { authorization: `Bearer ${ADMIN}`, 'x-revlyra-tenant': 'acme-west' },
      payload: { scopes: ['analyze:write'] },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.key).toContain('rvlyra_live_');
    const tenants = await store.listTenants();
    expect(tenants.map((t) => t.id)).toContain('acme-west');
  });

  it('public paths bypass auth even with query strings', async () => {
    const withQuery = await app.inject({ method: 'GET', url: '/v1/health?probe=1' });
    expect(withQuery.statusCode).toBe(200);
    const openapi = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(openapi.statusCode).toBe(200);
  });
});

describe('admin-disabled deployment (empty admin key)', () => {
  it('admin routes answer 503 ADMIN_DISABLED when no admin key is configured', async () => {
    apps.pop(); // detach the bootstrap app from this suite's afterAll ownership for the new one
    const { store: noAdminStore, app: noAdminApp } = await bootstrap('');
    apps.pop();
    stores.pop();
    // Re-registers into the shared arrays inside beforeAll-like context; cleanup happens in this test.
    apps.unshift(noAdminApp);
    stores.unshift(noAdminStore);
    dirs.push('');
    dirs.pop();

    // With no admin key on record, ANY bearer key that reaches an admin route
    // yields ADMIN_DISABLED rather than key verification.
    const response = await noAdminApp.inject({
      method: 'GET',
      url: '/v1/admin/audit',
      headers: { authorization: 'Bearer some-key' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('ADMIN_DISABLED');

    await noAdminApp.close();
    await noAdminStore.close();
  });
});
