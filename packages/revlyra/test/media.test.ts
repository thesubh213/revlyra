import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { fetchImage } from '../src/media/fetch-image';
import { hammingHex, hashImage } from '../src/media/phash';

function gradient(): Buffer {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      raw[index] = Math.round((x / width) * 255);
      raw[index + 1] = Math.round((y / height) * 255);
      raw[index + 2] = Math.round(((x + y) / (width + height)) * 255);
    }
  }
  return raw;
}

describe('media hashing', () => {
  it('produces stable hashes through resize and JPEG recompression', async () => {
    const original = await sharp(gradient(), {
      raw: { width: 64, height: 64, channels: 3 },
    })
      .png()
      .toBuffer();
    const modified = await sharp(original).resize(48, 48).jpeg({ quality: 70 }).toBuffer();

    const first = await hashImage(original);
    const second = await hashImage(modified);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.phash).toHaveLength(16);
    expect(first!.dhash).toHaveLength(16);
    expect(first!.sha256).toHaveLength(64);
    expect(hammingHex(first!.phash, second!.phash)).toBeLessThanOrEqual(12);
    expect(hammingHex(first!.dhash, second!.dhash)).toBeLessThanOrEqual(12);
  });

  it('decodes a bounded data URL', async () => {
    const buffer = await sharp(gradient(), {
      raw: { width: 64, height: 64, channels: 3 },
    })
      .png()
      .toBuffer();
    const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
    const image = await fetchImage(dataUrl);
    expect(image.mime).toBe('image/png');
    expect(image.buffer.byteLength).toBeGreaterThan(0);
  });
});
