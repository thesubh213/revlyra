import { describe, expect, it } from 'vitest';
import { mapRecord, resolveMapping } from '../src/sources/mapping';

describe('source mapping', () => {
  it('auto-detects common field names', () => {
    const record = {
      id: 'r1',
      product_id: 'p1',
      user_id: 'u1',
      stars: 4,
      review: 'The battery lasted eight hours and the case is solid.',
      created_at: '2026-10-20T10:00:00Z',
      verified: 1,
      images: ['https://example.com/a.jpg'],
    };
    const mapped = mapRecord(record, resolveMapping(undefined, record), 'rest');
    expect(mapped.review.itemId).toBe('p1');
    expect(mapped.review.reviewerId).toBe('u1');
    expect(mapped.review.rating).toBe(4);
    expect(mapped.review.verifiedPurchase).toBe(true);
    expect(mapped.review.submittedAt).toBe('2026-10-20T10:00:00.000Z');
    expect(mapped.review.media?.[0]?.url).toBe('https://example.com/a.jpg');
  });

  it('honors explicit nested mappings and defaults', () => {
    const record = {
      data: { review: { body: 'Nested review text', stars: '5' } },
      author: { id: 'a1', joined: 1700000000 },
      item: { sku: 'sku-1' },
      attachments: [{ meta: { hash: 'abc' }, url: 'https://example.com/x.png' }],
    };
    const mapping = {
      fields: {
        itemId: 'item.sku',
        reviewerId: 'author.id',
        rating: { path: 'data.review.stars', transform: 'number' as const },
        text: 'data.review.body',
        submittedAt: { path: 'author.joined', transform: 'date' as const },
      },
      mediaField: 'attachments',
      mediaFields: { sha256: 'meta.hash', url: 'url' },
    };
    const mapped = mapRecord(record, resolveMapping(mapping, record), 'mongodb');
    expect(mapped.review.rating).toBe(5);
    expect(mapped.review.submittedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(mapped.review.media?.[0]?.sha256).toBe('abc');
  });

  it('throws when required identifiers are missing', () => {
    const record = { rating: 5 };
    expect(() => mapRecord(record, resolveMapping({ fields: {} }, record), 'files')).toThrow(
      /itemId/u,
    );
  });
});
