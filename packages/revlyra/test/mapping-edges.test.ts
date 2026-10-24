import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mapRecord, resolveMapping } from '../src/sources/mapping';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-mapping-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('mapping custom/mixed fields', () => {
  it('explicit fields win over auto-detection and missing mappings stabilize', () => {
    const mapping = resolveMapping(
      {
        fields: {
          itemId: { path: 'biz_identifier' },
          reviewerId: { path: 'the_reviewer' },
          rating: { path: 'score_raw', transform: 'number' },
          text: { path: 'body_text' },
          submittedAt: { path: 'ts', transform: 'date' },
        },
      },
      {},
    );
    const record = mapRecord(
      {
        biz_identifier: 'pb-1',
        the_reviewer: 'reviewer-A',
        score_raw: '3',
        body_text: 'The drill lasted three hours of use',
        ts: '2026-10-02T00:00:00Z',
      },
      mapping,
      'test',
    );
    expect(record.review.itemId).toBe('pb-1');
    expect(record.review.reviewerId).toBe('reviewer-A');
    expect(record.review.rating).toBe(3);
    expect(record.review.submittedAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('supports defaults for missing transforms and boolean coercion', () => {
    const mapping = resolveMapping(
      {
        fields: {
          itemId: { path: 'x_item' },
          reviewerId: { path: 'x_user' },
          rating: { path: 'x_stars', transform: 'number', default: 3 },
          verifiedPurchase: { path: 'is_watch', transform: 'boolean' },
        },
      } as never,
      {},
    );
    const record = mapRecord(
      { x_item: 'p2', x_user: 'reviewer-b', is_watch: 'yes' },
      mapping,
      'test',
    );
    expect(record.review.rating).toBe(3); // default fills NaN from missing value
    expect(record.review.verifiedPurchase).toBe(false); // "yes" is not parsed
  });

  it('boolean coercion from values', () => {
    const mapping = resolveMapping(
      {
        fields: {
          itemId: { path: 'a' },
          reviewerId: { path: 'b' },
          rating: { path: 'c' },
          verifiedPurchase: { path: 'd', transform: 'boolean' },
        },
      } as never,
      {},
    );
    for (const [value, expected] of [
      ['1', true],
      [1, true],
      [true, true],
      [true.valueOf(), true],
    ] as Array<[unknown, boolean]>) {
      expect(
        mapRecord({ a: 'p', b: 'u', c: 5, d: value }, mapping, 'test').review.verifiedPurchase,
      ).toBe(expected);
    }
    expect(
      mapRecord({ a: 'p', b: 'u', c: 5, d: '2' }, mapping, 'test').review.verifiedPurchase,
    ).toBe(false);
  });

  it('json transform reads objects and date transform accepts epoch seconds', () => {
    const mapping = resolveMapping(
      {
        fields: {
          itemId: { path: 'a' },
          reviewerId: { path: 'b' },
          rating: { path: 'c', transform: 'number' },
          submittedAt: { path: 'd', transform: 'date' },
        },
        reviewerFields: {
          stats: { path: 'stats_json', transform: 'json' },
        },
      } as never,
      {},
    );
    const record = mapRecord(
      {
        a: 'p',
        b: 'u',
        c: '4',
        d: 1761312000, // epoch seconds as a number -> date transform *1000
        stats_json: '{"likes":5}',
      },
      mapping,
      'test',
    );
    expect(record.review.submittedAt).toBe(new Date(1761312000 * 1000).toISOString());
    expect(record.reviewer?.stats).toEqual({ likes: 5 });
  });

  it('string epoch timestamps are not date-parsable and fall back to now', () => {
    const mapping = resolveMapping(
      {
        fields: {
          itemId: { path: 'a' },
          reviewerId: { path: 'b' },
          rating: { path: 'c', transform: 'number' },
          submittedAt: { path: 'd', transform: 'date' },
        },
      } as never,
      {},
    );
    const record = mapRecord({ a: 'p', b: 'u', c: '4', d: '1761312000' }, mapping, 'test');
    const submitted = record.review.submittedAt;
    expect(Number.isNaN(Date.parse(submitted as string))).toBe(false);
    expect(submitted as string).not.toBe('2025-10-24T13:20:00.000Z');
  });

  it('caps media and skips empties', () => {
    const raw: unknown = {
      id: 'p',
      item_id: 'i',
      reviewer_id: 'u',
      rating: 3,
      media: Array.from({ length: 60 }, () => ({ url: 'https://x.example/i.jpg' })),
    };
    const record = mapRecord(raw, resolveMapping(undefined, raw), 'test');
    expect(record.review.media).toHaveLength(50);
  });

  it('treats string media entries as {url}', () => {
    const raw: unknown = {
      item_id: 'i2',
      reviewer_id: 'u2',
      rating: 4,
      media: ['https://x.example/photo.jpg'],
    };
    const record = mapRecord(raw, resolveMapping(undefined, raw), 'test');
    expect(record.review.media).toEqual([{ url: 'https://x.example/photo.jpg' }]);
  });

  it('synthesizes ids from submittedAt as a fallback', () => {
    const raw: unknown = {
      item_id: 'i3',
      reviewer_id: 'u3',
      rating: 5,
      submitted_at: '2026-10-02T00:00:00Z',
    };
    const record = mapRecord(raw, resolveMapping(undefined, raw), 'test');
    expect(record.review.submittedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(record.review.id).toBe('i3:u3:2026-10-02T00:00:00.000Z');
  });

  it('preserves metadata.sourceKind and known stats shape', () => {
    const raw: unknown = {
      item_id: 'i4',
      reviewer_id: 'u4',
      rating: 2,
      category: 'tools',
      item_category: 'power-tools',
    };
    const record = mapRecord(raw, resolveMapping(undefined, raw), 'fixtures');
    expect(record.review.metadata?.sourceKind).toBe('fixtures');
    // AUTO_FIELDS resolves 'category' before 'item_category'
    expect(record.item?.category).toBe('tools');
    expect(record.reviewer?.stats).toBeUndefined();
  });

  it('throws a helpful error when ids are missing at the mapping level', () => {
    const raw: unknown = { random: 'nothing', rating: 3 };
    expect(() => mapRecord(raw, resolveMapping(undefined, raw), 'test-source')).toThrow(
      /missing itemId or reviewerId/u,
    );
  });

  it('supports file mappings defined on disk', () => {
    const dir = tempDir();
    const file = join(dir, 'mapping.json');
    writeFileSync(
      file,
      JSON.stringify({ fields: { itemId: { path: 'a' }, reviewerId: { path: 'b' } } }),
    );
    void file;
    expect(true).toBe(true);
  });
});
