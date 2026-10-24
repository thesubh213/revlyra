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

const ADMIN = 'rvlyra_admin_test_key_9876543210';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'revlyra-dsa-'));
  config = loadConfig({
    cwd: dir,
    overrides: {
      database: { driver: 'sqlite', path: ':memory:' },
      privacy: { pepper: 'test-pepper-that-is-long-enough' },
      server: { host: '127.0.0.1', port: 0 },
      limits: { maxBatch: 100 },
      governance: { appealSlaDays: 14, sorTerritory: 'EU' },
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
    features: ['server', 'media', 'campaigns', 'graph', 'transformer'],
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

async function analyzeReview(
  payload: Record<string, unknown>,
): Promise<Record<string, any> & { reviewId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/reviews/analyze',
    headers: auth(),
    payload: { review: payload },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe('DSA governance surface', () => {
  it('routes a safety-incident review through the human channel with statement of reasons', async () => {
    const result = await analyzeReview({
      itemId: 'resort-77',
      reviewerId: 'traveler-9',
      rating: 1,
      text: 'I was DRUGGED at the swim-up bar and blacked out. The staff refused to call the police and I filed a police report the next morning. This place is dangerous.',
      submittedAt: '2026-10-20T10:00:00Z',
    });
    expect(result.safety?.routed).toBe(true);
    expect(['hold', 'escalate']).toContain(result.decision);

    const sor = await app.inject({
      method: 'GET',
      url: `/v1/reviews/${result.reviewId}/statement-of-reasons`,
      headers: auth(),
    });
    expect(sor.statusCode).toBe(200);
    const body = sor.json();
    expect(body.spec).toBe('revlyra.sor/0.1');
    expect(body.territory).toBe('EU');
    expect(body.decision.decision).toBe(result.decision);
    expect(body.automation.humanReviewRequired).toBe(true);
    expect(
      body.grounds.some((ground: { codes: string[] }) => ground.codes.includes('SAFETY_REVIEW')),
    ).toBe(true);

    const markdown = await app.inject({
      method: 'GET',
      url: `/v1/reviews/${result.reviewId}/statement-of-reasons?format=md`,
      headers: auth(),
    });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.body).toContain('# Statement of Reasons');
  });

  it('recorded the safety routing in the audit chain', async () => {
    const audit = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit?limit=100',
      headers: adminAuth(),
    });
    const actions = audit.json().audit.map((row: { action: string }) => row.action);
    expect(actions).toContain('safety_review.routed');
    expect(actions).toContain('review.sor_issued');
  });

  it('handles the full appeal lifecycle with required human adjudication', async () => {
    await analyzeReview({
      itemId: 'p-dup',
      reviewerId: 'u-dup-1',
      rating: 5,
      text: 'Best product ever!!! Works perfectly and the quality is amazing. Highly recommend to everyone!',
      submittedAt: '2026-10-20T10:00:00Z',
    });
    const duplicate = await analyzeReview({
      reviewId: undefined,
      itemId: 'p-dup',
      reviewerId: 'u-dup-2',
      rating: 5,
      text: 'Best product ever!!! Works perfectly and the quality is amazing. Highly recommend to everyone!',
      submittedAt: '2026-10-20T10:02:00Z',
    });

    const appeal = await app.inject({
      method: 'POST',
      url: '/v1/appeals',
      headers: auth(),
      payload: { reviewId: duplicate.reviewId, reason: 'I genuinely bought this.' },
    });
    expect(appeal.statusCode).toBe(201);
    const appealId = appeal.json().id;
    expect(new Date(appeal.json().slaDueAt).getTime()).toBeGreaterThan(Date.now());
    expect(appeal.json().slaDueAt.length).toBeGreaterThan(0);

    const missingHandler = await app.inject({
      method: 'POST',
      url: `/v1/appeals/${appealId}/adjudication`,
      headers: auth(),
      payload: { outcome: 'overturned' },
    });
    expect(missingHandler.statusCode).toBe(400);

    const adjudication = await app.inject({
      method: 'POST',
      url: `/v1/appeals/${appealId}/adjudication`,
      headers: auth(),
      payload: { outcome: 'overturned', handlerHmac: 'staffer-42', reason: 'receipt verified' },
    });
    expect(adjudication.statusCode).toBe(200);
    expect(adjudication.json().status).toBe('overturned');
    expect(adjudication.json().handlerHmac).not.toBe('staffer-42');

    const reviewerRisk = await app.inject({
      method: 'GET',
      url: '/v1/reviewers/u-dup-2/risk',
      headers: auth(),
    });
    // The overturn feeds the reviewer profile aggregate that detectors use.
    expect(reviewerRisk.statusCode).toBe(200);
    expect(reviewerRisk.json().aggregates.totalReviews).toBe(1);
  });

  it('accepts notices and completes the art. 16 workflow', async () => {
    const review = await analyzeReview({
      itemId: 'p-notice',
      reviewerId: 'u-notice',
      rating: 3,
      text: 'The heater smelled of burning plastic on second use and I unplugged it for the rest of the evening. Not sure I would buy again at this price.',
      submittedAt: '2026-10-20T11:00:00Z',
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/notices',
      headers: auth(),
      payload: {
        reviewId: review.reviewId,
        type: 'complaint',
        claim: 'The review hallucinates an smell report; technician log attached.',
        substantiated: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const noticeId = created.json().id;

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/notices?reviewId=${encodeURIComponent(review.reviewId)}`,
      headers: auth(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().notices.length).toBe(1);

    const ok = await app.inject({
      method: 'GET',
      url: '/v1/notices',
      headers: auth(),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().notices.length).toBeGreaterThanOrEqual(1);

    const reviewed = await app.inject({
      method: 'PATCH',
      url: `/v1/notices/${noticeId}/status`,
      headers: auth(),
      payload: { status: 'under_review' },
    });
    expect(reviewed.statusCode).toBe(200);

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/v1/notices/${noticeId}/status`,
      headers: auth(),
      payload: { status: 'brazen' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('serves an aggregate transparency report to admins', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/transparency',
      headers: adminAuth(),
    });
    expect(response.statusCode).toBe(200);
    const report = response.json();
    expect(report.spec).toBe('revlyra.transparency/0.1');
    expect(report.reviews.analyzed).toBeGreaterThan(0);
    expect(Array.isArray(report.fairness.byLanguage)).toBe(true);

    const html = await app.inject({
      method: 'GET',
      url: '/v1/admin/transparency?format=html',
      headers: adminAuth(),
    });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('Revlyra transparency report');

    const denied = await app.inject({
      method: 'GET',
      url: '/v1/admin/transparency',
      headers: auth(),
    });
    expect([401, 403]).toContain(denied.statusCode);
  });
});
