import { fnv1a32 } from './fnv';

const PRIME = 4_294_967_291;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function coefficients(count: number, seed: number): Array<{ a: number; b: number }> {
  const random = mulberry32(seed);
  const out: Array<{ a: number; b: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const a = 1 + Math.floor(random() * (PRIME - 1));
    const b = Math.floor(random() * PRIME);
    out.push({ a, b });
  }
  return out;
}

const DEFAULT_PERMUTATIONS = 64;
const DEFAULT_COEFFICIENTS = coefficients(DEFAULT_PERMUTATIONS, 0x5eed_1234);

/**
 * MinHash signature over 5-gram shingles. Intended for background clustering,
 * not the per-review hot path.
 */
export function minhashSignature(
  shingles: Iterable<string>,
  permutations = DEFAULT_PERMUTATIONS,
): number[] {
  const signature = new Array<number>(permutations).fill(PRIME);
  const coeffs =
    permutations === DEFAULT_PERMUTATIONS
      ? DEFAULT_COEFFICIENTS
      : coefficients(permutations, 0x5eed_1234);

  let count = 0;
  for (const shingle of shingles) {
    const hash = fnv1a32(shingle);
    for (let i = 0; i < permutations; i += 1) {
      const { a, b } = coeffs[i]!;
      const value = (Math.imul(a, hash) + b) >>> 0;
      const normalized = value % PRIME;
      if (normalized < signature[i]!) signature[i] = normalized;
    }
    count += 1;
    if (count >= 5000) break;
  }

  return signature;
}

export function minhashJaccard(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let equal = 0;
  for (let i = 0; i < length; i += 1) {
    if (a[i] === b[i]) equal += 1;
  }
  return equal / length;
}

export function minhashBandKeys(signature: number[], bands = 16): string[] {
  if (signature.length === 0) return [];
  const rows = Math.max(1, Math.floor(signature.length / bands));
  const keys: string[] = [];
  for (let band = 0; band < bands; band += 1) {
    const start = band * rows;
    const end = Math.min(start + rows, signature.length);
    if (start >= end) break;
    keys.push(signature.slice(start, end).join(','));
  }
  return keys;
}
