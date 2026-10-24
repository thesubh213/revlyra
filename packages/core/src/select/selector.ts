import { SELECTION_EXCLUSION_REASONS } from '../codes';
import { ASPECT_LEXICON } from '../features/lexicons';
import { hammingDistanceHex, simhashHex } from '../hash/simhash';
import { fingerprintText, jaccard, tokenize } from '../normalize/text';
import type {
  ScoredReviewInput,
  SelectedReview,
  SelectionOptions,
  SelectionResult,
} from '../types';

const DAY_MS = 86_400_000;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function specificity(text: string): number {
  const tokens = tokenize(text);
  const numberHits = (text.match(/\b\d+(?:[.,]\d+)?\b/gu) ?? []).length;
  const unitHits = (
    text.match(
      /\b(?:mm|cm|m|kg|g|lb|oz|ml|l|inch|inches|hours?|days?|weeks?|months?|years?|mah|gb|tb|%)\b/giu,
    ) ?? []
  ).length;
  const comparativeHits = (text.match(/\b(?:better|worse|than|compared|versus|vs)\b/giu) ?? [])
    .length;
  return clamp01(
    0.35 * Math.min(1, numberHits / 3) +
      0.3 * Math.min(1, unitHits / 2) +
      0.2 * Math.min(1, comparativeHits / 2) +
      0.15 * Math.min(1, tokens.length / 80),
  );
}

function recency(iso: string, now: number): number {
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return 0.5;
  const ageDays = Math.max(0, (now - value) / DAY_MS);
  return Math.exp(-ageDays / 365);
}

function aspectsOf(text: string): string[] {
  const lower = text.toLowerCase();
  const aspects: string[] = [];
  for (const [aspect, words] of Object.entries(ASPECT_LEXICON)) {
    if (words.some((word) => lower.includes(word))) aspects.push(aspect);
  }
  return aspects;
}

function baseScore(review: ScoredReviewInput, now: number): number {
  const trust = clamp01(review.trustScore);
  const helpful = clamp01(review.helpfulness ?? 0.5);
  const fresh = recency(review.submittedAt, now);
  const specific = clamp01(review.specificity ?? specificity(review.text));
  const decisionMultiplier =
    review.decision === 'label' ? 0.9 : review.decision === 'downrank' ? 0.6 : 1;
  return (
    Math.max(0.0001, trust) ** 1.2 *
    helpful ** 0.5 *
    fresh ** 0.3 *
    specific ** 0.4 *
    decisionMultiplier
  );
}

function textSimilarity(a: string, b: string): number {
  return jaccard(tokenize(a), tokenize(b));
}

function bucketOf(review: ScoredReviewInput): number {
  return Math.round(Math.min(5, Math.max(1, review.rating)));
}

function clusterReviews(
  reviews: ScoredReviewInput[],
): Array<{ id: string; items: ScoredReviewInput[] }> {
  const clusters: Array<{
    id: string;
    items: ScoredReviewInput[];
    hashes: string[];
    fingerprints: string[];
  }> = [];

  for (const review of reviews) {
    const fingerprint = fingerprintText(review.text);
    const hash = simhashHex({ tokens: tokenize(fingerprint), fingerprintText: fingerprint });
    let target: (typeof clusters)[number] | undefined;
    for (const cluster of clusters) {
      if (cluster.fingerprints.includes(fingerprint)) {
        target = cluster;
        break;
      }
      if (cluster.hashes.some((existing) => hammingDistanceHex(existing, hash) <= 3)) {
        target = cluster;
        break;
      }
      // Short reviews produce unstable SimHash values, so fall back to token
      // Jaccard similarity to keep near-duplicates in one cluster.
      if (
        cluster.items.some(
          (existing) => jaccard(tokenize(existing.text), tokenize(review.text)) >= 0.72,
        )
      ) {
        target = cluster;
        break;
      }
    }
    if (!target) {
      target = { id: review.id, items: [], hashes: [], fingerprints: [] };
      clusters.push(target);
    }
    target.items.push(review);
    target.hashes.push(hash);
    target.fingerprints.push(fingerprint);
  }

  return clusters.map((cluster) => ({ id: cluster.id, items: cluster.items }));
}

