import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Bytes, sha256Hex } from '../src';

const encoder = new TextEncoder();

const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const abcSha = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function cryptoSha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

describe('sha256Hex', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe(emptySha);
    expect(sha256Hex('abc')).toBe(abcSha);
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('encodes UTF-8 for non-ASCII input', () => {
    expect(sha256Hex('完全性')).toBe(cryptoSha256Hex('完全性'));
    expect(sha256Hex('✓')).toBe(cryptoSha256Hex('✓'));
    expect(sha256Hex('✓')).not.toBe(cryptoSha256Hex('x'));
  });

  it('returns 64 lowercase hex chars', () => {
    const hex = sha256Hex('any payload');
    expect(hex).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('collapses distinct inputs into distinct hashes', () => {
    const many = new Set([1, 2, 3].map((n) => sha256Hex(`review ${n}`)));
    expect(many.size).toBe(3);
  });
});

describe('sha256Bytes', () => {
  it('produces 32 bytes equal to the hash of the raw bytes', () => {
    const out = sha256Bytes(encoder.encode('abc'));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(32);
    expect(Buffer.from(out).toString('hex')).toBe(abcSha);
  });

  it('handles the empty input (single padding block)', () => {
    const out = sha256Bytes(new Uint8Array(0));
    expect(Buffer.from(out).toString('hex')).toBe(emptySha);
  });

  it('is stable across block boundaries: 55, 56, 57, 64, 65 bytes', () => {
    // 55 bytes: exactly one length byte fits with padding in one block.
    // 56+ bytes: forces an extra padding block.
    for (const len of [0, 1, 55, 56, 57, 63, 64, 65, 120, 128, 129]) {
      const input = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) input[i] = (i * 37 + 11) % 256;
      const expected = createHash('sha256').update(input).digest();
      const out = sha256Bytes(input);
      expect(out.length).toBe(32);
      expect(Buffer.compare(Buffer.from(out), expected)).toBe(0);
    }
  });

  it('matches utf-8-aware hashing of multi-byte characters', () => {
    const text = 'naïve café 北京 🙂';
    const expected = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    expect(Buffer.from(sha256Bytes(encoder.encode(text)))).toEqual(Buffer.from(expected, 'hex'));
    expect(sha256Hex(text)).toBe(expected);
  });
});
