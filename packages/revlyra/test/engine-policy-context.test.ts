import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE_MODEL } from '@revlyra/core';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { canonicalFromRecord, prepareAnalysisContext } from '../src/engine/context';
import { loadModel, loadPolicy } from '../src/engine/policy';
import { SqliteStore } from '../src/store/sqlite';

const dirs: string[] = [];
const stores: SqliteStore[] = [];

afterAll(() => {
  for (const store of stores.splice(0)) void store.close();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // windows quirks
    }
  }
});

function makeConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-engpolicy-'));
  dirs.push(dir);
  const config = loadConfig({
    cwd: dir,
    overrides: {
      database: { driver: 'sqlite', path: ':memory:' },
      privacy: { pepper: 'engine-policy-pepper-long' },
      license: { key: '' },
    },
  });
  return { dir, config };
}

describe('loadPolicy', () => {
  it('resolves preset names through the preset registry', () => {
    const { config } = makeConfig();
    config.detection.policy = 'strict';
    const policy = loadPolicy(config);
    expect(policy.id).toBe('strict');
  });

  it('reads a custom policy file and falls back with helpful errors', () => {
    const { dir, config } = makeConfig();
    const file = join(dir, 'custom-policy.json');
    writeFileSync(
      file,
      JSON.stringify({
        id: 'custom',
        version: '1.0',
        familyWeights: {
          content: 1,
          behaviour: 1,
          temporal: 1,
          media: 1,
          network: 1,
          graph: 2,
          rating: 1,
          policy: 1,
        },
        modelWeight: 1,
        intercept: -3,
        thresholds: { label: 0.3, downrank: 0.5, hold: 0.7, escalate: 0.85, remove: 0.95 },
        hardFlagFloor: 0.8,
        minConfidenceForRemove: 0.6,
        autoRemove: false,
        disabledDetectors: [],
        disabledFamilies: [],
      }),
    );
    config.detection.policy = file;
    expect(loadPolicy(config).id).toBe('custom');

    config.detection.policy = join(dir, 'missing-policy.json');
    expect(() => loadPolicy(config)).toThrow(/Policy not found/u);
  });
});

describe('loadModel', () => {
  it('returns the baseline model when no path is given', () => {
    const { config } = makeConfig();
    expect(loadModel(config)).toBe(BASELINE_MODEL);
  });

  it('rejects missing and malformed model artifacts', () => {
    const { dir, config } = makeConfig();
    config.detection.modelPath = join(dir, 'missing-model.json');
    expect(() => loadModel(config)).toThrow(/Model not found/u);

    const bad = join(dir, 'bad-model.json');
    writeFileSync(bad, JSON.stringify({ version: 'x', intercept: 'oops', weights: [] }));
    config.detection.modelPath = bad;
    expect(() => loadModel(config)).toThrow(/Invalid model artifact/u);

    const good = join(dir, 'good-model.json');
    writeFileSync(
      good,
      JSON.stringify({
        version: '2026.11.custom',
        featureSpecVersion: '1.0.0',
        intercept: -2,
        weights: { 'text.exactDup': 2 },
        calibration: { kind: 'identity' },
      }),
    );
    config.detection.modelPath = good;
    const model = loadModel(config);
    expect(model.version).toBe('2026.11.custom');
    expect(model.intercept).toBe(-2);
  });
});

describe('prepareAnalysisContext', () => {
  it('builds a canonical prep with text/media matches and metadata', async () => {
    const { config } = makeConfig();
    const store = new SqliteStore(':memory:');
    await store.migrate();
    await store.ensureTenant('default');
    stores.push(store);

    await store.upsertReviewer({
      tenantId: 'default',
      externalHmac: 'prep-rev',
      accountCreatedAt: '2024-05-01T00:00:00Z',
      stats: { sharedDeviceCount: 2, priorFlags: 'junk' },
    });
    await store.upsertItem({
      tenantId: 'default',
      externalHmac: 'prep-item',
      category: 'tools',
    });
    const review = {
      id: 'prep-r1',
      itemId: 'item-1',
      reviewerId: 'reviewer-1',
      rating: 3,
      text: 'the drill battery lasted three hours and the case is fine',
      submittedAt: '2026-10-20T00:00:00.000Z',
    };
    const normalizedInput = undefined;
    void normalizedInput;
    const record = await store.upsertReview({
      tenantId: 'default',
      externalHmac: 'prep-review-hmac',
      itemId: 'item-1',
      reviewerId: 'reviewer-1',
      rating: 3,
      text: review.text,
      textSha256: 'sha',
      simhash: 'sim',
      language: 'en',
      submittedAt: review.submittedAt,
      verified: true,
      context: {},
      media: [],
      sourceId: 'src',
    });

    const prepared = await prepareAnalysisContext(store, config, record);
    expect(prepared.canonical.itemId).toBe('item-1');
    expect(prepared.normalized.text.length).toBeGreaterThan(0);
    expect(prepared.analysis.metadata?.tenantId).toBe('default');
    expect(prepared.analysis.peer?.medianReviewsPerDay).toBe(0.5);
    expect(typeof prepared.analysis.now).toBe('string');

    const canonical2 = canonicalFromRecord(record);
    expect(canonical2.verifiedPurchase).toBe(true);
    const contextLost = { ...record, context: { verifiedKnown: false } };
    const fromLost = canonicalFromRecord(contextLost as never);
    // Unknown verified-ness is scrubbed into undefined for the detectors.
    expect(fromLost.verifiedPurchase).toBeUndefined();
  });
});
