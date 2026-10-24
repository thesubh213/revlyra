import {
  type AnalysisResult,
  aggregateFamilies,
  analyzeReview,
  type CanonicalReview,
  canonicalReviewSchema,
  computeIntegrity,
  type IntegrityResult,
  type ItemProfile,
  type ModelArtifact,
  minhashBandKeys,
  minhashSignature,
  normalizeReview,
  type Policy,
  type ReviewContext,
  type ScoredReviewInput,
  type SelectionOptions,
  type SelectionResult,
  type SemanticHints,
  type Signal,
  selectReviews,
  sha256Hex,
  shingles,
  simhashBandKeys,
} from '@revlyra/core';
import type { RevlyraConfig } from '../config';
import type { Entitlements } from '../license';
import { processReviewMedia } from '../media';
import { hmacHex, scopedHmac, stripIdentityKeys } from '../privacy';
import type { Store } from '../store';
import type { ReviewRecord, SignalRecord } from '../store/types';
import { prepareAnalysisContext } from './context';

export class LicenseError extends Error {
  readonly code = 'LICENSE_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'LicenseError';
  }
}

export class LimitError extends Error {
  readonly code = 'LIMIT_EXCEEDED';

  constructor(message: string) {
    super(message);
    this.name = 'LimitError';
  }
}

export class ReviewNotFoundError extends Error {
  readonly code = 'REVIEW_NOT_FOUND';
  readonly statusCode = 404;

  constructor(message = 'Review not found.') {
    super(message);
    this.name = 'ReviewNotFoundError';
  }
}

export interface IngestReviewInput {
  review: CanonicalReview;
  reviewer?: {
    accountCreatedAt?: string;
    stats?: Record<string, unknown>;
  };
  item?: {
    category?: string;
    attributes?: Record<string, unknown>;
    stats?: Record<string, unknown>;
  };
  sourceId?: string;
}

export interface IngestResult {
  review: ReviewRecord;
  result: AnalysisResult;
  mediaWarnings?: string[];
}

export interface SemanticProvider {
  analyze: (
    text: string,
    neighbors?: Array<{ id: string; text: string }>,
  ) => Promise<SemanticHints>;
}

export interface ServiceOptions {
  store: Store;
  config: RevlyraConfig;
  entitlements: Entitlements;
  policy: Policy;
  model: ModelArtifact;
  semanticProvider?: SemanticProvider;
}

function periodKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function sanitizeContext(
  context: ReviewContext | undefined,
  pepper: string,
  tenantId: string,
): Record<string, unknown> {
  if (!context) return {};
  const subnet = context.subnet ?? deriveSubnetFromIp(context.ip);
  const result: Record<string, unknown> = {};
  if (subnet) result.subnet = subnet;
  if (context.ipCountry) result.ipCountry = context.ipCountry;
  if (context.ipAsn !== undefined) result.ipAsn = context.ipAsn;
  if (context.ipAsnOrg) result.ipAsnOrg = context.ipAsnOrg;
  if (context.deviceId) result.deviceId = hmacHex(pepper, `${tenantId}:device:${context.deviceId}`);
  if (context.userAgent) result.userAgent = context.userAgent;
  if (context.locale) result.locale = context.locale;
  if (context.timezone) result.timezone = context.timezone;
  if (context.tlsFingerprint) result.tlsFingerprint = context.tlsFingerprint;
  if (context.headersHash) result.headersHash = context.headersHash;
  if (context.emailDomain)
    result.emailDomain = hmacHex(pepper, `${tenantId}:email:${context.emailDomain}`);
  if (context.phoneCountry) result.phoneCountry = context.phoneCountry;
  if (context.recentAccountsOnSubnet !== undefined) {
    result.recentAccountsOnSubnet = context.recentAccountsOnSubnet;
  }
  if (context.recentReviewsOnSubnet !== undefined) {
    result.recentReviewsOnSubnet = context.recentReviewsOnSubnet;
  }
  if (context.recentAccountsOnDevice !== undefined) {
    result.recentAccountsOnDevice = context.recentAccountsOnDevice;
  }
  if (context.isDatacenterAsn !== undefined) result.isDatacenterAsn = context.isDatacenterAsn;
  if (context.localeMismatch !== undefined) result.localeMismatch = context.localeMismatch;
  if (context.headlessUserAgent !== undefined) {
    result.headlessUserAgent = context.headlessUserAgent;
  }
  return result;
}

