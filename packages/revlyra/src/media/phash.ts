import { sha256Bytes } from '@revlyra/core';

type SharpModule = typeof import('sharp');

let sharpPromise: Promise<SharpModule | null> | null = null;

export async function loadSharp(): Promise<SharpModule | null> {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((module) => (module.default ?? module) as SharpModule)
      .catch(() => null);
  }
  return sharpPromise;
}

export interface ImageHashes {
  sha256: string;
  dhash: string;
  phash: string;
  width: number | null;
  height: number | null;
  format: string | null;
  mime: string | null;
}

function popcountByte(value: number): number {
  let v = value;
  let count = 0;
  while (v) {
    count += v & 1;
    v >>>= 1;
  }
  return count;
}

function bitsToHex(bits: number[]): string {
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4; j += 1) {
      nibble = (nibble << 1) | (bits[i + j] ?? 0);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

export function hammingHex(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let distance = 0;
  for (let i = 0; i < length; i += 1) {
    const left = Number.parseInt(a[i]!, 16);
    const right = Number.parseInt(b[i]!, 16);
    if (Number.isNaN(left) || Number.isNaN(right)) return 64;
    distance += popcountByte(left ^ right);
  }
  return distance;
}

function dct1d(input: Float64Array, output: Float64Array, size: number): void {
  for (let u = 0; u < size; u += 1) {
    let sum = 0;
    for (let x = 0; x < size; x += 1) {
      sum += input[x]! * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size));
    }
    output[u] = sum * (u === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size));
  }
}

function dct2d(pixels: Float64Array, size: number): Float64Array {
  const rows = new Float64Array(size * size);
  const tmp = new Float64Array(size);
  const out = new Float64Array(size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) tmp[x] = pixels[y * size + x]!;
    dct1d(tmp, out, size);
    for (let x = 0; x < size; x += 1) rows[y * size + x] = out[x]!;
  }
  const result = new Float64Array(size * size);
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) tmp[y] = rows[y * size + x]!;
    dct1d(tmp, out, size);
    for (let y = 0; y < size; y += 1) result[y * size + x] = out[y]!;
  }
  return result;
}

function dhashFromGray(gray: Buffer, width: number, height: number): string {
  const bits: number[] = [];
  for (let y = 0; y < Math.min(8, height); y += 1) {
    for (let x = 0; x < Math.min(8, width - 1); x += 1) {
      const left = gray[y * width + x] ?? 0;
      const right = gray[y * width + x + 1] ?? 0;
      bits.push(left > right ? 1 : 0);
    }
  }
  while (bits.length < 64) bits.push(0);
  return bitsToHex(bits.slice(0, 64));
}

function phashFromGray(gray: Buffer, size = 32): string {
  const pixels = new Float64Array(size * size);
  for (let i = 0; i < size * size; i += 1) pixels[i] = gray[i] ?? 0;
  const coefficients = dct2d(pixels, size);
  const low: number[] = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      low.push(coefficients[y * size + x] ?? 0);
    }
  }
  const withoutDc = low.slice(1).sort((a, b) => a - b);
  const median = withoutDc[Math.floor(withoutDc.length / 2)] ?? 0;
  const bits = low.map((value) => (value > median ? 1 : 0));
  return bitsToHex(bits);
}

export async function hashImage(buffer: Buffer): Promise<ImageHashes | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const image = sharp(buffer, {
      failOn: 'none',
      limitInputPixels: 80_000_000,
      animated: false,
    });
    const metadata = await image.metadata();
    const gray32 = await image.clone().greyscale().resize(32, 32, { fit: 'fill' }).raw().toBuffer();
    const gray9x8 = await image.clone().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();

    const phash = phashFromGray(gray32, 32);
    const dhash = dhashFromGray(gray9x8, 9, 8);
    const sha256 = Buffer.from(sha256Bytes(buffer)).toString('hex');
    const format = metadata.format ?? null;
    const mime = format ? `image/${format === 'jpg' ? 'jpeg' : format}` : null;

    return {
      sha256,
      dhash,
      phash,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      format,
      mime,
    };
  } catch {
    return null;
  }
}
