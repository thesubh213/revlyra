import type { ReviewMedia } from '@revlyra/core';
import { fetchImage } from './fetch-image';
import { hashImage, loadSharp } from './phash';

export interface MediaProcessResult {
  media: ReviewMedia[];
  warnings: string[];
  processed: number;
  skipped: number;
}

interface ExifLike {
  Make?: unknown;
  Model?: unknown;
  Software?: unknown;
  DateTimeOriginal?: unknown;
  CreateDate?: unknown;
}

async function parseExif(buffer: Buffer): Promise<Record<string, unknown>> {
  try {
    const exifrModule = (await import('exifr')) as unknown as {
      parse?: (input: Buffer, options: Record<string, unknown>) => Promise<unknown>;
      default?: {
        parse?: (input: Buffer, options: Record<string, unknown>) => Promise<unknown>;
      };
    };
    const parse = exifrModule.parse ?? exifrModule.default?.parse;
    if (!parse) return {};
    const parsed = (await parse(buffer, {
      pick: ['Make', 'Model', 'Software', 'DateTimeOriginal', 'CreateDate'],
      reviveValues: true,
    })) as ExifLike | undefined;
    if (!parsed) return {};
    const result: Record<string, unknown> = {};
    for (const key of ['Make', 'Model', 'Software'] as const) {
      if (typeof parsed[key] === 'string') result[key] = parsed[key];
    }
    const captured = parsed.DateTimeOriginal ?? parsed.CreateDate;
    if (captured instanceof Date && !Number.isNaN(captured.getTime())) {
      result.DateTimeOriginal = captured.toISOString();
    } else if (typeof captured === 'string') {
      const date = new Date(captured);
      if (!Number.isNaN(date.getTime())) result.DateTimeOriginal = date.toISOString();
    }
    return result;
  } catch {
    return {};
  }
}

export async function processReviewMedia(
  media: ReviewMedia[],
  options: { concurrency?: number; maxItems?: number; allowPrivateHosts?: boolean } = {},
): Promise<MediaProcessResult> {
  if (media.length === 0) return { media: [], warnings: [], processed: 0, skipped: 0 };
  const sharp = await loadSharp();
  if (!sharp) {
    return {
      media,
      warnings: ['SHARP_UNAVAILABLE'],
      processed: 0,
      skipped: media.length,
    };
  }

  const maxItems = Math.min(options.maxItems ?? 10, 20);
  const queue = media.slice(0, maxItems);
  const results: ReviewMedia[] = [...queue];
  const warnings: string[] = [];
  let processed = 0;
  let skipped = 0;
  let index = 0;

  const worker = async (): Promise<void> => {
    while (index < queue.length) {
      const current = index;
      index += 1;
      const item = queue[current]!;
      try {
        if (item.sha256 && item.phash) {
          results[current] = item;
          skipped += 1;
          continue;
        }
        if (!item.url && !item.sha256) {
          results[current] = item;
          skipped += 1;
          continue;
        }
        const fetched = item.url
          ? await fetchImage(item.url, { allowPrivateHosts: options.allowPrivateHosts ?? false })
          : null;
        const buffer = fetched?.buffer;
        if (!buffer) {
          results[current] = item;
          skipped += 1;
          continue;
        }
        const hashes = await hashImage(buffer);
        if (!hashes) {
          results[current] = item;
          warnings.push('IMAGE_DECODE_FAILED');
          skipped += 1;
          continue;
        }
        const exif = await parseExif(buffer);
        const capturedAt =
          typeof exif.DateTimeOriginal === 'string' ? exif.DateTimeOriginal : undefined;
        results[current] = {
          ...item,
          sha256: hashes.sha256,
          dhash: hashes.dhash,
          phash: hashes.phash,
          width: hashes.width ?? item.width,
          height: hashes.height ?? item.height,
          mime: hashes.mime ?? fetched?.mime ?? item.mime,
          exif,
          ...(capturedAt ? { capturedAt } : {}),
        };
        processed += 1;
      } catch (error) {
        results[current] = item;
        warnings.push(String((error as Error).message ?? error));
        skipped += 1;
      }
    }
  };

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    media: results,
    warnings: Array.from(new Set(warnings)),
    processed,
    skipped,
  };
}
