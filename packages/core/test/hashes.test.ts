import { describe, expect, it } from 'vitest';
import { minhashJaccard, minhashSignature } from '../src/hash/minhash';
import { sha256Hex } from '../src/hash/sha256';
import { hammingDistanceHex, simhashHex } from '../src/hash/simhash';
import { jaccard } from '../src/normalize/text';

describe('sha256', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('handles multi-block inputs', () => {
    expect(sha256Hex('a'.repeat(1000))).toHaveLength(64);
    expect(sha256Hex('a'.repeat(1000))).not.toBe(sha256Hex('a'.repeat(1001)));
  });
});

describe('simhash', () => {
  it('keeps similar text close and unrelated text far', () => {
    const a = simhashHex({
      tokens: 'the battery lasts about eight hours and charging is fast'.split(' '),
      fingerprintText: 'the battery lasts about eight hours and charging is fast',
    });
    const b = simhashHex({
      tokens: 'the battery lasts around eight hours and the charging is fast'.split(' '),
      fingerprintText: 'the battery lasts around eight hours and the charging is fast',
    });
    const c = simhashHex({
      tokens: 'the restaurant had terrible service and the soup was cold'.split(' '),
      fingerprintText: 'the restaurant had terrible service and the soup was cold',
    });
    // Short reviews are inherently noisy for SimHash; the engine also uses
    // MinHash/token Jaccard for short-text near-duplicates.
    expect(hammingDistanceHex(a, b)).toBeLessThanOrEqual(18);
    expect(hammingDistanceHex(a, c)).toBeGreaterThan(18);
  });

  it('is stable for a small edit in longer text', () => {
    const base =
      'i bought this drill for my workshop three weeks ago the twelve millimeter chuck holds bits securely and the battery lasted about four hours on a full charge it is heavier than my old drill but the extra power is worth it the case feels cheap though';
    const edited = base.replace('about four hours', 'around four hours');
    const a = simhashHex({ tokens: base.split(/\s+/), fingerprintText: base });
    const b = simhashHex({ tokens: edited.split(/\s+/), fingerprintText: edited });
    expect(hammingDistanceHex(a, b)).toBeLessThanOrEqual(6);
  });
});

describe('minhash', () => {
  it('estimates jaccard similarity', () => {
    const left = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const right = ['a', 'b', 'c', 'd', 'e', 'f', 'x', 'y'];
    const estimate = minhashJaccard(minhashSignature(left), minhashSignature(right));
    expect(estimate).toBeGreaterThan(0.45);
    expect(estimate).toBeLessThan(0.95);
  });

  it('keeps short near-duplicate tokens close by Jaccard', () => {
    const left = 'the battery lasts about eight hours and charging is fast'.split(' ');
    const right = 'the battery lasts around eight hours and the charging is fast'.split(' ');
    expect(jaccard(left, right)).toBeGreaterThan(0.7);
  });
});
