import type { Detector, DetectorContext, Signal } from '../types';
import { isEnabled, signal } from './helpers';

function run(ctx: DetectorContext): Signal[] {
  if (!isEnabled('media', ctx.policy, 'media')) return [];
  const features = ctx.features;
  if ((features['media.present'] ?? 0) === 0) return [];
  const signals: Signal[] = [];

  if ((features['media.exactReuse'] ?? 0) > 0) {
    signals.push(
      signal(
        'MEDIA_EXACT_REUSE',
        'media',
        0.95,
        0.9,
        'An uploaded image exactly matches an image used in another account’s review.',
        {
          matches: ctx.analysis.mediaMatches?.filter((m) => m.kind === 'exact').slice(0, 5) ?? [],
        },
        true,
      ),
    );
  }

  const nearReuse = features['media.nearReuse'] ?? 0;
  if (nearReuse >= 0.25) {
    signals.push(
      signal(
        'MEDIA_NEAR_REUSE',
        'media',
        Math.min(0.8, 0.35 + nearReuse * 0.45),
        0.7,
        'An uploaded image is a near-duplicate of an image used in another review.',
        {
          similarity: Number(nearReuse.toFixed(3)),
          matches: ctx.analysis.mediaMatches?.filter((m) => m.kind === 'near').slice(0, 5) ?? [],
        },
      ),
    );
  }

  if ((features['media.exifStripped'] ?? 0) > 0) {
    signals.push(
      signal(
        'MEDIA_EXIF_STRIPPED',
        'media',
        0.2,
        0.4,
        'The image has no camera metadata. Many platforms strip metadata, so this is weak evidence.',
        { mediaCount: features['media.count'] ?? 0 },
      ),
    );
  }

  if ((features['media.editSoftware'] ?? 0) > 0) {
    signals.push(
      signal(
        'MEDIA_EDIT_SOFTWARE',
        'media',
        0.25,
        0.45,
        'Image metadata references photo-editing software.',
        { mediaCount: features['media.count'] ?? 0 },
      ),
    );
  }

  if ((features['media.timeMismatch'] ?? 0) > 0) {
    signals.push(
      signal(
        'MEDIA_TIME_MISMATCH',
        'media',
        0.4,
        0.55,
        'The captured-image timestamp is inconsistent with the review date.',
        { mediaCount: features['media.count'] ?? 0 },
      ),
    );
  }

  if ((features['media.screenshot'] ?? 0) > 0) {
    signals.push(
      signal(
        'MEDIA_SCREENSHOT',
        'media',
        0.15,
        0.35,
        'The uploaded image appears to be a screenshot rather than an original photo.',
        { mediaCount: features['media.count'] ?? 0 },
      ),
    );
  }

  return signals;
}

export const mediaDetector: Detector = {
  id: 'media',
  version: '1.0.0',
  families: ['media'],
  run,
};
