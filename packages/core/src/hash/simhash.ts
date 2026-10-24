import { type Hash64, hamming64, hash64, hash64ToHex, hexToHash64 } from './fnv';

export interface SimHashInput {
  tokens: string[];
  fingerprintText: string;
}

function collectFeatures(tokens: string[], fingerprintText: string): Array<[string, number]> {
  const weights = new Map<string, number>();

  const add = (feature: string, weight: number) => {
    weights.set(feature, (weights.get(feature) ?? 0) + weight);
  };

  const limit = Math.min(tokens.length, 300);

  if (tokens.length < 40) {
    // Short reviews are dominated by noise if bigrams/char-grams are included.
    // Unique weighted tokens give a stable fingerprint for 1-3 word edits.
    const counts = new Map<string, number>();
    for (let i = 0; i < limit; i += 1) {
      const token = tokens[i]!;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    for (const [token, count] of counts) {
      add(`w:${token}`, Math.min(2, count));
    }
  } else {
    for (let i = 0; i < limit; i += 1) {
      add(`w:${tokens[i]!}`, 3);
      if (i + 1 < limit) add(`b:${tokens[i]!} ${tokens[i + 1]!}`, 2);
    }
    const compact = fingerprintText.replace(/\s+/gu, ' ');
    const charLimit = Math.min(compact.length - 4, 300);
    for (let i = 0; i < charLimit; i += 1) {
      add(`c:${compact.slice(i, i + 4)}`, 1);
    }
  }

  return Array.from(weights.entries());
}

/**
 * 64-bit SimHash over weighted word unigrams/bigrams and character 4-grams.
 * Uses two independent 32-bit FNV streams so the hot loop stays integer-only.
 */
export function simhash(input: SimHashInput): Hash64 {
  const vector = new Int32Array(64);
  const features = collectFeatures(input.tokens, input.fingerprintText);

  for (const [feature, weight] of features) {
    const value = hash64(feature);
    for (let bit = 0; bit < 32; bit += 1) {
      const mask = 1 << bit;
      vector[bit] = (vector[bit] ?? 0) + ((value.hi & mask) !== 0 ? weight : -weight);
      vector[bit + 32] = (vector[bit + 32] ?? 0) + ((value.lo & mask) !== 0 ? weight : -weight);
    }
  }

  let hi = 0;
  let lo = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if (vector[bit]! > 0) hi |= 1 << bit;
    if (vector[bit + 32]! > 0) lo |= 1 << bit;
  }

  return { hi: hi >>> 0, lo: lo >>> 0 };
}

export function simhashHex(input: SimHashInput): string {
  return hash64ToHex(simhash(input));
}

export function hammingDistanceHex(a: string, b: string): number {
  return hamming64(hexToHash64(a), hexToHash64(b));
}

export function simhashBandKeys(hex: string, bands = 4, bitsPerBand = 16): string[] {
  const normalized = hex.replace(/^0x/u, '').padStart(16, '0').slice(-16);
  const totalBits = bands * bitsPerBand;
  const hexPerBand = Math.ceil(bitsPerBand / 4);
  const keys: string[] = [];
  for (let i = 0; i < bands; i += 1) {
    keys.push(normalized.slice(i * hexPerBand, (i + 1) * hexPerBand));
  }
  return keys.slice(0, Math.floor(totalBits / bitsPerBand));
}
