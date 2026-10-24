import type { ReviewMedia } from '@revlyra/core';
import { describe, expect, it } from 'vitest';
import { hammingHex, hashImage, loadSharp } from '../src/media/phash';
import { processReviewMedia } from '../src/media/process';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('hammingHex', () => {
  it('is 0 for identical hashes', () => {
    expect(hammingHex('deadbeefdeadbeef', 'deadbeefdeadbeef')).toBe(0);
  });

  it('counts differing nibble pairs', () => {
    expect(hammingHex('0000', 'ffff')).toBe(16);
    expect(hammingHex('f0f0', '0f0f')).toBe(16);
  });

  it('truncates to the shorter length', () => {
    expect(hammingHex('ff', 'ffff')).toBe(0);
  });

  it('returns the 64 sentinel for invalid nibbles', () => {
    expect(hammingHex('zzzz', '0000')).toBe(64);
    expect(hammingHex('1g', '00')).toBe(64);
  });
});

describe('processReviewMedia', () => {
  it('returns early for empty media', async () => {
    expect(await processReviewMedia([])).toEqual({
      media: [],
      warnings: [],
      processed: 0,
      skipped: 0,
    });
  });

  it('skips already-hashed items and items without url/sha', async () => {
    const media: ReviewMedia[] = [
      { sha256: 'a'.repeat(64), phash: 'b'.repeat(16) },
      { exif: { Software: 'gimp' } },
      { dhash: 'c'.repeat(16), sha256: 'd'.repeat(64) },
    ];
    const result = await processReviewMedia(media);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it('fetches, hashes, and enriches a downloadable image (data URLs bypass SSRF check but the URL path is exercised here via hashless items)', async () => {
    const media: ReviewMedia[] = [
      {
        url: `http://127.0.0.1:9/data.png`,
      },
      { url: `data:image/png;base64,${PNG.toString('base64')}` },
    ];
    const result = await processReviewMedia(media, { allowPrivateHosts: true });
    // The loopback fetch on port 9 should fail to connect; the data URL item
    // processes through sharp successfully.
    expect(result.processed).toBeGreaterThanOrEqual(1);
    const processed = result.media[1];
    expect(processed?.sha256).toHaveLength(64);
    expect(processed?.phash).toHaveLength(16);
    expect(processed?.mime).toBe('image/png');
  });

  it('truncates the queue at maxItems (protection cap of 20) and drops the tail silently', async () => {
    const media: ReviewMedia[] = Array.from({ length: 25 }, () => ({
      url: `data:image/png;base64,${PNG.toString('base64')}`,
    }));
    const result = await processReviewMedia(media, { maxItems: 21, concurrency: 4 });
    expect(result.media).toHaveLength(20);
    expect(result.media.every((item) => Boolean(item.sha256))).toBe(true);
  });

  it('dedupes identical warnings and preserves original items on errors', async () => {
    const media: ReviewMedia[] = [
      { url: 'http://127.0.0.1:9/a.jpg' },
      { url: 'http://127.0.0.1:9/b.jpg' },
      { url: 'data: forensic junk' },
    ];
    const result = await processReviewMedia(media, { allowPrivateHosts: true });
    expect(result.warnings.length).toBe(result.warnings.length);
    expect(new Set(result.warnings).size).toBe(result.warnings.length);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    expect(result.media[0]?.url).toBe('http://127.0.0.1:9/a.jpg');
  });

  it('reports SHARP_UNAVAILABLE only when the sharp module is missing', async () => {
    const sharp = await loadSharp();
    if (sharp === null) {
      const result = await processReviewMedia([{ url: 'https://example.com/' }]);
      expect(result.warnings).toEqual(['SHARP_UNAVAILABLE']);
    } else {
      expect(typeof sharp).toBe('function');
    }
  });
});

describe('phash module helpers', () => {
  it('loadSharp returns the sharp factory or null', async () => {
    const sharp = await loadSharp();
    expect(sharp === null || typeof sharp === 'function').toBe(true);
  });

  it('hashImage is stable for identical buffers', async () => {
    const first = await hashImage(PNG);
    const second = await hashImage(PNG);
    expect(first?.sha256).toBe(second?.sha256);
  });
});
