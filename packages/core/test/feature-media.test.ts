import { describe, expect, it } from 'vitest';
import { extractMediaFeatures } from '../src';
import type { CanonicalReview, MediaMatch } from '../src/types';

const SUBMITTED = '2026-10-24T10:00:00.000Z';

function review(media: CanonicalReview['media']): CanonicalReview {
  return {
    id: 'r',
    itemId: 'i',
    reviewerId: 'u',
    rating: 4,
    text: 'text',
    submittedAt: SUBMITTED,
    media,
  };
}

function match(overrides: Partial<MediaMatch>): MediaMatch {
  return {
    reviewId: 'o',
    reviewerId: 'other',
    itemId: 'other',
    kind: 'near',
    distance: 8,
    ...overrides,
  };
}

describe('extractMediaFeatures', () => {
  it('zeroes everything without media', () => {
    const f = extractMediaFeatures(review(undefined), {});
    expect(f['media.present']).toBe(0);
    expect(f['media.count']).toBe(0);
    expect(f['media.exifStripped']).toBe(0);
    expect(f['media.provisional']).toBe(0);
  });

  it('flags presence, count and provisional for hashless media', () => {
    const f = extractMediaFeatures(review([{ url: 'https://x/y.jpg' }]), {});
    expect(f['media.present']).toBe(1);
    expect(f['media.count']).toBe(1);
    expect(f['media.provisional']).toBe(1);
    expect(f['media.exifStripped']).toBe(0.5);
  });

  it('is not provisional when any item carries a hash or exif', () => {
    const hashed = extractMediaFeatures(review([{ sha256: 'abc' }]), {});
    expect(hashed['media.provisional']).toBe(0);
    expect(hashed['media.exifStripped']).toBe(0.5);

    const withExif = extractMediaFeatures(review([{ exif: { Software: 'gimp' } }]), {});
    expect(withExif['media.provisional']).toBe(0);
    // exifStripped only checks camera Make/Model, not arbitrary exif.
    expect(withExif['media.exifStripped']).toBe(0.5);
  });

  it('marks exif stripped only when no media item carries camera Make/Model', () => {
    const stripped = extractMediaFeatures(review([{ sha256: 'x' }]), {});
    expect(stripped['media.exifStripped']).toBe(0.5);

    const kept = extractMediaFeatures(review([{ sha256: 'x', exif: { Make: 'Canon' } }]), {});
    expect(kept['media.exifStripped']).toBe(0);
    expect(kept['media.editSoftware']).toBe(0);
  });

  it('detects edit software case-insensitively via exif lookup strategies', () => {
    expect(
      extractMediaFeatures(review([{ exif: { Software: 'Adobe Photoshop 2025' } }]), {})[
        'media.editSoftware'
      ],
    ).toBe(1);
    expect(
      extractMediaFeatures(review([{ exif: { software: 'GIMP' } }]), {})['media.editSoftware'],
    ).toBe(1);
    expect(
      extractMediaFeatures(review([{ exif: { softwareTag: 'Meitu' } }]), {})['media.editSoftware'],
    ).toBe(0);
    // odd-case key resolved by case-insensitive scan
    expect(
      extractMediaFeatures(review([{ sha256: 'x', exif: { SOFTWARE: 'canva pro' } }]), {})[
        'media.editSoftware'
      ],
    ).toBe(1);
  });

  it('detects screenshots only for wide/tall PNGs above the ratio gate', () => {
    const wide = { mime: 'image/png', width: 1600, height: 800, sha256: 'a' };
    expect(extractMediaFeatures(review([wide]), {})['media.screenshot']).toBe(1);

    const tooSmall = { mime: 'image/png', width: 800, height: 400, sha256: 'a' };
    expect(extractMediaFeatures(review([tooSmall]), {})['media.screenshot']).toBe(0);

    const notPng = { mime: 'image/jpeg', width: 1600, height: 800, sha256: 'a' };
    expect(extractMediaFeatures(review([notPng]), {})['media.screenshot']).toBe(0);

    const equal = { mime: 'image/png', width: 1600, height: 1600, sha256: 'a' };
    expect(extractMediaFeatures(review([equal]), {})['media.screenshot']).toBe(0);
  });

  it('flags time mismatches when capture precedes by > 1 day or follows the submission', () => {
    const stale = extractMediaFeatures(
      review([{ capturedAt: '2020-01-01T00:00:00.000Z', sha256: 'a' }]),
      {},
    );
    expect(stale['media.timeMismatch']).toBe(1);

    // capture 12 hours earlier is fine.
    const recent = extractMediaFeatures(
      review([{ capturedAt: '2026-10-23T22:00:00.000Z', sha256: 'a' }]),
      {},
    );
    expect(recent['media.timeMismatch']).toBe(0);

    // capture in the future is a mismatch.
    const future = extractMediaFeatures(
      review([{ capturedAt: '2026-10-30T00:00:00.000Z', sha256: 'a' }]),
      {},
    );
    expect(future['media.timeMismatch']).toBe(1);
  });

  it('ignores unparseable capture timestamps', () => {
    const f = extractMediaFeatures(review([{ capturedAt: 'not-a-date', sha256: 'a' }]), {});
    expect(f['media.timeMismatch']).toBe(0);
  });

  it('scores exact cross-account reuse at 1', () => {
    const f = extractMediaFeatures(review([{ sha256: 'a' }]), {
      mediaMatches: [match({ kind: 'exact' })],
    });
    expect(f['media.exactReuse']).toBe(1);
    expect(f['media.matchCount']).toBe(1);
  });

  it('maps near reuse by distance tiers 6/10/14', () => {
    for (const [distance, expected] of [
      [6, 1],
      [7, 0.6],
      [10, 0.6],
      [11, 0.25],
      [14, 0.25],
      [15, 0],
    ] as Array<[number, number]>) {
      const f = extractMediaFeatures(review([{ sha256: 'a' }]), {
        mediaMatches: [match({ distance })],
      });
      expect(f['media.nearReuse']).toBe(expected);
    }
  });

  it('ignores self-matches (same reviewer AND item)', () => {
    const f = extractMediaFeatures(review([{ sha256: 'a' }]), {
      mediaMatches: [match({ reviewerId: 'u', itemId: 'i', kind: 'exact' })],
    });
    expect(f['media.exactReuse']).toBe(0);
    expect(f['media.matchCount']).toBe(1);
  });

  it('takes the strongest reuse across multiple matches', () => {
    const f = extractMediaFeatures(review([{ sha256: 'a' }]), {
      mediaMatches: [
        match({ distance: 12 }),
        match({ reviewId: 'o2', reviewerId: 'zz', kind: 'exact' }),
      ],
    });
    expect(f['media.nearReuse']).toBe(0.25);
    expect(f['media.exactReuse']).toBe(1);
  });
});
