import { describe, expect, it } from 'vitest';
import { minhashBandKeys, minhashJaccard, minhashSignature } from '../src';
import { shingles } from '../src/normalize/text';

const PRIME = 4294967291;

describe('minhashSignature', () => {
  it('returns an all-PRIME signature for an empty shingle set', () => {
    const signature = minhashSignature(new Set<string>([]));
    expect(signature).toHaveLength(64);
    expect(signature.every((v) => v === PRIME)).toBe(true);
  });

  it('returns PRIME for every component when no shingles are provided', () => {
    const signature = minhashSignature([]);
    expect(signature).toHaveLength(64);
    expect(signature.every((v) => v === PRIME)).toBe(true);
  });

  it('is deterministic for the same shingle set', () => {
    const shinglesA = ['a b c', 'b c d', 'c d e'];
    expect(minhashSignature(shinglesA)).toEqual(minhashSignature(shinglesA));
  });

  it('stops after 5000 shingles', () => {
    const huge = Array.from({ length: 5001 }, (_, i) => `shingle-${i}`);
    const capped = minhashSignature(huge);
    expect(capped).toHaveLength(64);
    // Same result as handing exactly 5000.
    expect(minhashSignature(huge.slice(0, 5000))).toEqual(capped);
  });

  it('produces values within [0, PRIME)', () => {
    const signature = minhashSignature(
      shingles('battery lasts four hours on the drill kit every day'.split(' '), 3),
      32,
    );
    for (const value of signature) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(PRIME);
    }
  });
});

describe('minhashJaccard', () => {
  it('is 1 for identical signatures', () => {
    const sig = minhashSignature(['one', 'two', 'three']);
    expect(minhashJaccard(sig, sig)).toBe(1);
  });

  it('is 0 for two empty signatures', () => {
    expect(minhashJaccard([], [])).toBe(0);
  });

  it('is 1 for two all-PRIME signatures', () => {
    expect(minhashJaccard(minhashSignature([]), minhashSignature([]))).toBe(1);
  });

  it('estimates similarity bounded between 0 and 1', () => {
    const a = minhashSignature(shingles('battery drill torque chuck'.split(' '), 3), 64);
    const b = minhashSignature(shingles('battery drill torque chuck'.split(' '), 3), 64);
    const c = minhashSignature(shingles('camera lens photos night shots'.split(' '), 3), 64);
    for (const v of [minhashJaccard(a, b), minhashJaccard(a, c)]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(minhashJaccard(a, c)).toBeLessThan(minhashJaccard(a, b));
  });

  it('handles signatures of different lengths using the shorter', () => {
    const long = minhashSignature(['a', 'b', 'c', 'd'], 64);
    const short = long.slice(0, 2);
    expect(minhashJaccard(long, short)).toBe(1);
  });
});

describe('minhashBandKeys', () => {
  it('returns 16 keys of 4 comma-joined values for the default 64-permutation signature', () => {
    const signature = minhashSignature(shingles('battery drill torque chuck axle'.split(' '), 5));
    const keys = minhashBandKeys(signature);
    expect(keys).toHaveLength(16);
    for (const key of keys) expect(key).toBe(key.split(',').join(','));
    expect(keys[0].split(',')).toHaveLength(4);
  });

  it('returns [] for an empty signature', () => {
    expect(minhashBandKeys([])).toEqual([]);
  });

  it('supports custom band counts with at least one row per band', () => {
    const signature = minhashSignature(['x', 'y'], 32);
    const keys = minhashBandKeys(signature, 8);
    expect(keys).toHaveLength(8);
    // 32 values / 8 bands -> 4 rows per band.
    expect(keys[0].split(',')).toHaveLength(4);
  });

  it('drops the tail when the signature length is not divisible by band count', () => {
    // 5 values in 2 bands -> rows = floor(5/2) = 2 -> bands cover [0,2) and [2,4);
    // the 5th value falls outside any full band and is not emitted.
    const keys = minhashBandKeys([1, 2, 3, 4, 5], 2);
    expect(keys).toEqual(['1,2', '3,4']);
  });
});
