import { CODES } from '../codes';
import type { Detector, DetectorContext, Signal } from '../types';
import { isEnabled, signal } from './helpers';

function run(ctx: DetectorContext): Signal[] {
  if (!isEnabled('text-authenticity', ctx.policy, 'content')) return [];
  const features = ctx.features;
  const language = ctx.normalized.language;
  const languageMultiplier = language === 'en' ? 1 : 0.6;
  const confidenceBase = Math.min(
    0.9,
    0.35 +
      Math.min(0.35, ctx.normalized.text.length / 1200) *
        (ctx.normalized.languageConfidence || 0.5),
  );
  // Trauma prose is often generic, brief, or all-caps; presentation-style
  // signals must never downrank public-safety warnings (doc 2.2).
  const safetyStyleFactor =
    (features['safety.present'] ?? 0) > 0 && ctx.policy.safety?.styleSuppression !== false
      ? 0.3
      : 1;
  const styleSuppressed = safetyStyleFactor !== 1;
  const reasons: Signal[] = [];

  const injectionDistinct = features['text.injectionDistinct'] ?? 0;
  if (injectionDistinct >= 1) {
    const quotedRatio = features['text.injectionQuotedRatio'] ?? 0;
    let severity = Math.min(0.6, 0.35 + injectionDistinct * 0.25);
    if (quotedRatio >= 0.5) severity *= 0.5;
    severity = Math.min(0.6, severity * languageMultiplier);
    if (severity >= 0.15) {
      reasons.push(
        signal(
          CODES.TEXT_PROMPT_INJECTION,
          'content',
          severity,
          0.6,
          'The review contains phrases that target AI review processors; weak evidence on its own and neutralized before any model input.',
          {
            distinctPatterns: injectionDistinct,
            hitCount: ctx.normalized.injectionHits.length,
            quotedRatio: Number(quotedRatio.toFixed(2)),
            sanitizedForModel: ctx.normalized.modelText !== ctx.normalized.text,
          },
        ),
      );
    }
  }

  const generic = features['text.genericness'] ?? 0;
  if (generic >= 0.7) {
    const severity = Math.min(0.55, (generic - 0.6) * 1.1) * languageMultiplier * safetyStyleFactor;
    if (severity >= 0.12) {
      reasons.push(
        signal(
          CODES.TEXT_GENERIC,
          'content',
          severity,
          confidenceBase,
          'The review is written in generic language with little concrete detail.',
          { genericness: Number(generic.toFixed(3)), styleSuppressed },
        ),
      );
    }
  }

  const specificity = features['text.specificity'] ?? 1;
  if (specificity <= 0.18 && ctx.normalized.text.length >= 80) {
    const severity = 0.3 * languageMultiplier * safetyStyleFactor;
    if (severity >= 0.12) {
      reasons.push(
        signal(
          CODES.TEXT_NO_SPECIFICS,
          'content',
          severity,
          confidenceBase,
          'The review lacks measurements, comparisons, or firsthand usage details.',
          { specificity: Number(specificity.toFixed(3)), styleSuppressed },
        ),
      );
    }
  }

  const mismatch = features['text.sentimentMismatch'] ?? 0;
  if (mismatch >= 0.4) {
    const severity = Math.min(0.5, mismatch * 0.7) * languageMultiplier * safetyStyleFactor;
    if (severity >= 0.12) {
      reasons.push(
        signal(
          CODES.TEXT_SENTIMENT_RATING_MISMATCH,
          'content',
          severity,
          0.55 + Math.min(0.25, ctx.normalized.languageConfidence * 0.25),
          'The sentiment of the text conflicts with the star rating.',
          { mismatch: Number(mismatch.toFixed(3)), rating: ctx.review.rating, styleSuppressed },
        ),
      );
    }
  }

  const promo = features['text.promoDensity'] ?? 0;
  if (promo >= 0.06) {
    reasons.push(
      signal(
        CODES.TEXT_PROMOTIONAL,
        'content',
        Math.min(0.55, promo * 3) * languageMultiplier,
        0.65,
        'The review contains unusually dense promotional or superlative language.',
        { promoDensity: Number(promo.toFixed(3)) },
      ),
    );
  }

  const llm = features['text.llmStyle'] ?? 0;
  if (llm >= 0.65) {
    const severity = Math.min(0.35, llm * 0.4) * safetyStyleFactor;
    if (severity >= 0.12) {
      reasons.push(
        signal(
          CODES.TEXT_LLM_STYLE,
          'content',
          severity,
          0.5,
          'The text shows structural patterns sometimes associated with generated reviews; this is weak evidence on its own.',
          { llmStyle: Number(llm.toFixed(3)), styleSuppressed },
        ),
      );
    }
  }

  return reasons.filter((reason) => reason.severity >= 0.12);
}

export const textAuthenticityDetector: Detector = {
  id: 'text-authenticity',
  version: '1.1.0',
  families: ['content'],
  run,
};
