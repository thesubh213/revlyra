export interface Hash64 {
  hi: number;
  lo: number;
}

export function fnv1a32(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (code >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function hash64(input: string): Hash64 {
  return {
    hi: fnv1a32(input, 0x811c9dc5),
    lo: fnv1a32(input, 0x9e3779b9),
  };
}

export function popcount32(value: number): number {
  let v = value >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

export function hamming64(a: Hash64, b: Hash64): number {
  return popcount32((a.hi ^ b.hi) >>> 0) + popcount32((a.lo ^ b.lo) >>> 0);
}

export function hash64ToHex(value: Hash64): string {
  return `${value.hi.toString(16).padStart(8, '0')}${value.lo.toString(16).padStart(8, '0')}`;
}

export function hexToHash64(hex: string): Hash64 {
  const normalized = hex.replace(/^0x/u, '').padStart(16, '0').slice(-16);
  return {
    hi: Number.parseInt(normalized.slice(0, 8), 16) >>> 0,
    lo: Number.parseInt(normalized.slice(8, 16), 16) >>> 0,
  };
}
