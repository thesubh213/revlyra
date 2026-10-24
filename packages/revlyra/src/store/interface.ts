import type {
  ApiKeyRecord,
  AppealRecord,
  AuditInput,
  AuditRecord,
  CampaignRecord,
  CorpusStatsRow,
  CreateApiKeyInput,
  CreateJobInput,
  CreateNoticeInput,
  CreateSourceInput,
  FeedbackRecord,
  ItemAggregates,
  ItemRecord,
  JobRecord,
  MediaMatchRow,
  MediaRecord,
  NoticeRecord,
  NoticeStatus,
  NoticeStatusInput,
  ReviewerAggregates,
  ReviewerRecord,
  ReviewGroupKeyRow,
  ReviewRecord,
  SignalRecord,
  SourceRecord,
  TenantRecord,
  TextMatchRow,
  UpdateReviewAnalysisInput,
  UpsertMediaInput,
  UpsertReviewEdgeInput,
  UpsertReviewInput,
  UpsertTextIndexInput,
  UsageRecord,
} from './types';

export interface Store {
  migrate(): Promise<void>;
  close(): Promise<void>;

  ensureTenant(id: string, name?: string): Promise<TenantRecord>;
  getTenant(id: string): Promise<TenantRecord | null>;
  listTenants(): Promise<TenantRecord[]>;

  createApiKey(input: CreateApiKeyInput): Promise<ApiKeyRecord>;
  findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null>;
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  listApiKeys(tenantId: string): Promise<ApiKeyRecord[]>;
  revokeApiKey(tenantId: string, id: string): Promise<boolean>;
  touchApiKey(id: string): Promise<void>;

  createSource(input: CreateSourceInput): Promise<SourceRecord>;
  getSource(tenantId: string, id: string): Promise<SourceRecord | null>;
  listSources(tenantId: string): Promise<SourceRecord[]>;
  updateSourceCursor(tenantId: string, id: string, cursor: Record<string, unknown>): Promise<void>;
  deleteSource(tenantId: string, id: string): Promise<boolean>;

  upsertReviewer(input: {
    tenantId: string;
    externalHmac: string;
    accountCreatedAt?: string | null;
    stats?: Record<string, unknown>;
    riskScore?: number;
    riskBand?: ReviewerRecord['riskBand'];
  }): Promise<ReviewerRecord>;
  getReviewer(tenantId: string, externalHmac: string): Promise<ReviewerRecord | null>;
  getReviewerById(tenantId: string, id: string): Promise<ReviewerRecord | null>;

  upsertItem(input: {
    tenantId: string;
    externalHmac: string;
    type?: string;
    category?: string | null;
    attributes?: Record<string, unknown>;
    stats?: Record<string, unknown>;
  }): Promise<ItemRecord>;
  getItem(tenantId: string, externalHmac: string): Promise<ItemRecord | null>;
  getItemById(tenantId: string, id: string): Promise<ItemRecord | null>;

  upsertReview(input: UpsertReviewInput): Promise<ReviewRecord>;
  getReview(tenantId: string, id: string): Promise<ReviewRecord | null>;
  findReviewByExternal(
    tenantId: string,
    sourceId: string,
    externalHmac: string,
  ): Promise<ReviewRecord | null>;
  updateReviewAnalysis(
    tenantId: string,
    id: string,
    input: UpdateReviewAnalysisInput,
  ): Promise<void>;
  listItemReviews(tenantId: string, itemId: string, limit?: number): Promise<ReviewRecord[]>;
  listReviewerReviews(
    tenantId: string,
    reviewerId: string,
    limit?: number,
  ): Promise<ReviewRecord[]>;
  listRecentReviews(tenantId: string, limit?: number): Promise<ReviewRecord[]>;

  insertSignals(reviewId: string, signals: SignalRecord[]): Promise<void>;
  getSignals(reviewId: string): Promise<SignalRecord[]>;

  upsertTextIndex(input: UpsertTextIndexInput): Promise<void>;
  findTextMatches(
    tenantId: string,
    input: {
      textSha256: string;
      simhash: string;
      simhashBands: string[];
      minhashBands: string[];
      excludeReviewId?: string;
      limit?: number;
    },
  ): Promise<TextMatchRow[]>;
  getTextIndex(tenantId: string, reviewId: string): Promise<TextIndexRecordLike | null>;

  upsertMedia(input: UpsertMediaInput): Promise<void>;
  findMediaMatches(
    tenantId: string,
    input: {
      sha256?: string | null;
      phash?: string | null;
      phashBands?: string[];
      excludeReviewId?: string;
      limit?: number;
    },
  ): Promise<MediaMatchRow[]>;
  listMedia(tenantId: string, reviewId: string): Promise<MediaRecord[]>;

