import { describe, expect, it } from 'vitest';
import { fnv1a32, hamming64, hash64, hash64ToHex, hexToHash64, popcount32 } from '../src';

describe('fnv1a32', () => {
  it('returns the seed for empty input', () => {
    // 0x811c9dc5 = 2166136261
    expect(fnv1a32('')).toBe(2166136261);
    expect(fnv1a32('', 123)).toBe(123);
  });

  it('is deterministic and produces unsigned 32-bit output', () => {
    const a = fnv1a32('hello');
    const b = fnv1a32('hello');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffffffff);
  });

  it('spreads inputs apart', () => {
    const values = ['a', 'b', 'ab', 'ba', 'abc', 'test', '故事', '🙂'];
    const hashes = new Set(values.map((v) => fnv1a32(v)));
    expect(hashes.size).toBe(values.length);
  });

  it('hashes non-ASCII code units by UTF-16 pair semantics', () => {
    expect(fnv1a32('é')).not.toBe(fnv1a32('e'));
  });

  it('accepts a custom seed', () => {
    expect(fnv1a32('x', 0)).not.toBe(fnv1a32('x', 1));
    expect(fnv1a32('x', 0)).not.toBe(fnv1a32('x'));
  });
});

describe('hash64', () => {
  it('produces a stable 64-bit pair', () => {
    const a = hash64('hello world');
    const b = hash64('hello world');
    expect(a).toEqual(b);
    expect(Object.is(a.hi, a.hi >>> 0)).toBe(true);
    expect(Object.is(a.lo, a.lo >>> 0)).toBe(true);
  });

  it('differences on any single character change', () => {
    const base = hash64('review-1001');
    const second = hash64('review-1002');
    const third = hash64('review 1001');
    expect(base.hi).not.toBe(second.hi);
    expect(base).not.toEqual(third);
  });

  it('uses different seeds for the hi and lo streams', () => {
    const value = 'diversity';
    const single = fnv1a32(value);
    const { hi, lo } = hash64(value);
    // The two streams use different seeds, so they should usually differ.
    const bothMatchSeed = hi === single && lo === single;
    expect(bothMatchSeed).toBe(false);
    expect(hi).not.toBe(lo);
  });
});

describe('popcount32', () => {
  it('counts zero bits for zero', () => {
    expect(popcount32(0)).toBe(0);
  });

  it('counts single bits correctly', () => {
    expect(popcount32(1)).toBe(1);
    expect(popcount32(2)).toBe(1);
    expect(popcount32(0x80000000)).toBe(1);
  });

  it('counts all bits of 0xffffffff', () => {
    expect(popcount32(0xffffffff)).toBe(32);
  });

  it('counts alternating bit patterns', () => {
    expect(popcount32(0xaaaaaaaa)).toBe(16);
    expect(popcount32(0x55555555)).toBe(16);
  });

  it('counts known mixed values', () => {
    expect(popcount32(0x0000ffff)).toBe(16);
    expect(popcount32(0xf0f0f0f0)).toBe(16);
    expect(popcount32(0x12345678)).toBe(13);
  });
});

describe('hamming64', () => {
  const maxAll: { hi: number; lo: number } = { hi: 0xffffffff, lo: 0xffffffff };
  const zeroAll: { hi: number; lo: number } = { hi: 0, lo: 0 };

  it('is zero for identical inputs', () => {
    expect(hamming64(maxAll, maxAll)).toBe(0);
    expect(hamming64(zeroAll, zeroAll)).toBe(0);
    const value = hash64('hamming');
    expect(hamming64(value, value)).toBe(0);
  });

  it('is 64 for bitwise complements', () => {
    expect(hamming64(maxAll, zeroAll)).toBe(64);
    expect(hamming64(zeroAll, maxAll)).toBe(64);
  });

  it('is symmetric', () => {
    const a = hash64('one');
    const b = hash64('two');
    expect(hamming64(a, b)).toBe(hamming64(b, a));
  });

  it('counts single flipped bits', () => {
    expect(hamming64({ hi: 1, lo: 0 }, zeroAll)).toBe(1);
    expect(hamming64({ hi: 0, lo: 0x80000000 }, zeroAll)).toBe(1);
  });
});

describe('hash64ToHex / hexToHash64', () => {
  it('pads both halves to 8 hex chars', () => {
    expect(hash64ToHex({ hi: 0, lo: 0 })).toBe('0000000000000000');
    expect(hash64ToHex({ hi: 0x1, lo: 0x2 })).toBe('0000000100000002');
    expect(hash64ToHex({ hi: 0xffffffff, lo: 0xdeadbeef })).toBe('ffffffffdeadbeef');
  });

  it('round-trips through hexToHash64', () => {
    for (const input of ['alpha', 'beta', '评论', 'x']) {
      const hex = hash64ToHex(hash64(input));
      expect(hexToHash64(hex)).toEqual(hash64(input));
    }
  });

  it('accepts an 0x prefix and zero-pads short hex', () => {
    expect(hexToHash64('0x0000000100000002')).toEqual({ hi: 1, lo: 2 });
    expect(hexToHash64('2')).toEqual({ hi: 0, lo: 2 });
    expect(hexToHash64('000000000000000f')).toEqual({ hi: 0, lo: 15 });
  });

  it('keeps the tail of overly long hex', () => {
    // 26-char input: padStart is a no-op, slice(-16) keeps the last 16 chars.
    expect(hexToHash64('abcdefabcdefabcdef0000000f')).toEqual({
      hi: 0xefabcdef,
      lo: 15,
    });
  });
});