function deriveSubnetFromIp(ip?: string): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (trimmed.includes(':')) {
    const groups = trimmed.split(':').filter(Boolean);
    return groups.length >= 3 ? `${groups.slice(0, 3).join(':')}::/48` : null;
  }
  const parts = trimmed.split('.');
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function sanitizeMedia(media: CanonicalReview['media']): Array<Record<string, unknown>> {
  return (media ?? []).map((item) => ({
    ...(item.sha256 ? { sha256: item.sha256 } : {}),
    ...(item.dhash ? { dhash: item.dhash } : {}),
    ...(item.phash ? { phash: item.phash } : {}),
    ...(item.width ? { width: item.width } : {}),
    ...(item.height ? { height: item.height } : {}),
    ...(item.mime ? { mime: item.mime } : {}),
    ...(item.exif ? { exif: item.exif } : {}),
    ...(item.capturedAt ? { capturedAt: item.capturedAt } : {}),
  }));
}

function recordToSignals(signals: SignalRecord[]): Signal[] {
  return signals.map((signal) => ({
    code: signal.code,
    family: signal.family,
    severity: signal.severity,
    confidence: signal.confidence,
    evidence: signal.evidence,
    explanation: signal.explanation,
    ...(signal.hard ? { hard: true } : {}),
  }));
}