  getReviewerAggregates(tenantId: string, reviewerId: string): Promise<ReviewerAggregates>;
  getItemAggregates(tenantId: string, itemId: string): Promise<ItemAggregates>;
  getCorpusStats(tenantId: string): Promise<CorpusStatsRow>;
  /** Decision histogram since a point in time (transparency reporting). */
  decisionCounts(
    tenantId: string,
    since: string,
  ): Promise<Array<{ decision: string; count: number }>>;
  /** Reason-code histogram since a point in time (transparency reporting). */
  signalCodeCounts(
    tenantId: string,
    since: string,
    limit?: number,
  ): Promise<Array<{ code: string; family: string; count: number }>>;

  insertFeedback(input: {
    tenantId: string;
    reviewId: string;
    label: string;
    reasonCode: string;
    notes?: string | null;
    actorHmac?: string | null;
  }): Promise<FeedbackRecord>;
  listFeedback(tenantId: string, reviewId?: string, limit?: number): Promise<FeedbackRecord[]>;

  createAppeal(input: {
    tenantId: string;
    reviewId: string;
    reason?: string | null;
    /** Assigned SLA promise date (DSA Art. 20 timely handling). */
    slaDueAt?: string | null;
  }): Promise<AppealRecord>;
  resolveAppeal(
    tenantId: string,
    id: string,
    status: 'upheld' | 'overturned',
    handlerHmac?: string | null,
    outcomeNote?: string | null,
  ): Promise<AppealRecord | null>;
  listAppeals(tenantId: string, status?: AppealRecord['status']): Promise<AppealRecord[]>;

  insertNotice(input: CreateNoticeInput): Promise<NoticeRecord>;
  getNotice(tenantId: string, id: string): Promise<NoticeRecord | null>;
  listNotices(
    tenantId: string,
    options?: { status?: NoticeStatus; reviewId?: string; limit?: number },
  ): Promise<NoticeRecord[]>;
  updateNoticeStatus(
    tenantId: string,
    id: string,
    input: NoticeStatusInput,
  ): Promise<NoticeRecord | null>;

  createJob(input: CreateJobInput): Promise<JobRecord>;
  getJob(tenantId: string, id: string): Promise<JobRecord | null>;
  listJobs(tenantId: string, limit?: number): Promise<JobRecord[]>;
  claimJob(): Promise<JobRecord | null>;
  completeJob(id: string, result?: Record<string, unknown>): Promise<void>;
  failJob(id: string, error: string, retryAfterMs?: number): Promise<void>;
  recoverStaleJobs(olderThanMs: number): Promise<number>;

  appendAudit(input: AuditInput): Promise<AuditRecord>;
  listAudit(tenantId: string, limit?: number): Promise<AuditRecord[]>;
  verifyAudit(tenantId: string): Promise<{
    valid: boolean;
    count: number;
    firstBrokenSeq: number | null;
  }>;

  incrementUsage(
    tenantId: string,
    metric: string,
    period: string,
    amount?: number,
  ): Promise<number>;
  getUsage(tenantId: string, metric: string, period: string): Promise<number>;
  listUsage(tenantId: string, period: string): Promise<UsageRecord[]>;

  upsertCampaign(record: CampaignRecord): Promise<void>;
  getCampaign(tenantId: string, id: string): Promise<CampaignRecord | null>;
  listCampaigns(tenantId: string, limit?: number): Promise<CampaignRecord[]>;
  getCampaignForReviewer(tenantId: string, reviewerId: string): Promise<CampaignRecord | null>;
  upsertReviewEdge(input: UpsertReviewEdgeInput): Promise<void>;
  listReviewEdges(
    tenantId: string,
    since: string,
    limit?: number,
  ): Promise<
    Array<{
      reviewerId: string;
      itemId: string;
      reviewId: string;
      submittedAt: string;
      risk: number;
      signals: string[];
    }>
  >;
  /** Recent reviews with their template hash and context (device/subnet) for
   * heterogeneous campaign edges. */
  listReviewGroupKeys(
    tenantId: string,
    since: string,
    limit?: number,
  ): Promise<ReviewGroupKeyRow[]>;
  /** Media rows since a point in time for shared-media campaign edges. */
  listRecentMedia(
    tenantId: string,
    since: string,
    limit?: number,
  ): Promise<
    Array<{ reviewId: string; reviewerId: string; sha256: string | null; submittedAt: string }>
  >;

  upsertRiskSnapshot(input: {
    tenantId: string;
    entityType: 'reviewer' | 'item';
    entityId: string;
    score: number;
    band: string;
    version: string;
  }): Promise<void>;
  getRiskSnapshot(
    tenantId: string,
    entityType: 'reviewer' | 'item',
    entityId: string,
  ): Promise<{ score: number; band: string; computedAt: string; version: string } | null>;

  purgeOlderThan(
    tenantId: string,
    before: string,
  ): Promise<{
    reviews: number;
    signals: number;
    media: number;
    textIndex: number;
  }>;
}

export interface TextIndexRecordLike {
  id: string;
  simhash: string;
  minhash: string;
  reviewId: string;
  reviewerId: string;
  itemId: string;
  submittedAt: string;
}
