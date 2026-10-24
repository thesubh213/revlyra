import type { Detector, DetectorContext, Signal } from '../types';
import { isEnabled, signal } from './helpers';

function run(ctx: DetectorContext): Signal[] {
  if (!isEnabled('duplicate', ctx.policy, 'content')) return [];
  const signals: Signal[] = [];
  const features = ctx.features;
  const review = ctx.review;

  const exact = features['text.exactDup'] ?? 0;
  if (exact > 0) {
    signals.push(
      signal(
        'TEXT_EXACT_DUPLICATE_CROSS_ACCOUNT',
        'content',
        0.98,
        0.95,
        'The normalized review text exactly matches a review from another account.',
        {
          matches: ctx.analysis.textMatches?.filter((m) => m.kind === 'exact').slice(0, 5) ?? [],
          reviewerId: review.reviewerId,
        },
        true,
      ),
    );
  }

  const near = features['text.nearDup'] ?? 0;
  if (near > 0.05) {
    signals.push(
      signal(
        'TEXT_NEAR_DUPLICATE',
        'content',
        Math.min(0.95, 0.5 + near * 0.45),
        0.7 + Math.min(0.2, near * 0.2),
        'The review is a near-duplicate of text posted by another account.',
        {
          similarity: Number((0.72 + near * 0.28).toFixed(3)),
          matches: ctx.analysis.textMatches?.filter((m) => m.kind === 'near').slice(0, 5) ?? [],
        },
      ),
    );
  }

  const template = Math.max(
    features['text.templateMatch'] ?? 0,
    features['text.templateCoverage'] ?? 0,
  );
  if (template > 0.25) {
    signals.push(
      signal(
        'TEXT_TEMPLATE',
        'content',
        Math.min(0.8, 0.35 + template * 0.5),
        0.55 + Math.min(0.25, template * 0.3),
        'The review shares recurring template phrasing across the corpus.',
        {
          coverage: Number(template.toFixed(3)),
          corpusSize: ctx.analysis.corpus?.totalReviews ?? 0,
        },
      ),
    );
  }

  const obfuscation = features['text.obfuscation'] ?? 0;
  if (obfuscation >= 0.4) {
    signals.push(
      signal(
        'TEXT_UNICODE_OBFUSCATION',
        'content',
        Math.min(0.85, 0.3 + obfuscation * 0.55),
        0.8,
        'The text contains invisible characters, homoglyphs, or mixed-script tokens often used to evade duplicate detection.',
        {
          zeroWidthRemoved: ctx.normalized.stats.zeroWidthRemoved,
          homoglyphsMapped: ctx.normalized.stats.homoglyphsMapped,
          mixedScriptTokens: ctx.normalized.stats.mixedScriptTokens,
        },
      ),
    );
  }

  return signals;
}

export const duplicateDetector: Detector = {
  id: 'duplicate',
  version: '1.0.0',
  families: ['content'],
  run,
};
