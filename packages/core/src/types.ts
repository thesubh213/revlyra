export type SignalFamily =
  | 'content'
  | 'behaviour'
  | 'temporal'
  | 'media'
  | 'network'
  | 'graph'
  | 'rating'
  | 'policy';

export type DecisionKind = 'allow' | 'label' | 'downrank' | 'hold' | 'remove' | 'escalate';

export type RiskBand = 'low' | 'medium' | 'high' | 'critical';

export interface ReviewMedia {
  url?: string;
  sha256?: string;
  dhash?: string;
  phash?: string;
  width?: number;
  height?: number;
  mime?: string;
  exif?: Record<string, unknown>;
  capturedAt?: string;
}

export interface ReviewContext {
  /** Raw IP is accepted for derived features but must not be persisted by callers. */
  ip?: string;
  ipCountry?: string;
  ipAsn?: string | number;
  ipAsnOrg?: string;
  subnet?: string;
  deviceId?: string;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  tlsFingerprint?: string;
  headersHash?: string;
  emailDomain?: string;
  phoneCountry?: string;
  recentAccountsOnSubnet?: number;
  recentReviewsOnSubnet?: number;
  recentAccountsOnDevice?: number;
  isDatacenterAsn?: boolean;
  localeMismatch?: boolean;
  headlessUserAgent?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Declared relationship between the reviewer and the reviewed business (FTC
 * 16 CFR § 465.5). Sources that know the relationship must supply it; reviewers
 * without a declared relationship should omit the field entirely.
 */
export type ReviewerRelationship =
  | 'customer'
  | 'employee'
  | 'former_employee'
  | 'owner'
  | 'contractor'
  | 'family'
  | 'competitor'
  | 'other';

export const INSIDER_RELATIONSHIPS: ReviewerRelationship[] = [
  'employee',
  'former_employee',
  'owner',
  'contractor',
  'family',
  'competitor',
  'other',
];

export interface CanonicalReview {
  id: string;
  tenantId?: string;
  externalId?: string;
  itemId: string;
  reviewerId: string;
  rating: number;
  text: string;
  title?: string;
  language?: string;
  submittedAt: string;
  verifiedPurchase?: boolean;
  reviewerRelationship?: ReviewerRelationship;
  media?: ReviewMedia[];
  context?: ReviewContext;
  metadata?: Record<string, unknown>;
}

export interface ReviewerProfile {
  id: string;
  accountCreatedAt?: string;
  totalReviews?: number;
  reviewsLast24h?: number;
  reviewsLast7d?: number;
  reviewsLast30d?: number;
  averageRating?: number;
  ratingStdDev?: number;
  ratingDistribution?: number[];
  fiveStarRatio?: number;
  ratingEntropy?: number;
  verifiedPurchaseRatio?: number;
  categoryEntropy?: number;
  firstReviewAt?: string;
  lastReviewAt?: string;
  sharedDeviceCount?: number;
  sharedSubnetCount?: number;
  priorFlags?: number;
  priorAppealsOverturned?: number;
  recentIntervalsSeconds?: number[];
  recentReviewTimestamps?: string[];
  timezone?: string;
  locale?: string;
  relationship?: ReviewerRelationship;
  metadata?: Record<string, unknown>;
}

export interface ItemProfile {
  id: string;
  category?: string;
  totalReviews?: number;
  averageRating?: number;
  ratingStdDev?: number;
  fiveStarRatio?: number;
  ratingDistribution?: number[];
  recentReviews24h?: number;
  recentReviews7d?: number;
  expectedReviewsPerDay?: number;
  baselineMean?: number;
  baselineFiveStarRatio?: number;
  baselineDistribution?: number[];
  localTimezone?: string;
  attributes?: Record<string, unknown>;
}

export interface TextMatch {
  reviewId: string;
  reviewerId: string;
  itemId: string;
  similarity: number;
  kind: 'exact' | 'near' | 'template';
  submittedAt?: string;
}

export interface MediaMatch {
  reviewId: string;
  reviewerId: string;
  itemId: string;
  kind: 'exact' | 'near';
  distance: number;
}

export interface CampaignHint {
  id: string;
  score: number;
  memberCount: number;
  signalFamilies: string[];
}

export interface SemanticHints {
  paraphraseSimilarity?: number;
  paraphraseNeighborId?: string;
  llmLikelihood?: number;
}

export interface CorpusStats {
  totalReviews: number;
  documentFrequency?: Record<string, number>;
  tokenIdf?: Record<string, number>;
}

export interface PeerStats {
  medianReviewsPerDay?: number;
  medianRatingDeviation?: number;
  medianAccountAgeDays?: number;
}

export interface AnalysisContext {
  reviewer?: ReviewerProfile;
  item?: ItemProfile;
  now?: string;
  corpus?: CorpusStats;
  textMatches?: TextMatch[];
  mediaMatches?: MediaMatch[];
  campaign?: CampaignHint;
  semantic?: SemanticHints;
  peer?: PeerStats;
  detectorOverrides?: Partial<Record<string, number>>;
  metadata?: Record<string, unknown>;
}

export interface Signal {
  code: string;
  family: SignalFamily;
  severity: number;
  confidence: number;
  hard?: boolean;
  evidence: Record<string, unknown>;
  explanation: string;
}

export type FeatureSet = Record<string, number>;

export interface Detector {
  id: string;
  version: string;
  families: SignalFamily[];
  run: (ctx: DetectorContext) => Signal[];
}

export interface DetectorContext {
  review: CanonicalReview;
  analysis: AnalysisContext;
  features: FeatureSet;
  normalized: NormalizedReview;
  policy: Policy;
}

export interface NormalizedReview {
  text: string;
  /** Copy with injection phrases neutralized; this is the only text that may
   * leave the engine for semantic classifiers or LLM enrichment. */
  modelText: string;
  fingerprintText: string;
  tokens: string[];
  sentences: string[];
  language: string;
  languageConfidence: number;
  textSha256: string;
  simhash: string;
  exactHash: string;
  injectionHits: InjectionHit[];
  stats: NormalizationStats;
}

/** A prompt-injection phrase match; `quoted` suggests captured transcript. */
export interface InjectionHit {
  code: string;
  start: number;
  end: number;
  quoted: boolean;
}

export interface NormalizationStats {
  originalLength: number;
  normalizedLength: number;
  zeroWidthRemoved: number;
  homoglyphsMapped: number;
  mixedScriptTokens: number;
  fullWidthChars: number;
  urlCount: number;
  emailCount: number;
  phoneCount: number;
  emojiCount: number;
  script: string;
  injectionHits: number;
}

export interface FamilyScore {
  score: number;
  rawMax: number;
  count: number;
  hard: boolean;
}

export interface Reason {
  code: string;
  family: SignalFamily;
  contribution: number;
  severity: number;
  confidence: number;
  message: string;
  evidence: Record<string, unknown>;
}

export interface AnalysisResult {
  reviewId: string | null;
  score: number;
  band: RiskBand;
  decision: DecisionKind;
  confidence: number;
  dataCompleteness: number;
  signals: Signal[];
  reasons: Reason[];
  familyScores: Record<SignalFamily, number>;
  familyDetails: Record<SignalFamily, FamilyScore>;
  modelScore: number;
  modelVersion: string;
  policyVersion: string;
  provisional: boolean;
  /** Present when a safety-cue review was routed to the human safety channel
   * (DSA-safe moderation: never silently demoted or auto-removed). */
  safety?: SafetyRouting;
  timings: Record<string, number>;
}

export interface SafetyRouting {
  routed: boolean;
  categories: string[];
  styleSuppressed: boolean;
}

export interface PolicyThresholds {
  label: number;
  downrank: number;
  hold: number;
  remove: number;
  escalate: number;
}

export interface Policy {
  id: string;
  version: string;
  familyWeights: Record<SignalFamily, number>;
  modelWeight: number;
  intercept: number;
  thresholds: PolicyThresholds;
  hardFlagFloor: number;
  minConfidenceForRemove: number;
  autoRemove: boolean;
  /** Safety-review routing (doc 2.2/5.1: public-safety warnings must reach a
   * human channel and must never be silently demoted or auto-removed). */
  safety?: {
    enabled?: boolean;
    styleSuppression?: boolean;
  };
  /** Trust-weighted rating options (doc 1/5.1: recency + verified weighting). */
  integrity?: {
    recencyHalfLifeDays?: number;
    verifiedBoost?: number;
    unverifiedFactor?: number;
    ensureCritical?: boolean;
  };
  disabledDetectors: string[];
  disabledFamilies: SignalFamily[];
}

export interface ModelArtifact {
  version: string;
  featureSpecVersion: string;
  intercept: number;
  weights: Record<string, number>;
  calibration: { kind: 'identity' | 'isotonic'; knots?: Array<{ x: number; y: number }> };
  metrics?: Record<string, number>;
}

export interface AnalysisOptions {
  policy?: Policy;
  model?: ModelArtifact;
  now?: string;
}

export interface ScoredReviewInput {
  id: string;
  rating: number;
  text: string;
  submittedAt: string;
  trustScore: number;
  decision: DecisionKind;
  helpfulness?: number;
  specificity?: number;
  language?: string;
  aspects?: string[];
  mediaCount?: number;
}

export interface SelectedReview extends ScoredReviewInput {
  selectionScore: number;
  selectionReason: string;
  clusterId: string;
}

export interface SelectionOptions {
  limit?: number;
  minTrust?: number;
  diversify?: boolean;
  includeFlagged?: boolean;
  lambda?: number;
  /** Guarantee at least one 1–3 star representative per present bucket so
   * consumers sampling reviews cannot underweight rare defects (doc 1.2). */
  ensureCritical?: boolean;
}

export interface SelectionExclusion {
  reviewId: string;
  reason: string;
  detail: string;
}

export interface SelectionResult {
  reviews: SelectedReview[];
  clusters: number;
  aspectsCovered: string[];
  excluded: number;
  exclusions: SelectionExclusion[];
}

export interface IntegrityInputReview {
  rating: number;
  trustScore: number;
  decision: DecisionKind;
  submittedAt?: string;
  verifiedPurchase?: boolean;
  concerns?: string[];
}

/** Distributional transparency block (doc 1.1/5.1: the arithmetic mean alone
 * misleads on J-shaped rating distributions). These are transparency
 * statistics, not fraud scores — `allPositiveSuspicion` in particular reflects
 * documented consumer distrust of 100%-positive profiles. */
export interface DistributionSignals {
  stdDev: number;
  modeStars: number;
  positiveRatio: number;
  criticalShare: number;
  polarizationIndex: number;
  allPositiveSuspicion: boolean;
  verifiedShare: number;
  recencyWeightedShare90d: number;
  medianAgeDays: number | null;
}

export interface IntegrityResult {
  rawRating: number;
  adjustedRating: number;
  delta: number;
  confidenceLow: number;
  confidenceHigh: number;
  effectiveSampleSize: number;
  reviewCount: number;
  includedCount: number;
  suspicionRate: number;
  excessFiveStar: number;
  chiSquare: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  baselineDistribution: Record<'1' | '2' | '3' | '4' | '5', number> | null;
  bimodality: number;
  distributionSignals: DistributionSignals;
  topConcerns: string[];
}

export interface CampaignOptions {
  windowHours?: number;
  minMembers?: number;
  minDensity?: number;
  maxNodes?: number;
  now?: string;
}

/**
 * Edges for campaign detection. Review-level edges (reviewId set) build the
 * co-review graph; synthetic group edges (`kind` of same_* plus `groupKey`,
 * `itemId: ''`) link reviewers who share a template/media/device/subnet
 * attribute within the detection window.
 */
export type CampaignEdgeKind =
  | 'co_review'
  | 'same_template'
  | 'same_media'
  | 'same_device'
  | 'same_subnet';

export interface CampaignEdge {
  reviewerId: string;
  itemId: string;
  reviewId: string;
  submittedAt: string;
  signals?: string[];
  risk?: number;
  /** Edge provenance; undefined is treated as co_review. */
  kind?: CampaignEdgeKind;
  /** Shared-attribute bucket key for same_* edges (e.g. `text:<sha256>`). */
  groupKey?: string;
}

export interface DetectedCampaign {
  id: string;
  reviewerIds: string[];
  itemIds: string[];
  density: number;
  score: number;
  signalFamilies: string[];
  edgeKinds: CampaignEdgeKind[];
  reason: string;
}

export interface SeverityBand {
  band: RiskBand;
  decision: DecisionKind;
}

export interface CredibilityInput {
  review: CanonicalReview;
  analysis?: AnalysisContext;
}
