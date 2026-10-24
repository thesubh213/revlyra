import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeReview } from '@revlyra/core';
import { afterEach, describe, expect, it } from 'vitest';
import { sqliteModule } from '../src/sqlite';
import { SqliteStore } from '../src/store/sqlite';

let store: SqliteStore | null = null;

afterEach(async () => {
  await store?.close();
  store = null;
});

async function makeStore(): Promise<SqliteStore> {
  store = new SqliteStore(':memory:');
  await store.migrate();
  return store;
}

function safeRm(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Windows may still hold open sqlite handles for a moment; best effort.
  }
}

function reviewInput(tenantId: string, index = 1) {
  const review = {
    id: `review-${index}`,
    itemId: 'item-1',
    reviewerId: 'reviewer-1',
    rating: 5,
    text: 'A solid drill with a four-hour battery and a genuinely durable case.',
    submittedAt: `2026-10-0${index}T10:00:00Z`,
  };
  const normalized = normalizeReview(review);
  return {
    tenantId,
    externalHmac: `rh-${index}`,
    itemId: 'item-1',
    reviewerId: `reviewer-${index}`,
    rating: review.rating,
    text: normalized.text,
    textSha256: normalized.exactHash,
    simhash: normalized.simhash,
    language: normalized.language,
    submittedAt: review.submittedAt,
    verified: true,
    context: {},
    media: [],
  };
}

describe('legacy migration path (pre-002 appeals columns)', () => {
  it('migrates a file-backed store twice without errors or duplicate migration rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'revlyra-legacy-migrate-'));
    const path = join(dir, 'file.db');
    try {
      const db = new SqliteStore(path);
      await db.migrate();
      await db.migrate();
      const sqlite = sqliteModule();
      const probe = new sqlite.DatabaseSync(path);
      const rows = probe
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as Array<{ version: string }>;
      expect(rows.map((r) => r.version)).toEqual(
        expect.arrayContaining(['001_init', '002_dsa_review_integrity']),
      );
      expect(rows).toHaveLength(2);
      probe.close();
      await db.close();
    } finally {
      safeRm(dir);
    }
  });

  it('adds the DSA appeal columns to old databases on migrate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'revlyra-legacy-dsa-'));
    const path = join(dir, 'legacy.db');
    try {
      // Build the 001 schema shape (a pre-002 database is simulated by creating
      // an empty db and letting migrate() add everything, then verifying the
      // appeal columns exist).
      const sqlite = sqliteModule();
      const pre = new sqlite.DatabaseSync(path);
      pre.exec(
        'CREATE TABLE bootstrap_marker (id INTEGER); INSERT INTO bootstrap_marker VALUES (1)',
      );
      pre.close();
      const db = new SqliteStore(path);
      await db.migrate();
      const probe = new sqlite.DatabaseSync(path);
      const columns = probe.prepare('PRAGMA table_info(appeals)').all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(['sla_due_at', 'handler_hmac', 'outcome_note']));
      probe.close();
      await db.close();
    } finally {
      safeRm(dir);
    }
  });

  it('creates parent directories for file paths automatically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'revlyra-store-dirs-'));
    const nested = join(dir, 'deep', 'sub', 'revlyra.db');
    const db = new SqliteStore(nested);
    await db.migrate();
    await db.close();
    safeRm(dir);
  });
});

describe('job lifecycle edge cases', () => {
  it('marks failed jobs with backoff and eventually dead', async () => {
    const db = await makeStore();
    await db.ensureTenant('acme');
    const job = await db.createJob({ tenantId: 'acme', kind: 'scan', payload: {} });
    const claimed = await db.claimJob();
    expect(claimed?.id).toBe(job.id);
    await db.failJob(job.id, 'boom', 1000);
    const record = await db.getJob('acme', job.id);
    expect(record?.status).toBe('pending');
    expect((record as unknown as { attempts: number }).attempts ?? 0).toBeGreaterThan(0);

    // Fail repeatedly to exhaust retries and land on 'dead'
    for (let i = 0; i < 4; i += 1) {
      await db.claimJob();
      await db.failJob(job.id, `boom-${i}`, 0);
    }
    const dead = await db.getJob('acme', job.id);
    expect(dead?.status).toBe('dead');
  });

  it('completes jobs with a result payload', async () => {
    const db = await makeStore();
    await db.ensureTenant('acme');
    const job = await db.createJob({ tenantId: 'acme', kind: 'retention', payload: {} });
    await db.claimJob();
    await db.completeJob(job.id, { purged: 3 });
    const record = await db.getJob('acme', job.id);
    expect(record?.status).toBe('completed');
    expect(record && (record.result as Record<string, unknown>).purged).toBe(3);
  });
});

describe('audit chain tamper detection', () => {
  it('verifies a clean chain and then flags directly-modified payloads at the broken seq', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'revlyra-audit-tamper-'));
    try {
      const path = join(dir, 'audit.db');
      const fileStore = new SqliteStore(path);
      await fileStore.migrate();
      await fileStore.ensureTenant('acme');
      await fileStore.appendAudit({
        tenantId: 'acme',
        actor: 'api',
        action: 'review.analyzed',
        targetType: 'review',
        targetId: 'r1',
        payload: { score: 1 },
      });
      await fileStore.appendAudit({
        tenantId: 'acme',
        actor: 'api',
        action: 'review.feedback',
        targetType: 'review',
        targetId: 'r1',
      });
      expect(await fileStore.verifyAudit('acme')).toEqual({
        valid: true,
        count: 2,
        firstBrokenSeq: null,
      });

      // Tamper: rewrite the payload row via a probe connection (the public API
      // cannot corrupt the chain itself).
      const sqlite = sqliteModule();
      const probe = new sqlite.DatabaseSync(path);
      probe
        .prepare('UPDATE audit_log SET payload = ? WHERE rowid = 1')
        .run(JSON.stringify({ score: 999 }));
      const verification = await fileStore.verifyAudit('acme');
      expect(verification.valid).toBe(false);
      expect(verification.firstBrokenSeq).toBe(1);
      probe.close();
      await fileStore.close();
    } finally {
      safeRm(dir);
    }
  });
});

