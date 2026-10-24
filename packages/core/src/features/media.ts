import type { AnalysisContext, CanonicalReview, FeatureSet } from '../types';
import { EDIT_SOFTWARE_RE } from './lexicons';

function exifString(exif: Record<string, unknown> | undefined, key: string): string | null {
  if (!exif) return null;
  const direct = exif[key];
  if (typeof direct === 'string') return direct;
  const lower = exif[key.toLowerCase()];
  if (typeof lower === 'string') return lower;
  for (const [k, value] of Object.entries(exif)) {
    if (k.toLowerCase() === key.toLowerCase() && typeof value === 'string') return value;
  }
  return null;
}

export function extractMediaFeatures(
  review: CanonicalReview,
  analysis: AnalysisContext,
): FeatureSet {
  const media = review.media ?? [];
  const matches = analysis.mediaMatches ?? [];
  let exactReuse = 0;
  let nearReuse = 0;
  for (const match of matches) {
    const cross = match.reviewerId !== review.reviewerId || match.itemId !== review.itemId;
    if (!cross) continue;
    if (match.kind === 'exact') exactReuse = 1;
    if (match.kind === 'near') {
      const similarity =
        match.distance <= 6 ? 1 : match.distance <= 10 ? 0.6 : match.distance <= 14 ? 0.25 : 0;
      nearReuse = Math.max(nearReuse, similarity);
    }
  }

  let exifStripped = 0;
  let editSoftware = 0;
  let screenshot = 0;
  let timeMismatch = 0;

  if (media.length > 0) {
    let hasCameraMetadata = false;
    for (const item of media) {
      const make = exifString(item.exif, 'Make');
      const model = exifString(item.exif, 'Model');
      if (make || model) hasCameraMetadata = true;
      const software = exifString(item.exif, 'Software');
      if (software && EDIT_SOFTWARE_RE.test(software)) editSoftware = 1;
      if (item.mime === 'image/png' && item.width && item.height) {
        const ratio =
          Math.max(item.width, item.height) / Math.max(1, Math.min(item.width, item.height));
        if (ratio > 1.7 && Math.max(item.width, item.height) > 1200) screenshot = 1;
      }
      if (item.capturedAt) {
        const captured = new Date(item.capturedAt).getTime();
        const submitted = new Date(review.submittedAt).getTime();
        if (Number.isFinite(captured) && Number.isFinite(submitted)) {
          const delta = submitted - captured;
          if (delta < -86_400_000 || delta > 365 * 86_400_000) timeMismatch = 1;
        }
      }
    }
    if (!hasCameraMetadata) exifStripped = 0.5;
  }

  const provisional =
    media.length > 0 &&
    media.every((item) => !item.sha256 && !item.phash && !item.dhash && !item.exif);

  return {
    'media.present': media.length > 0 ? 1 : 0,
    'media.count': media.length,
    'media.exactReuse': exactReuse,
    'media.nearReuse': nearReuse,
    'media.matchCount': matches.length,
    'media.exifStripped': exifStripped,
    'media.editSoftware': editSoftware,
    'media.screenshot': screenshot,
    'media.timeMismatch': timeMismatch,
    'media.provisional': provisional ? 1 : 0,
  };
}
