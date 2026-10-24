import type { DecisionKind, RiskBand, SignalFamily } from '@revlyra/core';

export interface TenantRecord {
  id: string;
  name: string;
  policyId: string;
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  rateLimit: number | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface SourceRecord {
  id: string;
  tenantId: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  mapping: Record<string, unknown>;
  cursor: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewerRecord {
  id: string;
  tenantId: string;
  externalHmac: string;
  accountCreatedAt: string | null;
  stats: Record<string, unknown>;
  riskScore: number;
  riskBand: RiskBand;
  firstSeen: string;
  lastSeen: string;
}

export interface ItemRecord {
  id: string;
  tenantId: string;
  externalHmac: string;
  type: string;
  category: string | null;
  attributes: Record<string, unknown>;
  stats: Record<string, unknown>;
  createdAt: string;
}

export interface ReviewRecord {
  id: string;
  tenantId: string;
  sourceId: string;
  externalHmac: string;
  itemId: string;
  reviewerId: string;
  rating: number;
  text: string;
  textSha256: string;
  simhash: string;
  language: string;
  submittedAt: string;
  ingestedAt: string;
  verified: boolean;
  context: Record<string, unknown>;
  media: Array<Record<string, unknown>>;
  status: string;
  score: number | null;
  confidence: number | null;
  decision: DecisionKind | null;
  band: RiskBand | null;
  provisional: boolean;
  analysisHash: string | null;
  modelVersion: string | null;
  policyVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignalRecord {
  id: number;
  reviewId: string;
  code: string;
  family: SignalFamily;
  severity: number;
  confidence: number;
  contribution: number;
  evidence: Record<string, unknown>;
  explanation: string;
  hard: boolean;
}

export interface TextIndexRecord {
  id: string;
  tenantId: string;
  textSha256: string;
  simhash: string;
  reviewId: string;
  reviewerId: string;
  itemId: string;
  submittedAt: string;
  createdAt: string;
}

export interface TextMatchRow {
  reviewId: string;
  reviewerId: string;
  itemId: string;
  submittedAt: string | null;
  similarity: number;
  kind: 'exact' | 'near';
}

export interface MediaRecord {
  id: string;
  tenantId: string;
  reviewId: string;
  reviewerId: string;
  itemId: string;
  sha256: string | null;
  dhash: string | null;
  phash: string | null;
  width: number | null;
  height: number | null;
  mime: string | null;
  exif: Record<string, unknown>;
  urlHmac: string | null;
  createdAt: string;
}

export interface MediaMatchRow {
  reviewId: string;
  reviewerId: string;
  itemId: string;
  kind: 'exact' | 'near';
  distance: number;
}

export interface JobRecord {
  id: string;
  tenantId: string;
  kind: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'dead';
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackRecord {
  id: string;
  tenantId: string;
  reviewId: string;
  label: string;
  reasonCode: string;
  notes: string | null;
  actorHmac: string | null;
  createdAt: string;
}

export interface AppealRecord {
  id: string;
  tenantId: string;
  reviewId: string;
  status: 'open' | 'upheld' | 'overturned';
  reason: string | null;
  createdAt: string;
  /** Promise date for human-supervised handling (DSA Art. 20 timely manner). */
  slaDueAt: string | null;
  resolvedAt: string | null;
  /** Handler HMAC is required for adjudication — never purely automated. */
  handlerHmac: string | null;
  outcomeNote: string | null;
}

export type NoticeType = 'complaint' | 'legal' | 'authority';
export type NoticeStatus = 'received' | 'under_review' | 'actioned' | 'rejected' | 'expired';

/** DSA Art. 16 notice-and-action record for reviews hosted by the tenant. */
export interface NoticeRecord {
  id: string;
  tenantId: string;
  reviewId: string;
  type: NoticeType;
  claim: string;
  substantiated: boolean;
  status: NoticeStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
}

export interface CreateNoticeInput {
  tenantId: string;
  reviewId: string;
  type: NoticeType;
  claim: string;
  substantiated?: boolean;
  metadata?: Record<string, unknown>;
}

export interface NoticeStatusInput {
  status: NoticeStatus;
  note?: string;
}

/** Group keys for heterogeneous campaign edges (template hashes, device and
 * subnet contexts) taken from the reviews table. */
export interface ReviewGroupKeyRow {
  reviewId: string;
  reviewerId: string;
  textSha256: string;
  context: Record<string, unknown>;
  submittedAt: string;
}

export interface AuditRecord {
  seq: number;
  tenantId: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
  createdAt: string;
}

export interface CampaignRecord {
  id: string;
  tenantId: string;
  kind: string;
  score: number;
  density: number;
  memberCount: number;
  reviewerIds: string[];
  itemIds: string[];
  evidence: Record<string, unknown>;
  status: 'candidate' | 'confirmed' | 'dismissed';
  createdAt: string;
  updatedAt: string;
}

export interface UsageRecord {
  metric: string;
  period: string;
  value: number;
}

export interface ReviewerAggregates {
  totalReviews: number;
  reviewsLast24h: number;
  reviewsLast7d: number;
  reviewsLast30d: number;
  averageRating: number | null;
  ratingStdDev: number | null;
  ratingDistribution: number[];
  fiveStarRatio: number | null;
  firstReviewAt: string | null;
  lastReviewAt: string | null;
  recentTimestamps: string[];
  recentIntervalsSeconds: number[];
}

export interface ItemAggregates {
  totalReviews: number;
  averageRating: number | null;
  ratingStdDev: number | null;
  ratingDistribution: number[];
  recentReviews24h: number;
  recentReviews7d: number;
}

export interface CorpusStatsRow {
  totalReviews: number;
}

export interface CreateApiKeyInput {
  tenantId: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  rateLimit?: number | null;
  expiresAt?: string | null;
}

export interface CreateSourceInput {
  tenantId: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  mapping: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpsertReviewInput {
  id?: string;
  tenantId: string;
  sourceId?: string;
  externalHmac: string;
  itemId: string;
  reviewerId: string;
  rating: number;
  text: string;
  textSha256: string;
  simhash: string;
  language: string;
  submittedAt: string;
  verified: boolean;
  context: Record<string, unknown>;
  media: Array<Record<string, unknown>>;
  analysisHash?: string | null;
}

export interface UpdateReviewAnalysisInput {
  score: number;
  confidence: number;
  decision: DecisionKind;
  band: RiskBand;
  provisional: boolean;
  modelVersion: string;
  policyVersion: string;
  analysisHash: string;
}

export interface UpsertTextIndexInput {
  tenantId: string;
  reviewId: string;
  reviewerId: string;
  itemId: string;
  textSha256: string;
  simhash: string;
  simhashBands: string[];
  minhashBands: string[];
  submittedAt: string;
}

export interface UpsertMediaInput {
  tenantId: string;
  reviewId: string;
  reviewerId: string;
  itemId: string;
  sha256?: string | null;
  dhash?: string | null;
  phash?: string | null;
  width?: number | null;
  height?: number | null;
  mime?: string | null;
  exif?: Record<string, unknown>;
  urlHmac?: string | null;
  phashBands?: string[];
}

export interface UpsertReviewEdgeInput {
  tenantId: string;
  reviewerId: string;
  itemId: string;
  reviewId: string;
  submittedAt: string;
  risk: number;
  signals: string[];
}

export interface ResolveAppealInput {
  status: 'upheld' | 'overturned';
  handlerHmac: string | null;
  outcomeNote?: string | null;
  resolvedAt?: string | null;
}

export interface CreateJobInput {
  tenantId: string;
  kind: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  runAfter?: string;
}

export interface AuditInput {
  tenantId: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  payload?: Record<string, unknown>;
}
