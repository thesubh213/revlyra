import { sentencesLengthVariance, shingles } from '../normalize/text';
import type { AnalysisContext, CanonicalReview, FeatureSet, NormalizedReview } from '../types';
import {
  COMPARATIVES,
  EXPERIENCE_MARKERS,
  FIRST_PERSON,
  HEDGES,
  NEGATIVE_WORDS,
  NUMBER_RE,
  POSITIVE_WORDS,
  PROMO_PHRASES,
  SAFETY_INCIDENT_PATTERNS,
  STOPWORDS,
  SUPERLATIVES,
  TRANSITIONS,
  UNIT_RE,
} from './lexicons';

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function countSetHits(tokens: string[], words: Set<string>): number {
  let hits = 0;
  for (const token of tokens) if (words.has(token)) hits += 1;
  return hits;
}

function countPhraseHits(text: string, phrases: string[]): number {
  let hits = 0;
  for (const phrase of phrases) {
    let index = text.indexOf(phrase);
    while (index !== -1) {
      hits += 1;
      index = text.indexOf(phrase, index + phrase.length);
    }
  }
  return hits;
}

function entropyFromCounts(counts: number[]): number {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function extractContentFeatures(
  review: CanonicalReview,
  normalized: NormalizedReview,
  analysis: AnalysisContext,
): FeatureSet {
  const tokens = normalized.tokens;
  const tokenCount = Math.max(1, tokens.length);
  const lower = normalized.text.toLowerCase();
  const sentenceList = normalized.sentences;
  const unique = new Set(tokens).size;
  const letters = normalized.text.match(/\p{L}/gu) ?? [];
  const uppercaseLetters = normalized.text.match(/\p{Lu}/gu) ?? [];

  const positive = countSetHits(tokens, POSITIVE_WORDS);
  const negative = countSetHits(tokens, NEGATIVE_WORDS);
  const polarity = (positive - negative) / (positive + negative + 1);

  const expectedPolarity = (review.rating - 3) / 2;
  const mismatch =
    expectedPolarity >= 0
      ? clamp((expectedPolarity - polarity) / 2)
      : clamp((polarity - expectedPolarity) / 2);

  const promoHits = countPhraseHits(lower, PROMO_PHRASES);
  const superlativeHits = countSetHits(tokens, SUPERLATIVES);
  const promoDensity = clamp((promoHits * 2 + superlativeHits) / tokenCount);

  const transitionHits = countSetHits(tokens, TRANSITIONS);
  const hedgeHits = countSetHits(tokens, HEDGES);
  const firstPersonHits = countSetHits(tokens, FIRST_PERSON);
  const comparativeHits = countSetHits(tokens, COMPARATIVES);
  const experienceHits = countSetHits(tokens, EXPERIENCE_MARKERS);
  const stopwordHits = countSetHits(tokens, STOPWORDS);

  const sentenceCv = sentencesLengthVariance(sentenceList);
  const hasConclusion = /\b(in conclusion|to sum up|in summary|overall)\b/iu.test(normalized.text);
  const endsCleanly = /[.!?]["')\]]?$/u.test(normalized.text.trim());
  const startsUppercase = /^[\p{Lu}\p{N}]/u.test(normalized.text.trim());
  const repeatedPunctuation = /([!?.,])\1{1,}/u.test(normalized.text);
  const perfectPunctuation = endsCleanly && startsUppercase && !repeatedPunctuation;

  const numberHits = (normalized.text.match(NUMBER_RE) ?? []).length;
  const unitHits = (normalized.text.match(UNIT_RE) ?? []).length;

  const specificity = clamp(
    0.3 * clamp(numberHits / 3) +
      0.3 * clamp(unitHits / 2) +
      0.2 * clamp(comparativeHits / 2) +
      0.2 * clamp(experienceHits / 3),
  );

  let genericness = clamp(0.7 * (1 - specificity) + 0.3 * clamp(stopwordHits / tokenCount / 0.45));
  if (analysis.corpus?.tokenIdf && analysis.corpus.totalReviews >= 50) {
    let total = 0;
    let counted = 0;
    for (const token of tokens) {
      const idf = analysis.corpus.tokenIdf[token];
      if (idf !== undefined) {
        total += idf;
        counted += 1;
      }
    }
    if (counted > 0) {
      const averageIdf = total / counted;
      genericness = clamp(1 - averageIdf / 8);
    }
  }

  let templateCoverage = 0;
  if (analysis.corpus?.documentFrequency && analysis.corpus.totalReviews >= 50) {
    const grams = shingles(tokens, 5, 400);
    if (grams.length > 0) {
      const threshold = Math.max(3, Math.floor(analysis.corpus.totalReviews * 0.002));
      let frequent = 0;
      for (const gram of grams) {
        if ((analysis.corpus.documentFrequency[gram] ?? 0) >= threshold) frequent += 1;
      }
      templateCoverage = frequentRatio(frequent, grams.length);
    }
  }

  const llmStyle = clamp(
    0.22 * clamp(transitionHits / tokenCount / 0.025) +
      0.18 * clamp(hedgeHits / tokenCount / 0.02) +
      0.2 * clamp(1 - sentenceCv / 0.55) +
      0.15 * (hasConclusion ? 1 : 0) +
      0.15 * (perfectPunctuation ? 1 : 0) +
      0.1 * clamp(1 - Math.abs(tokenCount / Math.max(1, sentenceList.length) - 18) / 18),
    0,
    0.85,
  );

  const matches = analysis.textMatches ?? [];
  let exactDup = 0;
  let nearDup = 0;
  let templateMatch = 0;
  let crossAccountMatches = 0;
  for (const match of matches) {
    if (match.reviewerId !== review.reviewerId) crossAccountMatches += 1;
    const cross = match.reviewerId !== review.reviewerId || match.itemId !== review.itemId;
    if (!cross) continue;
    if (match.kind === 'exact') exactDup = 1;
    if (match.kind === 'near') nearDup = Math.max(nearDup, clamp((match.similarity - 0.72) / 0.28));
    if (match.kind === 'template') templateMatch = 1;
  }
  if (templateCoverage > 0.45 && analysis.corpus && analysis.corpus.totalReviews >= 100) {
    templateMatch = Math.max(templateMatch, clamp((templateCoverage - 0.35) / 0.5));
  }
  const crossMatches = matches.filter(
    (match) => match.reviewerId !== review.reviewerId || match.itemId !== review.itemId,
  );
  if (crossMatches.length >= 3) {
    const averageSimilarity =
      crossMatches.reduce((sum, match) => sum + match.similarity, 0) / crossMatches.length;
    templateMatch = Math.max(
      templateMatch,
      clamp((crossMatches.length - 2) / 6 + averageSimilarity * 0.4),
    );
  }

  const disclosure =
    /\b(received (?:this|the) (?:product|item) (?:for free|at no cost)|gifted|sponsored|in exchange for (?:an? )?(?:honest )?review)\b/iu.test(
      normalized.text,
    );

  const injectionHits = normalized.injectionHits;
  const injectedQuoted = injectionHits.filter((hit) => hit.quoted).length;
  const injectionDistinct = new Set(injectionHits.map((hit) => hit.code)).size;
  const injectionQuotedRatio = injectionHits.length > 0 ? injectedQuoted / injectionHits.length : 0;

  const safetyCategories = new Map<string, number>();
  let safetyCount = 0;
  let safetyMaxWeight = 0;
  for (const pattern of SAFETY_INCIDENT_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    let match: RegExpExecArray | null = re.exec(normalized.text);
    let categoryCount = 0;
    while (match !== null) {
      categoryCount += 1;
      if (match[0].length === 0) break;
      match = re.exec(normalized.text);
    }
    if (categoryCount > 0) {
      safetyCategories.set(pattern.category, categoryCount);
      safetyCount += categoryCount;
      safetyMaxWeight = Math.max(safetyMaxWeight, pattern.weight);
    }
  }

  const uppercaseRatio = letters.length > 0 ? uppercaseLetters.length / letters.length : 0;
  const exclamationDensity = (normalized.text.match(/!/gu) ?? []).length / tokenCount;
  const distressStyle =
    uppercaseRatio > 0.5 || exclamationDensity > 0.25 || tokenCount < 12 ? 1 : 0;

  const features: FeatureSet = {
    'text.tokenCount': tokenCount,
    'text.charCount': normalized.text.length,
    'text.sentenceCount': sentenceList.length,
    'text.avgSentenceTokens': tokenCount / Math.max(1, sentenceList.length),
    'text.sentenceLengthCv': sentenceCv,
    'text.typeTokenRatio': unique / tokenCount,
    'text.stopwordRatio': stopwordHits / tokenCount,
    'text.firstPersonRatio': firstPersonHits / tokenCount,
    'text.uppercaseRatio': uppercaseRatio,
    'text.exclamationDensity': exclamationDensity,
    'text.questionDensity': (normalized.text.match(/\?/gu) ?? []).length / tokenCount,
    'text.emojiDensity': normalized.stats.emojiCount / tokenCount,
    'text.injectionDistinct': injectionDistinct,
    'text.injectionHits': Math.min(1, injectionHits.length / 3),
    'text.injectionQuotedRatio': injectionQuotedRatio,
    'safety.categories': safetyCategories.size,
    'safety.hits': safetyCount,
    'safety.maxWeight': safetyMaxWeight,
    'safety.present': safetyCategories.size > 0 ? 1 : 0,
    'safety.distressStyle': distressStyle,
    'text.promoDensity': promoDensity,
    'text.superlativeDensity': superlativeHits / tokenCount,
    'text.transitionDensity': transitionHits / tokenCount,
    'text.hedgeDensity': hedgeHits / tokenCount,
    'text.comparativeDensity': comparativeHits / tokenCount,
    'text.experienceDensity': experienceHits / tokenCount,
    'text.specificity': specificity,
    'text.genericness': genericness,
    'text.templateCoverage': templateCoverage,
    'text.sentimentPolarity': polarity,
    'text.sentimentMismatch': mismatch,
    'text.llmStyle': llmStyle,
    'text.exactDup': exactDup,
    'text.nearDup': nearDup,
    'text.templateMatch': templateMatch,
    'text.crossAccountMatches': Math.min(1, crossAccountMatches / 5),
    'text.disclosure': disclosure ? 1 : 0,
    'text.obfuscation': Math.min(
      1,
      (normalized.stats.zeroWidthRemoved > 0 ? 0.5 : 0) +
        (normalized.stats.homoglyphsMapped >= 2 ? 0.5 : 0) +
        (normalized.stats.mixedScriptTokens > 0 ? 0.4 : 0),
    ),
    'text.ratingPolarityGap': Math.abs(polarity - expectedPolarity),
  };

  return features;
}

function frequentRatio(frequent: number, total: number): number {
  return total === 0 ? 0 : clamp(frequent / total);
}

export function ratingEntropy(reviewerRatingDistribution?: number[]): number {
  if (reviewerRatingDistribution?.length !== 5) return 0;
  const entropy = entropyFromCounts(reviewerRatingDistribution);
  return clamp(entropy / Math.log2(5));
}
