import { describe, expect, it } from 'vitest';
import { hammingDistanceHex, simhash, simhashBandKeys, simhashHex } from '../src';

function longText(seed: string): string {
  const words = [
    'battery',
    'lasted',
    'hours',
    'drill',
    'chuck',
    'secure',
    'torque',
    'screws',
    'value',
    'tools',
    'kit',
    'charge',
  ];
  const sentences: string[] = [];
  let counter = 0;
  while (sentences.length < 40) {
    const s = `${seed} ${words[counter % words.length]} review sentence number ${counter} about the product performance overall.`;
    sentences.push(s);
    counter += 1;
  }
  return sentences.join(' ');
}

describe('simhash', () => {
  it('returns a Hash64 pair for empty input', () => {
    const result = simhash({ tokens: [], fingerprintText: '' });
    expect(result).toHaveProperty('hi');
    expect(result).toHaveProperty('lo');
  });

  it('is deterministic', () => {
    const input = { tokens: ['a', 'b', 'c'], fingerprintText: 'a b c' };
    expect(simhash(input)).toEqual(simhash(input));
  });

  it('identical inputs have distance zero', () => {
    const input = {
      tokens: ['one', 'two', 'three', 'four'],
      fingerprintText: 'one two three four',
    };
    expect(simhash(input)).toEqual(simhash(input));
  });

  it('keeps short inputs very close under minor edits (short review path)', () => {
    const base = 'I love this product so much value';
    const a = simhashHex({ tokens: base.split(' '), fingerprintText: base });
    const b = simhashHex({
      tokens: base.split(' ').concat(['everyone']),
      fingerprintText: base,
    });
    expect(Number.parseInt(a, 16)).toBeTruthy();
    expect(hammingDistanceHex(a, b)).toBeLessThanOrEqual(24);
  });
});

describe('simhashHex', () => {
  it('returns 16 hex characters', () => {
    const hex = simhashHex({
      tokens: Array.from({ length: 50 }, (_, i) => `w${i}`),
      fingerprintText: 'w'.repeat(300),
    });
    expect(hex).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('separates unrelated texts far apart and related texts close', () => {
    const near = simhashHex({
      tokens: longText('battery').split(' '),
      fingerprintText: longText('battery'),
    });
    const edited = simhashHex({
      tokens: longText('battery').split(' ').concat(['slightly']),
      fingerprintText: longText('battery'),
    });
    const far = simhashHex({
      tokens: longText('completely').split(' '),
      fingerprintText: longText('completely'),
    });
    expect(hammingDistanceHex(near, edited)).toBeLessThanOrEqual(6);
    expect(hammingDistanceHex(near, far)).toBeGreaterThan(6);
  });

  it('handles the long-input path (more than 40 tokens)', () => {
    const tokens = longText('drill').split(' ');
    expect(tokens.length).toBeGreaterThan(40);
    const hex = simhashHex({ tokens, fingerprintText: longText('drill') });
    expect(hex).toMatch(/^[0-9a-f]{16}$/u);
    expect(simhashHex({ tokens, fingerprintText: longText('drill') })).toBe(hex);
  });
});

describe('hammingDistanceHex', () => {
  it('is 0 for identical hashes', () => {
    expect(hammingDistanceHex('deadbeefdeadbeef', 'deadbeefdeadbeef')).toBe(0);
  });

  it('is 64 for complements', () => {
    expect(hammingDistanceHex('00000000ffffffff', 'ffffffff00000000')).toBe(64);
  });

  it('counts single nibble differences', () => {
    // 1 -> 2 differs in 2 bits.
    expect(hammingDistanceHex('0000000000000001', '0000000000000002')).toBe(2);
    // 0 -> 1 differs in 1 bit.
    expect(hammingDistanceHex('0000000000000000', '0000000000000001')).toBe(1);
  });

  it('accepts an 0x prefix and short hex', () => {
    expect(hammingDistanceHex('0x000000000000000f', '0000000000000001')).toBe(3);
    // Both are left-padded to 16 nibbles first; low nibbles 1 vs 2 -> XOR = 3 (2 bits).
    expect(hammingDistanceHex('01', '02')).toBe(2);
  });

  it('compares left-padded values across different lengths', () => {
    // 'f'  -> 000000000000000f
    // 'f0' -> 00000000000000f0
    // XOR of the low byte: 0f ^ f0 = ff -> 8 bits.
    expect(hammingDistanceHex('f', 'f0')).toBe(8);
  });
});

describe('simhashBandKeys', () => {
  function tokensOf(text: string): string[] {
    return text.split(' ');
  }
  const input = {
    tokens: tokensOf(longText('keys')),
    fingerprintText: longText('keys'),
  };

  it('splits a 64-bit hash into 4 bands of 16 bits by default', () => {
    const hex = simhashHex(input);
    const keys = simhashBandKeys(hex);
    expect(keys).toHaveLength(4);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{4}$/u);
    expect(keys.join('')).toBe(hex.slice(0, 16).slice(0, 16));
    expect(keys).toEqual([hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12), hex.slice(12, 16)]);
  });

  it('supports custom band counts and bits per band', () => {
    const hex = 'deadbeefdeadbeef';
    expect(simhashBandKeys(hex, 8, 8)).toHaveLength(8);
    expect(simhashBandKeys(hex, 2, 32)).toHaveLength(2);
    expect(simhashBandKeys(hex, 2, 32)).toEqual(['deadbeef', 'deadbeef']);
  });

  it('slices from the front without re-padding short band keys', () => {
    // hexPerBand = ceil(4/4) = 1 -> key is the first hex char of the padded hex.
    const keys = simhashBandKeys('1', 1, 4);
    expect(keys).toEqual(['0']);
    expect(simhashBandKeys('0000000000000001', 1, 4)).toEqual(['0']);
  });

  it('yields consistent keys for identical inputs', () => {
    const hex = simhashHex(input);
    const first = simhashBandKeys(hex, 4, 16);
    const second = simhashBandKeys(hex, 4, 16);
    expect(first).toEqual(second);
  });
});
