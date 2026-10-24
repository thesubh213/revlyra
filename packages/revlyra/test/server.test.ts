import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE_MODEL, getPolicyPreset } from '@revlyra/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type RevlyraConfig } from '../src/config';
import { ReviewService } from '../src/engine/service';
import { generateApiKey } from '../src/keys';
import { Entitlements } from '../src/license';
import { buildServer } from '../src/server/app';
import { SqliteStore } from '../src/store/sqlite';

let dir: string;
let config: RevlyraConfig;
let store: SqliteStore;
let app: FastifyInstance;
let apiKey: string;

const ADMIN = 'rvlyra_admin_test_key_1234567890';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'revlyra-server-'));
  config = loadConfig({
    cwd: dir,
    overrides: {
      database: { driver: 'sqlite', path: ':memory:' },
      privacy: { pepper: 'test-pepper-that-is-long-enough' },
      server: { host: '127.0.0.1', port: 0 },
      limits: { reviewsPerMonth: 5000, sources: 20, rps: 1000, maxBatch: 100 },
      license: { key: '' },
    },
  });
  config.adminKey = ADMIN;
  store = new SqliteStore(':memory:');
  await store.migrate();
  await store.ensureTenant('default');
  const entitlements = new Entitlements({
    valid: true,
    kind: 'dev',
    tier: 'enterprise',
    subject: 'test',
    features: ['server', 'media', 'campaigns', 'graph', 'transformer', 'postgres', 'audit_export'],
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
  apiKey = material.key;
  await store.createApiKey({
    tenantId: 'default',
    prefix: material.prefix,
    keyHash: material.hash,
    scopes: ['analyze:write', 'feedback:write', 'scan:write'],
  });
  app = await buildServer({ config, store, service, logger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${apiKey}` });
const adminAuth = () => ({ authorization: `Bearer ${ADMIN}` });

describe('http api', () => {
  it('serves public health and protects tenant routes', async () => {
    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe('ok');

    const unauthorized = await app.inject({ method: 'GET', url: '/v1/campaigns' });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json().error.code).toBe('AUTH_MISSING');
  });

  it('analyzes a review and detects a cross-account duplicate', async () => {
    const body = {
      review: {
        itemId: 'p1',
        reviewerId: 'u1',
        rating: 5,
        text: 'Best product ever!!! Works perfectly and the quality is amazing. Highly recommend to everyone!',
        submittedAt: '2026-10-20T10:00:00Z',
      },
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/reviews/analyze',
      headers: auth(),
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().reviewId).toBeTruthy();

    const second = await app.inject({
      method: 'POST',
      url: '/v1/reviews/analyze',
      headers: auth(),
      payload: {
        review: { ...body.review, reviewerId: 'u2', submittedAt: '2026-10-20T10:02:00Z' },
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().score).toBeGreaterThan(0.9);
    expect(second.json().decision).toMatch(/hold|escalate/u);
  });

  it('returns validation errors for malformed reviews', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/reviews/analyze',
      headers: auth(),
      payload: { review: { itemId: 'p1', reviewerId: 'u1', text: 'missing rating' } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('records feedback, integrity, and selections', async () => {
    const feedback = await app.inject({
      method: 'POST',
      url: '/v1/feedback',
      headers: auth(),
      payload: {
        reviewId: 'does-not-exist',
        label: 'genuine',
        reasonCode: 'manual_test',
      },
    });
    expect(feedback.statusCode).toBe(404);

    const integrity = await app.inject({
      method: 'GET',
      url: '/v1/items/p1/integrity',
      headers: auth(),
    });
    expect(integrity.statusCode).toBe(200);
    expect(integrity.json().integrity.reviewCount).toBe(2);

    const selection = await app.inject({
      method: 'POST',
      url: '/v1/items/p1/select',
      headers: auth(),
      payload: { limit: 5 },
    });
    expect(selection.statusCode).toBe(200);
    expect(selection.json().selection).toBeTruthy();
  });

  it('supports admin key creation and audit verification', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/keys',
      headers: adminAuth(),
      payload: { scopes: ['analyze:write'] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().key).toMatch(/^rvlyra_live_/u);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/keys',
      headers: adminAuth(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().keys.length).toBeGreaterThanOrEqual(2);

    const verify = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit/verify',
      headers: adminAuth(),
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().valid).toBe(true);
  });

  it('rejects invalid admin keys and unknown routes', async () => {
    const badAdmin = await app.inject({
      method: 'GET',
      url: '/v1/admin/keys',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(badAdmin.statusCode).toBe(401);

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/nope',
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });
});