export class ReviewService {
  private readonly store: Store;
  private readonly config: RevlyraConfig;
  private readonly entitlements: Entitlements;
  private readonly policy: Policy;
  private readonly model: ModelArtifact;
  private readonly semanticProvider?: SemanticProvider;

  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.config = options.config;
    this.entitlements = options.entitlements;
    this.policy = options.policy;
    this.model = options.model;
    this.semanticProvider = options.semanticProvider;
  }

  getStore(): Store {
    return this.store;
  }

  getPolicy(): Policy {
    return this.policy;
  }

  getModel(): ModelArtifact {
    return this.model;
  }

  getEntitlements(): Entitlements {
    return this.entitlements;
  }

  assertLicense(): void {
    if (!this.entitlements.valid) {
      throw new LicenseError(
        `License is not valid: ${this.entitlements.status.reason ?? 'unknown reason'}`,
      );
    }
  }

  assertFeature(feature: string): void {
    this.assertLicense();
    this.entitlements.assert(feature);
  }

  async ingest(tenantId: string, input: IngestReviewInput, actor = 'api'): Promise<IngestResult> {
    this.assertLicense();
    const parsedReview = canonicalReviewSchema.parse(input.review) as CanonicalReview;
    const pepper = this.config.privacy.pepper;
    if (!pepper) throw new Error('REVLYRA_PII_PEPPER is required.');

    let mediaWarnings: string[] = [];
    let media = parsedReview.media ?? [];
    if (this.config.detection.mediaEnabled && media.length > 0) {
      this.assertFeature('media');
      const processed = await processReviewMedia(media, { concurrency: 2, maxItems: 10 });
      media = processed.media;
      mediaWarnings = processed.warnings;
    }
    const review: CanonicalReview = { ...parsedReview, media };

    await this.store.ensureTenant(tenantId);
    const period = periodKey();
    const used = await this.store.getUsage(tenantId, 'reviews', period);
    if (used >= this.entitlements.reviewsPerMonth) {
      throw new LimitError(
        `Monthly review limit of ${this.entitlements.reviewsPerMonth} exceeded.`,
      );
    }

    const reviewerHmac = scopedHmac(pepper, tenantId, 'reviewer', review.reviewerId);
    const itemHmac = scopedHmac(pepper, tenantId, 'item', review.itemId);
    const externalId =
      review.externalId ??
      review.id ??
      `${review.itemId}:${review.reviewerId}:${review.submittedAt}`;
    const reviewHmac = scopedHmac(pepper, tenantId, 'review', externalId);

    const existingReviewer = await this.store.getReviewer(tenantId, reviewerHmac);
    const reviewerScrub = stripIdentityKeys(
      {
        ...(existingReviewer?.stats ?? {}),
        ...(input.reviewer?.stats ?? {}),
      } as Record<string, unknown>,
      { enabled: this.config.privacy.identityMinimization },
    );
    if (reviewerScrub.stripped.length > 0) {
      await this.store.appendAudit({
        tenantId,
        actor: 'system:identity-scrub',
        action: 'review.identity_keys_stripped',
        targetType: 'reviewer',
        targetId: reviewerHmac,
        payload: { keys: reviewerScrub.stripped },
      });
    }
    const mergedReviewerStats = reviewerScrub.metadata;
    const reviewerRecord = await this.store.upsertReviewer({
      tenantId,
      externalHmac: reviewerHmac,
      accountCreatedAt:
        input.reviewer?.accountCreatedAt ??
        (typeof review.metadata?.accountCreatedAt === 'string'
          ? review.metadata.accountCreatedAt
          : null),
      stats: mergedReviewerStats,
      riskScore: existingReviewer?.riskScore ?? 0,
      riskBand: existingReviewer?.riskBand ?? 'low',
    });

    const existingItem = await this.store.getItem(tenantId, itemHmac);
    const itemAttributeScrub = stripIdentityKeys(
      {
        ...(existingItem?.attributes ?? {}),
        ...(input.item?.attributes ?? {}),
      } as Record<string, unknown>,
      { enabled: this.config.privacy.identityMinimization },
    );
    const mergedItemAttributes = itemAttributeScrub.metadata;
    const mergedItemStats = {
      ...(existingItem?.stats ?? {}),
      ...(input.item?.stats ?? {}),
    };
    const itemRecord = await this.store.upsertItem({
      tenantId,
      externalHmac: itemHmac,
      type: typeof review.metadata?.itemType === 'string' ? review.metadata.itemType : 'product',
      category: input.item?.category ?? existingItem?.category ?? null,
      attributes: mergedItemAttributes,
      stats: mergedItemStats,
    });

    const normalized = normalizeReview(review);
    const analysisHash = sha256Hex(
      JSON.stringify({
        text: normalized.exactHash,
        rating: review.rating,
        submittedAt: review.submittedAt,
        verified: review.verifiedPurchase ?? false,
        reviewerStats: mergedReviewerStats,
        itemStats: mergedItemStats,
        policy: this.policy.version,
        model: this.model.version,
      }),
    );

    const sourceId = input.sourceId ?? 'api';
    const existing = await this.store.findReviewByExternal(tenantId, sourceId, reviewHmac);
    if (existing && existing.analysisHash === analysisHash && existing.score !== null) {
      const signals = await this.store.getSignals(existing.id);
      return {
        review: existing,
        result: this.rebuildResult(existing, signals),
        ...(mediaWarnings.length > 0 ? { mediaWarnings } : {}),
      };
    }

    const context = {
      ...sanitizeContext(review.context, pepper, tenantId),
      verifiedKnown: review.verifiedPurchase !== undefined,
    };
    const storedText = this.config.privacy.storeRawText ? review.text : normalized.text;
    const reviewRecord = await this.store.upsertReview({
      ...(existing ? { id: existing.id } : {}),
      tenantId,
      sourceId,
      externalHmac: reviewHmac,
      itemId: itemRecord.id,
      reviewerId: reviewerRecord.id,
      rating: review.rating,
      text: storedText,
      textSha256: normalized.exactHash,
      simhash: normalized.simhash,
      language: normalized.language,
      submittedAt: review.submittedAt,
      verified: review.verifiedPurchase ?? false,
      context,
      media: sanitizeMedia(review.media),
      analysisHash,
    });

    const prepared = await prepareAnalysisContext(this.store, this.config, reviewRecord);

    if (this.semanticProvider && this.config.detection.transformerEnabled) {
      try {
        this.assertFeature('transformer');
        const neighbors = (await this.store.listItemReviews(tenantId, reviewRecord.itemId, 21))
          .filter((item) => item.id !== reviewRecord.id)
          .slice(0, 10)
          .map((item) => ({ id: item.id, text: item.text }));
        // Injection-sanitized copy: prompt-injection phrases must never reach
        // the model tier (doc 3.2).
        prepared.analysis.semantic = await this.semanticProvider.analyze(
          prepared.normalized.modelText,
          neighbors,
        );
      } catch {
        // Semantic enrichment is optional; base detectors remain authoritative.
      }
    }

    const result = analyzeReview(prepared.canonical, prepared.analysis, {
      policy: this.policy,
      model: this.model,
    });

    const contributionByCode = new Map(
      result.reasons.map((reason) => [reason.code, reason.contribution]),
    );
    const signalRecords: SignalRecord[] = result.signals.map((signal, index) => ({
      id: index + 1,
      reviewId: reviewRecord.id,
      code: signal.code,
      family: signal.family,
      severity: signal.severity,
      confidence: signal.confidence,
      contribution: contributionByCode.get(signal.code) ?? 0,
      evidence: signal.evidence,
      explanation: signal.explanation,
      hard: signal.hard === true,
    }));

    await this.store.insertSignals(reviewRecord.id, signalRecords);
    await this.store.updateReviewAnalysis(tenantId, reviewRecord.id, {
      score: result.score,
      confidence: result.confidence,
      decision: result.decision,
      band: result.band,
      provisional: result.provisional,
      modelVersion: result.modelVersion,
      policyVersion: result.policyVersion,
      analysisHash,
    });

    await this.store.upsertTextIndex({
      tenantId,
      reviewId: reviewRecord.id,
      reviewerId: reviewerRecord.id,
      itemId: itemRecord.id,
      textSha256: normalized.exactHash,
      simhash: normalized.simhash,
      simhashBands: simhashBandKeys(normalized.simhash, 4, 16),
      minhashBands: minhashBandKeys(minhashSignature(shingles(normalized.tokens, 5)), 16),
      submittedAt: review.submittedAt,
    });

    for (const media of review.media ?? []) {
      if (!media.sha256 && !media.phash && !media.dhash && !media.exif) continue;
      await this.store.upsertMedia({
        tenantId,
        reviewId: reviewRecord.id,
        reviewerId: reviewerRecord.id,
        itemId: itemRecord.id,
        sha256: media.sha256 ?? null,
        dhash: media.dhash ?? null,
        phash: media.phash ?? null,
        width: media.width ?? null,
        height: media.height ?? null,
        mime: media.mime ?? null,
        exif: media.exif ?? {},
        urlHmac: media.url ? hmacHex(pepper, media.url) : null,
        phashBands: media.phash ? simhashBandKeys(media.phash, 4, 16) : [],
      });
    }

    await this.store.upsertReviewEdge({
      tenantId,
      reviewerId: reviewerRecord.id,
      itemId: itemRecord.id,
      reviewId: reviewRecord.id,
      submittedAt: review.submittedAt,
      risk: result.score,
      signals: Array.from(new Set(result.signals.map((signal) => signal.family))),
    });

    await this.store.incrementUsage(tenantId, 'reviews', period, 1);

    await this.store.appendAudit({
      tenantId,
      actor,
      action: 'review.analyzed',
      targetType: 'review',
      targetId: reviewRecord.id,
      payload: {
        score: Number(result.score.toFixed(4)),
        decision: result.decision,
        band: result.band,
        modelVersion: result.modelVersion,
        policyVersion: result.policyVersion,
      },
    });

    const updated = (await this.store.getReview(tenantId, reviewRecord.id))!;
    return {
      review: updated,
      result,
      ...(mediaWarnings.length > 0 ? { mediaWarnings } : {}),
    };
  }

  rebuildResult(review: ReviewRecord, signals: SignalRecord[]): AnalysisResult {
    const signalList = recordToSignals(signals);
    const details = aggregateFamilies(signalList);
    const familyScores = Object.fromEntries(
      Object.entries(details).map(([family, detail]) => [family, detail.score]),
    ) as AnalysisResult['familyScores'];
    const reasons = signals
      .map((signal) => ({
        code: signal.code,
        family: signal.family,
        contribution: signal.contribution,
        severity: signal.severity,
        confidence: signal.confidence,
        message: signal.explanation,
        evidence: signal.evidence,
      }))
      .sort((a, b) => b.contribution - a.contribution);
    const safetySignal = signalList.find((signal) => signal.code === 'SAFETY_REVIEW');
    let safety: AnalysisResult['safety'] | undefined;
    if (safetySignal) {
      safety = {
        routed: true,
        categories: Array.isArray(safetySignal.evidence.categories)
          ? (safetySignal.evidence.categories as string[])
          : [],
        styleSuppressed: signalList.some(
          (signal) => signal.code.startsWith('TEXT_') && signal.evidence.styleSuppressed === true,
        ),
      };
    }
    return {
      reviewId: review.id,
      score: review.score ?? 0,
      band: review.band ?? 'low',
      decision: review.decision ?? 'allow',
      confidence: review.confidence ?? 0,
      dataCompleteness: review.confidence ?? 0,
      signals: signalList,
      reasons,
      familyScores,
      familyDetails: details,
      modelScore: 0,
      modelVersion: review.modelVersion ?? this.model.version,
      policyVersion: review.policyVersion ?? this.policy.version,
      provisional: review.provisional,
      ...(safety ? { safety } : {}),
      timings: {},
    };
  }

  async getResult(
    tenantId: string,
    reviewId: string,
  ): Promise<{
    review: ReviewRecord;
    signals: SignalRecord[];
    result: AnalysisResult;
  } | null> {
    const review = await this.store.getReview(tenantId, reviewId);
    if (!review) return null;
    const signals = await this.store.getSignals(reviewId);
    return { review, signals, result: this.rebuildResult(review, signals) };
  }

  private async resolveItem(tenantId: string, identifier: string) {
    const byId = await this.store.getItemById(tenantId, identifier);
    if (byId) return byId;
    const hmac = scopedHmac(this.config.privacy.pepper, tenantId, 'item', identifier);
    return this.store.getItem(tenantId, hmac);
  }

  async selectReviews(
    tenantId: string,
    itemIdentifier: string,
    options: SelectionOptions = {},
  ): Promise<{ itemId: string; selection: SelectionResult } | null> {
    const item = await this.resolveItem(tenantId, itemIdentifier);
    if (!item) return null;
    const reviews = await this.store.listItemReviews(tenantId, item.id, 500);
    const inputs: ScoredReviewInput[] = reviews.map((review) => ({
      id: review.id,
      rating: review.rating,
      text: review.text,
      submittedAt: review.submittedAt,
      trustScore: 1 - (review.score ?? 0),
      decision: review.decision ?? 'allow',
      helpfulness: 0.5,
      mediaCount: review.media.length,
      ...(review.language ? { language: review.language } : {}),
    }));
    const policyDefault = this.policy.integrity?.ensureCritical;
    const mergedOptions: SelectionOptions = {
      ...options,
      ...(options.ensureCritical === undefined && policyDefault !== undefined
        ? { ensureCritical: policyDefault }
        : {}),
    };
    return { itemId: item.id, selection: selectReviews(inputs, mergedOptions) };
  }

  async computeIntegrity(
    tenantId: string,
    itemIdentifier: string,
  ): Promise<{ itemId: string; integrity: IntegrityResult } | null> {
    const item = await this.resolveItem(tenantId, itemIdentifier);
    if (!item) return null;
    const reviews = await this.store.listItemReviews(tenantId, item.id, 500);
    const inputs = [];
    for (const review of reviews) {
      const signals = await this.store.getSignals(review.id);
      inputs.push({
        rating: review.rating,
        trustScore: 1 - (review.score ?? 0),
        decision: review.decision ?? 'allow',
        submittedAt: review.submittedAt,
        verifiedPurchase: review.context.verifiedKnown === false ? undefined : review.verified,
        concerns: signals.filter((signal) => signal.severity >= 0.4).map((signal) => signal.code),
      });
    }

    const baselineRaw = item.stats.baselineDistribution ?? item.attributes.baselineDistribution;
    const baseline = Array.isArray(baselineRaw) ? (baselineRaw as number[]) : undefined;
    const priorMean =
      typeof item.stats.baselineMean === 'number'
        ? item.stats.baselineMean
        : typeof item.attributes.baselineMean === 'number'
          ? item.attributes.baselineMean
          : 4.2;

    const integrityOptions = this.policy.integrity ?? {};
    const integrity = computeIntegrity(inputs, {
      priorMean,
      priorWeight: 10,
      ...(baseline ? { baselineDistribution: baseline } : {}),
      ...(integrityOptions.recencyHalfLifeDays !== undefined
        ? { recencyHalfLifeDays: integrityOptions.recencyHalfLifeDays }
        : {}),
      ...(integrityOptions.verifiedBoost !== undefined
        ? { verifiedBoost: integrityOptions.verifiedBoost }
        : {}),
      ...(integrityOptions.unverifiedFactor !== undefined
        ? { unverifiedFactor: integrityOptions.unverifiedFactor }
        : {}),
    });
    return { itemId: item.id, integrity };
  }

  async feedback(
    tenantId: string,
    input: {
      reviewId: string;
      label: string;
      reasonCode: string;
      notes?: string;
      actorHmac?: string;
    },
  ): Promise<{ id: string }> {
    const review = await this.store.getReview(tenantId, input.reviewId);
    if (!review) throw new ReviewNotFoundError();
    const allowed = new Set(['genuine', 'fake', 'unsure', 'policy_violation']);
    if (!allowed.has(input.label)) throw new Error('FEEDBACK_LABEL_INVALID');
    const record = await this.store.insertFeedback({
      tenantId,
      reviewId: input.reviewId,
      label: input.label,
      reasonCode: input.reasonCode,
      notes: input.notes ?? null,
      actorHmac: input.actorHmac ?? null,
    });
    await this.store.appendAudit({
      tenantId,
      actor: input.actorHmac ?? 'api',
      action: 'review.feedback',
      targetType: 'review',
      targetId: input.reviewId,
      payload: { label: input.label, reasonCode: input.reasonCode },
    });
    return { id: record.id };
  }

  async itemProfile(tenantId: string, itemIdentifier: string): Promise<ItemProfile | null> {
    const item = await this.resolveItem(tenantId, itemIdentifier);
    if (!item) return null;
    return {
      id: item.id,
      ...(item.category ? { category: item.category } : {}),
      attributes: item.attributes,
      ...(typeof item.stats.baselineMean === 'number'
        ? { baselineMean: item.stats.baselineMean }
        : {}),
      ...(Array.isArray(item.stats.baselineDistribution)
        ? { baselineDistribution: item.stats.baselineDistribution as number[] }
        : {}),
      ...(typeof item.stats.expectedReviewsPerDay === 'number'
        ? { expectedReviewsPerDay: item.stats.expectedReviewsPerDay }
        : {}),
    };
  }
}
