import { INJECTION_PATTERNS } from '../features/lexicons';
import { sha256Hex } from '../hash/sha256';
import { simhashHex } from '../hash/simhash';
import type { CanonicalReview, NormalizedReview } from '../types';
import { detectLanguage } from './language';
import {
  analyzeInjection,
  countEmoji,
  fingerprintText,
  lightNormalize,
  maskContacts,
  sanitizeForModel,
  sentences,
  tokenize,
} from './text';
import { normalizeUnicode } from './unicode';

export * from './language';
export * from './text';
export * from './unicode';

export function normalizeReview(review: CanonicalReview): NormalizedReview {
  const unicode = normalizeUnicode(review.text);
  const masked = maskContacts(unicode.text);
  const cleaned = lightNormalize(masked.text);
  const tokens = tokenize(cleaned);
  const language =
    review.language && review.language !== 'und'
      ? { code: review.language, confidence: 1 }
      : detectLanguage(tokens, cleaned);
  const fingerprint = fingerprintText(cleaned);
  const exactHash = sha256Hex(fingerprint);

  const injectionHits = analyzeInjection(cleaned, INJECTION_PATTERNS);
  const sanitized = sanitizeForModel(cleaned, injectionHits);

  return {
    text: cleaned,
    modelText: sanitized.text,
    fingerprintText: fingerprint,
    tokens,
    sentences: sentences(cleaned),
    language: language.code,
    languageConfidence: language.confidence,
    textSha256: exactHash,
    exactHash,
    injectionHits,
    simhash: simhashHex({ tokens, fingerprintText: fingerprint }),
    stats: {
      originalLength: review.text.length,
      normalizedLength: cleaned.length,
      zeroWidthRemoved: unicode.zeroWidthRemoved,
      homoglyphsMapped: unicode.homoglyphsMapped,
      mixedScriptTokens: unicode.mixedScriptTokens,
      fullWidthChars: unicode.fullWidthChars,
      urlCount: masked.urlCount,
      emailCount: masked.emailCount,
      phoneCount: masked.phoneCount,
      emojiCount: countEmoji(cleaned),
      script: unicode.script,
      injectionHits: injectionHits.length,
    },
  };
}