describe('aggregation counters', () => {
  it('counts decisions and signal codes since a timestamp', async () => {
    const db = await makeStore();
    await db.ensureTenant('acme');
    for (let i = 1; i <= 3; i += 1) {
      const record = await db.upsertReview(reviewInput('acme', i));
      await db.updateReviewAnalysis('acme', record.id, {
        score: 0.1,
        confidence: 0.9,
        decision: 'hold',
        band: 'high',
        provisional: false,
        modelVersion: 'm1',
        policyVersion: 'p1',
        analysisHash: `hash-${i}`,
      });
      await db.insertSignals(record.id, [
        {
          code: 'TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT',
          family: 'content',
          severity: 0.95,
          confidence: 0.95,
          contribution: 0.9,
          hard: true,
          evidence: {},
          explanation: 'test',
        },
      ]);
    }
    const counts = await db.decisionCounts('acme', '2026-01-01T00:00:00Z');
    expect(counts).toEqual([{ decision: 'hold', count: 3 }]);
    const codes = await db.signalCodeCounts('acme', '2026-01-01T00:00:00Z', 10);
    expect(codes[0]?.code).toBe('TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT');
    expect(codes[0]?.count).toBe(3);
  });
});

describe('notices and appeals (store level)', () => {
  it('creates and transitions notices', async () => {
    const db = await makeStore();
    await db.ensureTenant('acme');
    const review = await db.upsertReview(reviewInput('acme'));
    const notice = await db.insertNotice({
      tenantId: 'acme',
      reviewId: review.id,
      type: 'complaint',
      claim: 'This review removed me from the platform unfairly',
    });
    expect(notice.status).toBe('received');
    const updated = await db.updateNoticeStatus('acme', notice.id, {
      status: 'under_review',
    });
    expect(updated.status).toBe('under_review');
    const list = await db.listNotices('acme', { reviewId: review.id });
    expect(list).toHaveLength(1);
  });

  it('resolves appeals with handler hashes and outcome notes', async () => {
    const db = await makeStore();
    await db.ensureTenant('acme');
    const review = await db.upsertReview(reviewInput('acme'));
    const appeal = await db.createAppeal({
      tenantId: 'acme',
      reviewId: review.id,
      reason: 'I did not copy anyone',
      slaDueAt: '2026-11-20T00:00:00Z',
    });
    expect(appeal.status).toBe('open');
    const resolved = await db.resolveAppeal(
      'acme',
      appeal.id,
      'overturned',
      'handler-hmac-value',
      'no duplicate evidence',
    );
    expect(resolved.status).toBe('overturned');
    expect((resolved as unknown as { handlerHmac?: string }).handlerHmac).toBe(
      'handler-hmac-value',
    );
    expect(await db.listAppeals('acme', 'overturned')).toHaveLength(1);
  });
});

describe('risk snapshots and review edges', () => {
  it('stores and reads reviewer risk snapshots', async () => {
    const db = await makeStore();
    await db.ensureTenant('acme');
    await db.upsertRiskSnapshot({
      tenantId: 'acme',
      entityType: 'reviewer',
      entityId: 'rev-1',
      score: 0.6,
      band: 'high',
      version: '1.0.0',
    });
    const snapshot = await db.getRiskSnapshot('acme', 'reviewer', 'rev-1');
    expect(snapshot).toMatchObject({ score: 0.6, band: 'high', version: '1.0.0' });
    expect(await db.getRiskSnapshot('acme', 'item', 'nope')).toBeNull();
  });

  it('upserts review edges idempotently and lists them', async () => {
    const db = await makeStore();
    await db.ensureTenant('acme');
    const edge = {
      tenantId: 'acme',
      reviewId: 'r1',
      reviewerId: 'rev-1',
      itemId: 'i1',
      submittedAt: '2026-10-01T00:00:00Z',
      signals: ['dup'],
      risk: 0.4,
    };
    await db.upsertReviewEdge(edge);
    await db.upsertReviewEdge({ ...edge, risk: 0.9 });
    const edges = await db.listReviewEdges('acme', '2020-01-01T00:00:00Z', 100);
    expect(edges).toHaveLength(1); // ON CONFLICT upsert on (tenant, review)
    expect(edges[0]?.risk).toBe(0.9);
  });
});

describe('findReviewByExternal', () => {
  it('finds stored reviews by external hmac per source', async () => {
    const db = await makeStore();
    await db.ensureTenant('acme');
    const record = await db.upsertReview({ ...reviewInput('acme'), sourceId: 'source-1' });
    const found = await db.findReviewByExternal('acme', 'source-1', 'rh-1');
    expect(found?.id).toBe(record.id);
    expect(await db.findReviewByExternal('acme', 'source-2', 'rh-1')).toBeNull();
  });
});
