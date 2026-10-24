import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE_MODEL, getPolicyPreset } from '@revlyra/core';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { ReviewService } from '../src/engine/service';
import { JobWorker } from '../src/jobs';
import { Entitlements } from '../src/license';
import { SqliteStore } from '../src/store/sqlite';

const dir = mkdtempSync(join(tmpdir(), 'revlyra-worker-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('job worker', () => {
  it('scans a files source and imports reviews', async () => {
    const file = join(dir, 'reviews.json');
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'w1',
          product_id: 'p1',
          user_id: 'u1',
          stars: 4,
          review:
            'I used this for two weeks. The battery lasted about four hours and the case is solid.',
          created_at: '2026-10-20T10:00:00Z',
        },
        {
          id: 'w2',
          product_id: 'p1',
          user_id: 'u2',
          stars: 2,
          review: 'The motor stopped after nine days and support did not answer my email.',
          created_at: '2026-10-21T10:00:00Z',
        },
      ]),
    );

    const config = loadConfig({
      cwd: dir,
      overrides: {
        database: { driver: 'sqlite', path: ':memory:' },
        privacy: { pepper: 'worker-test-pepper-long-enough' },
        license: { key: '' },
      },
    });
    const store = new SqliteStore(':memory:');
    await store.migrate();
    await store.ensureTenant('default');
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
    const source = await store.createSource({
      tenantId: 'default',
      kind: 'files',
      name: 'worker-test',
      config: { path: file, format: 'json' },
      mapping: {},
    });
    const job = await store.createJob({
      tenantId: 'default',
      kind: 'scan',
      payload: { sourceId: source.id },
    });

    const worker = new JobWorker({ store, service, config });
    const processed = await worker.runOnce();
    expect(processed).toBe(1);

    const completed = await store.getJob('default', job.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.result?.imported).toBe(2);

    const corpus = await store.getCorpusStats('default');
    expect(corpus.totalReviews).toBe(2);

    await worker.stop();
    await store.close();
  });
});
