import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE_MODEL, getPolicyPreset, shingles, tokenize } from '@revlyra/core';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { buildTransparencyReport, renderTransparencyHtml } from '../src/engine/compliance';
import { ReviewService } from '../src/engine/service';
import { buildStatementOfReasons, renderStatementOfReasonsMarkdown } from '../src/engine/sor';
import { Entitlements } from '../src/license';
import { SqliteStore } from '../src/store/sqlite';

const dirs: string[] = [];
const stores: SqliteStore[] = [];

async function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-compliance-'));
  dirs.push(dir);
  const config = loadConfig({
    cwd: dir,
    overrides: {
      database: { driver: 'sqlite', path: ':memory:' },
      privacy: { pepper: 'compliance-pepper-long-enough' },
      license: { key: '' },
      governance: { appealSlaDays: 14, sorTerritory: 'EU' },
    },
  });
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
    limits: { reviewsPerMonth: 10_000, sources: 10, rps: 100, seats: 1 },
    grace: false,
  });
  const service = new ReviewService({
    store,
    config,
    entitlements,
    policy: getPolicyPreset('balanced'),
    model: BASELINE_MODEL,
  });
  return { store, service, config };
}

afterAll(() => {
  for (const store of stores.splice(0)) void store.close();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // windows handle quirks
    }
  }
});

describe('buildTransparencyReport arithmetic', () => {
  it('produces an empty-but-complete report for a fresh tenant', async () => {
    const { store } = await makeService();
    const report = await buildTransparencyReport(store, 'default', {
      now: '2026-10-24T00:00:00.000Z',
      sinceDays: 30,
    });
    expect(report.spec).toBe('revlyra.transparency/0.1');
    expect(report.reviews.analyzed).toBe(0);
    expect(report.humanOversight.automationShare).toBe(1);
    expect(report.humanOversight.appeals.overturnRate).toBeNull();
    expect(report.humanOversight.appeals.medianResolutionDays).toBeNull();
    expect(report.fairness.byLanguage).toEqual([]);
  });

  it('counts decisions, feedback, appeals with SLA breaches and medians', async () => {
    const { store, service } = await makeService();
    // Feed decision data
    const review = {
      id: 'tr-1',
      itemId: 'p1',
      reviewerId: 'u1',
      rating: 2,
      text: 'Terrible drill experience lasting a shockingly short and small battery.',
      submittedAt: '2026-10-02T00:00:00.000Z',
    };
    const ingested = await service.ingest('default', { review });
    await store.insertFeedback({
      tenantId: 'default',
      reviewId: ingested.review.id,
      label: 'genuine',
      reasonCode: 'manual',
      actorHmac: 'actor-hmac',
    });
    const appeal = await store.createAppeal({
      tenantId: 'default',
      reviewId: ingested.review.id,
      slaDueAt: '2026-10-20T00:00:00.000Z',
    });
    // Resolve AFTER the SLA deadline (1 breach) in 5 days.
    await store.resolveAppeal('default', appeal.id, 'overturned', 'handler-hmac');
    const report = await buildTransparencyReport(store, 'default', {
      now: '2026-10-24T00:00:00.000Z',
      sinceDays: 90,
    });
    expect(report.reviews.analyzed).toBe(1);
    expect(report.humanOversight.appeals.overturned).toBe(1);
    expect(report.humanOversight.appeals.overturnRate).toBe(1);
    expect(report.humanOversight.appeals.slaBreaches).toBeGreaterThanOrEqual(1);
    expect(report.humanOversight.automationShare).toBe(0); // 1 reviewed / 1 decision
    // The appealed review's language group shows the overturn
    const byLanguage = report.fairness.byLanguage;
    expect(byLanguage[0]?.reviewed).toBe(1);
    expect(byLanguage[0]?.overturnShare).not.toBeNull();
  });

  it('produces HTML from the report', async () => {
    const { store } = await makeService();
    const report = await buildTransparencyReport(store, 'default', {
      now: '2026-10-24T00:00:00.000Z',
    });
    const html = renderTransparencyHtml(report);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Revlyra transparency report');
    expect(html).toContain('revlyra.transparency/0.1');
    expect(html).toContain('Fairness monitoring');
    expect(html).toContain('DSA Art. 15/24');
  });
});

describe('statementOfReasons builder + markdown', () => {
  it('json artifact built deterministically for the same analysis result', async () => {
    const { service, config } = await makeService();
    const ingested = await service.ingest('default', {
      review: {
        id: 'sor-1',
        itemId: 'p-sor',
        reviewerId: 'u-sor',
        rating: 1,
        text: 'The drill overheated and the battery lasted one hour overall.',
        submittedAt: '2026-10-02T00:00:00.000Z',
      },
    });
    void shingles;
    void tokenize;
    const sorA = buildStatementOfReasons({
      review: ingested.review,
      result: ingested.result,
      config,
    });
    const sorB = buildStatementOfReasons({
      review: ingested.review,
      result: ingested.result,
      config,
    });
    expect(sorA.id).toMatch(/^sor_[0-9a-f]+$/u);
    expect(sorA.id).toBe(sorB.id);
    expect(sorA.automation).toEqual(sorB.automation);
    expect(sorA.spec).toBe('revlyra.sor/0.1');
    expect(sorA.territory).toBe('EU');
    expect(sorA.redress.appealWindowDays).toBe(14);
    expect(sorB.id).toBe(sorA.id);
  });

  it('markdown renders header lines and the digest', async () => {
    const { service, config } = await makeService();
    const ingested = await service.ingest('default', {
      review: {
        id: 'sor-md-1',
        itemId: 'p-md',
        reviewerId: 'u-md',
        rating: 4,
        text: 'Good drill overall, the battery lasted two hours and the case is solid.',
        submittedAt: '2026-10-02T00:00:00.000Z',
      },
    });
    const sor = buildStatementOfReasons({
      review: ingested.review,
      result: ingested.result,
      config,
    });
    const markdown = renderStatementOfReasonsMarkdown(sor);
    expect(markdown).toContain('# Statement of Reasons');
    expect(markdown).toContain(sor.id);
    expect(markdown).toContain(sor.evidenceDigest);
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('safe review path contains no safety ground', async () => {
    const { service, config } = await makeService();
    const ingested = await service.ingest('default', {
      review: {
        id: 'sor-md-2',
        itemId: 'p-md',
        reviewerId: 'u-md',
        rating: 4,
        text: 'Good drill overall, the battery lasted two hours and the case is solid.',
        submittedAt: '2026-10-02T00:00:00.000Z',
      },
    });
    const sor = buildStatementOfReasons({
      review: ingested.review,
      result: ingested.result,
      config,
    });
    const safetyGround = sor.grounds.find((ground) =>
      ground.facts.some((fact) => fact.code === 'SAFETY_REVIEW'),
    );
    expect(safetyGround).toBeUndefined();
    const markdown = renderStatementOfReasonsMarkdown(sor);
    expect(markdown).toContain('Statement of Reasons');
  });
});