export function selectReviews(
  reviews: ScoredReviewInput[],
  options: SelectionOptions = {},
): SelectionResult {
  const limit = Math.max(1, Math.min(100, options.limit ?? 10));
  const minTrust = clamp01(options.minTrust ?? 0);
  const diversify = options.diversify ?? true;
  const includeFlagged = options.includeFlagged ?? false;
  const lambda = options.lambda ?? 0.75;
  const ensureCritical = options.ensureCritical ?? true;
  const now = Date.now();

  const reasonByReview = new Map<string, { reason: string; detail: string }>();

  const allowed = reviews.filter((review) => {
    if (review.trustScore < minTrust) {
      reasonByReview.set(review.id, {
        reason: SELECTION_EXCLUSION_REASONS.BELOW_MIN_TRUST,
        detail: `trustScore ${Number(review.trustScore.toFixed(3))} below minTrust ${minTrust}`,
      });
      return false;
    }
    if (includeFlagged) return true;
    if (
      review.decision === 'allow' ||
      review.decision === 'label' ||
      review.decision === 'downrank'
    ) {
      return true;
    }
    reasonByReview.set(review.id, {
      reason: SELECTION_EXCLUSION_REASONS.FLAGGED_DECISION,
      detail: `decision ${review.decision} requires human review and is excluded from display`,
    });
    return false;
  });

  const clusters = clusterReviews(allowed);
  const representatives: SelectedReview[] = [];
  for (const cluster of clusters) {
    const best = [...cluster.items].sort((a, b) => baseScore(b, now) - baseScore(a, now))[0]!;
    representatives.push({
      ...best,
      selectionScore: baseScore(best, now),
      selectionReason: 'Highest-trust representative of a near-duplicate cluster.',
      clusterId: cluster.id,
    });
    for (const member of cluster.items) {
      if (member.id !== best.id) {
        reasonByReview.set(member.id, {
          reason: SELECTION_EXCLUSION_REASONS.DUPLICATE_CLUSTER,
          detail: `collapsed into cluster ${cluster.id}`,
        });
      }
    }
  }

  const selected: SelectedReview[] = [];
  const selectedIds = new Set<string>();
  const coveredAspects = new Set<string>();
  const remaining = [...representatives];

  const markSelected = (review: SelectedReview): void => {
    selected.push(review);
    selectedIds.add(review.id);
    for (const aspect of aspectsOf(review.text)) coveredAspects.add(aspect);
  };

  const mmrValue = (candidate: ScoredReviewInput): number => {
    const base = baseScore(candidate, now);
    const maxSimilarity = selected.length
      ? Math.max(...selected.map((item) => textSimilarity(candidate.text, item.text)))
      : 0;
    const newAspects = aspectsOf(candidate.text).filter((aspect) => !coveredAspects.has(aspect));
    const aspectBonus = Math.min(0.2, newAspects.length * 0.06);
    return diversify
      ? lambda * (base + aspectBonus) - (1 - lambda) * maxSimilarity
      : base + aspectBonus;
  };

  const pickFromRemaining = (): SelectedReview | undefined => {
    if (remaining.length === 0) return undefined;
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const value = mmrValue(candidate);
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    const chosen = remaining.splice(bestIndex, 1)[0]!;
    const chosenAspects = aspectsOf(chosen.text);
    return {
      ...chosen,
      selectionScore: Number(bestValue.toFixed(5)),
      selectionReason:
        chosenAspects.length > 0
          ? `Trustworthy review covering: ${chosenAspects.slice(0, 4).join(', ')}.`
          : chosen.selectionReason,
    };
  };

  while (selected.length < limit && remaining.length > 0) {
    const chosen = pickFromRemaining()!;
    markSelected(chosen);
  }

  // Rare-event inclusion (description–experience gap, doc 1.2): consumers who
  // sample a few reviews underweight defects. Guarantee one representative per
  // present 1–3 star bucket when capacity allows; displace the weakest
  // non-critical selection otherwise. Never silently — displaced reviews are
  // listed in `exclusions`.
  if (ensureCritical) {
    for (const bucket of [1, 2, 3]) {
      if (selected.some((review) => bucketOf(review) === bucket)) continue;
      const candidatePool = representatives.filter(
        (review) => bucketOf(review) === bucket && !selectedIds.has(review.id),
      );
      const candidate = [...candidatePool].sort((a, b) => b.selectionScore - a.selectionScore)[0];
      if (!candidate) continue;
      const candidateIndex = remaining.indexOf(candidate);

      if (selected.length < limit) {
        const pick =
          candidateIndex >= 0 ? remaining.splice(candidateIndex, 1)[0]! : { ...candidate };
        markSelected({
          ...pick,
          selectionReason: 'Ensured representation of a critical (1–3 star) rating bucket.',
        });
        continue;
      }

      let weakestIndex = -1;
      let weakestScore = Infinity;
      for (let index = 0; index < selected.length; index += 1) {
        const review = selected[index]!;
        if (bucketOf(review) <= 3) continue; // never displace critical coverage
        if (review.selectionScore < weakestScore) {
          weakestScore = review.selectionScore;
          weakestIndex = index;
        }
      }
      if (weakestIndex === -1) continue;
      const displaced = selected[weakestIndex]!;
      selected[weakestIndex] = {
        ...candidate,
        selectionReason: 'Ensured representation of a critical (1–3 star) rating bucket.',
      };
      selectedIds.delete(displaced.id);
      selectedIds.add(candidate.id);
      for (const aspect of aspectsOf(displaced.text)) coveredAspects.delete(aspect);
      for (const aspect of aspectsOf(candidate.text)) coveredAspects.add(aspect);
      reasonByReview.set(displaced.id, {
        reason: SELECTION_EXCLUSION_REASONS.REPLACED_FOR_CRITICAL_COVERAGE,
        detail: `displaced by a ${bucket}-star representative so negative feedback stays visible`,
      });
    }
  }

  for (const review of [...remaining, ...representatives]) {
    if (!selectedIds.has(review.id) && !reasonByReview.has(review.id)) {
      reasonByReview.set(review.id, {
        reason: SELECTION_EXCLUSION_REASONS.CAPACITY_LIMIT,
        detail: `selection limit reached (${limit})`,
      });
    }
  }

  return {
    reviews: selected,
    clusters: clusters.length,
    aspectsCovered: Array.from(coveredAspects).sort(),
    excluded: reviews.length - selected.length,
    exclusions: reviews
      .filter((review) => reasonByReview.has(review.id) && !selectedIds.has(review.id))
      .map((review) => ({
        reviewId: review.id,
        reason: reasonByReview.get(review.id)!.reason,
        detail: reasonByReview.get(review.id)!.detail,
      })),
  };
}
