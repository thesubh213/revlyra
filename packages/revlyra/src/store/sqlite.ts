import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { hammingDistanceHex, sha256Hex } from '@revlyra/core';
import { sqliteModule } from '../sqlite';
import type { Store } from './interface';
import { SQLITE_SCHEMA } from './schema';
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
  UpsertReviewInput,
  UpsertTextIndexInput,
  UsageRecord,
} from './types';

type Row = Record<string, any>;

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isoBefore(ms: number, from = Date.now()): string {
  return new Date(from - ms).toISOString();
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSyncType;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const sqlite = sqliteModule();
    // The timeout option is not available on every supported Node 22 release;
    // PRAGMA busy_timeout is applied by the schema instead.
    this.db = new sqlite.DatabaseSync(path);
  }

  async migrate(): Promise<void> {
    this.db.exec(SQLITE_SCHEMA);
    // Forward-only additive migration: older databases created before the
    // appeals SLA/handler columns get them via guarded ALTERs (SQLite has no
    // ADD COLUMN IF NOT EXISTS).
    const appealColumns = new Set(
      (this.all("SELECT name FROM pragma_table_info('appeals')") as Array<{ name: unknown }>).map(
        (row) => String(row.name),
      ),
    );
    if (!appealColumns.has('sla_due_at')) {
      this.db.exec('ALTER TABLE appeals ADD COLUMN sla_due_at TEXT;');
      this.db.exec('ALTER TABLE appeals ADD COLUMN handler_hmac TEXT;');
      this.db.exec('ALTER TABLE appeals ADD COLUMN outcome_note TEXT;');
    }
    this.db
      .prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run('001_init', nowIso());
    this.db
      .prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run('002_dsa_review_integrity', nowIso());
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private all(sql: string, ...params: any[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: any[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private run(
    sql: string,
    ...params: any[]
  ): { changes: number; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...params) as {
      changes: number;
      lastInsertRowid: number | bigint;
    };
  }

  async ensureTenant(id: string, name = id): Promise<TenantRecord> {
    this.run(
      'INSERT INTO tenants (id, name, policy_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      id,
      name,
      'balanced',
      nowIso(),
    );
    const row = this.get('SELECT * FROM tenants WHERE id = ?', id);
    return this.mapTenant(row!);
  }

  async getTenant(id: string): Promise<TenantRecord | null> {
    const row = this.get('SELECT * FROM tenants WHERE id = ?', id);
    return row ? this.mapTenant(row) : null;
  }

  async listTenants(): Promise<TenantRecord[]> {
    return this.all('SELECT * FROM tenants ORDER BY created_at').map((row) => this.mapTenant(row));
  }

  private mapTenant(row: Row): TenantRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      policyId: String(row.policy_id),
      createdAt: String(row.created_at),
    };
  }

  async createApiKey(input: CreateApiKeyInput): Promise<ApiKeyRecord> {
    const id = randomUUID();
    const createdAt = nowIso();
    this.run(
      `INSERT INTO api_keys (id, tenant_id, prefix, key_hash, scopes, rate_limit, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.tenantId,
      input.prefix,
      input.keyHash,
      JSON.stringify(input.scopes),
      input.rateLimit ?? null,
      createdAt,
      input.expiresAt ?? null,
    );
    const row = this.get('SELECT * FROM api_keys WHERE id = ?', id);
    return this.mapApiKey(row!);
  }

  async findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    const row = this.get('SELECT * FROM api_keys WHERE key_hash = ?', hash);
    return row ? this.mapApiKey(row) : null;
  }

  async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const row = this.get('SELECT * FROM api_keys WHERE prefix = ?', prefix);
    return row ? this.mapApiKey(row) : null;
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    return this.all(
      'SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC',
      tenantId,
    ).map((row) => this.mapApiKey(row));
  }

  async revokeApiKey(tenantId: string, id: string): Promise<boolean> {
    const result = this.run(
      'UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL',
      nowIso(),
      tenantId,
      id,
    );
    return result.changes > 0;
  }

  async touchApiKey(id: string): Promise<void> {
    this.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), id);
  }

  private mapApiKey(row: Row): ApiKeyRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      prefix: String(row.prefix),
      keyHash: String(row.key_hash),
      scopes: parseJson<string[]>(row.scopes, []),
      rateLimit: row.rate_limit === null ? null : Number(row.rate_limit),
      createdAt: String(row.created_at),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    };
  }

  async createSource(input: CreateSourceInput): Promise<SourceRecord> {
    const id = randomUUID();
    const now = nowIso();
    this.run(
      `INSERT INTO sources (id, tenant_id, kind, name, config, mapping, cursor, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.tenantId,
      input.kind,
      input.name,
      JSON.stringify(input.config),
      JSON.stringify(input.mapping),
      null,
      input.enabled === false ? 0 : 1,
      now,
      now,
    );
    return (await this.getSource(input.tenantId, id))!;
  }

  async getSource(tenantId: string, id: string): Promise<SourceRecord | null> {
    const row = this.get('SELECT * FROM sources WHERE tenant_id = ? AND id = ?', tenantId, id);
    return row ? this.mapSource(row) : null;
  }

  async listSources(tenantId: string): Promise<SourceRecord[]> {
    return this.all('SELECT * FROM sources WHERE tenant_id = ? ORDER BY created_at', tenantId).map(
      (row) => this.mapSource(row),
    );
  }

  async updateSourceCursor(
    tenantId: string,
    id: string,
    cursor: Record<string, unknown>,
  ): Promise<void> {
    this.run(
      'UPDATE sources SET cursor = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
      JSON.stringify(cursor),
      nowIso(),
      tenantId,
      id,
    );
  }

  async deleteSource(tenantId: string, id: string): Promise<boolean> {
    return this.run('DELETE FROM sources WHERE tenant_id = ? AND id = ?', tenantId, id).changes > 0;
  }

  private mapSource(row: Row): SourceRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      kind: String(row.kind),
      name: String(row.name),
      config: parseJson<Record<string, unknown>>(row.config, {}),
      mapping: parseJson<Record<string, unknown>>(row.mapping, {}),
      cursor: row.cursor ? parseJson<Record<string, unknown>>(row.cursor, {}) : null,
      enabled: Number(row.enabled) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async upsertReviewer(input: {
    tenantId: string;
    externalHmac: string;
    accountCreatedAt?: string | null;
    stats?: Record<string, unknown>;
    riskScore?: number;
    riskBand?: ReviewerRecord['riskBand'];
  }): Promise<ReviewerRecord> {
    const now = nowIso();
    this.run(
      `INSERT INTO reviewers (id, tenant_id, external_hmac, account_created_at, stats, risk_score, risk_band, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, external_hmac) DO UPDATE SET
         account_created_at = COALESCE(excluded.account_created_at, reviewers.account_created_at),
         stats = excluded.stats,
         risk_score = excluded.risk_score,
         risk_band = excluded.risk_band,
         last_seen = excluded.last_seen`,
      randomUUID(),
      input.tenantId,
      input.externalHmac,
      input.accountCreatedAt ?? null,
      JSON.stringify(input.stats ?? {}),
      input.riskScore ?? 0,
      input.riskBand ?? 'low',
      now,
      now,
    );
    return (await this.getReviewer(input.tenantId, input.externalHmac))!;
  }

  async getReviewer(tenantId: string, externalHmac: string): Promise<ReviewerRecord | null> {
    const row = this.get(
      'SELECT * FROM reviewers WHERE tenant_id = ? AND external_hmac = ?',
      tenantId,
      externalHmac,
    );
    return row ? this.mapReviewer(row) : null;
  }

  async getReviewerById(tenantId: string, id: string): Promise<ReviewerRecord | null> {
    const row = this.get('SELECT * FROM reviewers WHERE tenant_id = ? AND id = ?', tenantId, id);
    return row ? this.mapReviewer(row) : null;
  }

  private mapReviewer(row: Row): ReviewerRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      externalHmac: String(row.external_hmac),
      accountCreatedAt: row.account_created_at ? String(row.account_created_at) : null,
      stats: parseJson<Record<string, unknown>>(row.stats, {}),
      riskScore: Number(row.risk_score),
      riskBand: String(row.risk_band) as ReviewerRecord['riskBand'],
      firstSeen: String(row.first_seen),
      lastSeen: String(row.last_seen),
    };
  }

  async upsertItem(input: {
    tenantId: string;
    externalHmac: string;
    type?: string;
    category?: string | null;
    attributes?: Record<string, unknown>;
    stats?: Record<string, unknown>;
  }): Promise<ItemRecord> {
    this.run(
      `INSERT INTO items (id, tenant_id, external_hmac, type, category, attributes, stats, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, external_hmac) DO UPDATE SET
         type = excluded.type,
         category = COALESCE(excluded.category, items.category),
         attributes = excluded.attributes,
         stats = excluded.stats`,
      randomUUID(),
      input.tenantId,
      input.externalHmac,
      input.type ?? 'product',
      input.category ?? null,
      JSON.stringify(input.attributes ?? {}),
      JSON.stringify(input.stats ?? {}),
      nowIso(),
    );
    return (await this.getItem(input.tenantId, input.externalHmac))!;
  }

  async getItem(tenantId: string, externalHmac: string): Promise<ItemRecord | null> {
    const row = this.get(
      'SELECT * FROM items WHERE tenant_id = ? AND external_hmac = ?',
      tenantId,
      externalHmac,
    );
    return row ? this.mapItem(row) : null;
  }

  async getItemById(tenantId: string, id: string): Promise<ItemRecord | null> {
    const row = this.get('SELECT * FROM items WHERE tenant_id = ? AND id = ?', tenantId, id);
    return row ? this.mapItem(row) : null;
  }

  private mapItem(row: Row): ItemRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      externalHmac: String(row.external_hmac),
      type: String(row.type),
      category: row.category ? String(row.category) : null,
      attributes: parseJson<Record<string, unknown>>(row.attributes, {}),
      stats: parseJson<Record<string, unknown>>(row.stats, {}),
      createdAt: String(row.created_at),
    };
  }

  async upsertReview(input: UpsertReviewInput): Promise<ReviewRecord> {
    const now = nowIso();
    const sourceId = input.sourceId ?? 'api';
    const existing = this.get(
      'SELECT * FROM reviews WHERE tenant_id = ? AND source_id = ? AND external_hmac = ?',
      input.tenantId,
      sourceId,
      input.externalHmac,
    );
    if (existing) {
      this.run(
        `UPDATE reviews SET rating = ?, text = ?, text_sha256 = ?, simhash = ?, language = ?,
           submitted_at = ?, verified = ?, context = ?, media = ?, updated_at = ?, analysis_hash = ?
         WHERE id = ?`,
        input.rating,
        input.text,
        input.textSha256,
        input.simhash,
        input.language,
        input.submittedAt,
        input.verified ? 1 : 0,
        JSON.stringify(input.context),
        JSON.stringify(input.media),
        now,
        input.analysisHash ?? null,
        String(existing.id),
      );
      return (await this.getReview(input.tenantId, String(existing.id)))!;
    }

    const id = input.id ?? randomUUID();
    this.run(
      `INSERT INTO reviews (
        id, tenant_id, source_id, external_hmac, item_id, reviewer_id, rating, text, text_sha256,
        simhash, language, submitted_at, ingested_at, verified, context, media, status,
        analysis_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.tenantId,
      sourceId,
      input.externalHmac,
      input.itemId,
      input.reviewerId,
      input.rating,
      input.text,
      input.textSha256,
      input.simhash,
      input.language,
      input.submittedAt,
      now,
      input.verified ? 1 : 0,
      JSON.stringify(input.context),
      JSON.stringify(input.media),
      'pending',
      input.analysisHash ?? null,
      now,
      now,
    );
    return (await this.getReview(input.tenantId, id))!;
  }

  async getReview(tenantId: string, id: string): Promise<ReviewRecord | null> {
    const row = this.get('SELECT * FROM reviews WHERE tenant_id = ? AND id = ?', tenantId, id);
    return row ? this.mapReview(row) : null;
  }

  async findReviewByExternal(
    tenantId: string,
    sourceId: string,
    externalHmac: string,
  ): Promise<ReviewRecord | null> {
    const row = this.get(
      'SELECT * FROM reviews WHERE tenant_id = ? AND source_id = ? AND external_hmac = ?',
      tenantId,
      sourceId,
      externalHmac,
    );
    return row ? this.mapReview(row) : null;
  }

  async updateReviewAnalysis(
    tenantId: string,
    id: string,
    input: UpdateReviewAnalysisInput,
  ): Promise<void> {
    this.run(
      `UPDATE reviews SET score = ?, confidence = ?, decision = ?, band = ?, provisional = ?,
        model_version = ?, policy_version = ?, analysis_hash = ?, status = 'analyzed', updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
      input.score,
      input.confidence,
      input.decision,
      input.band,
      input.provisional ? 1 : 0,
      input.modelVersion,
      input.policyVersion,
      input.analysisHash,
      nowIso(),
      tenantId,
      id,
    );
  }

  async listItemReviews(tenantId: string, itemId: string, limit = 500): Promise<ReviewRecord[]> {
    return this.all(
      'SELECT * FROM reviews WHERE tenant_id = ? AND item_id = ? ORDER BY submitted_at DESC LIMIT ?',
      tenantId,
      itemId,
      limit,
    ).map((row) => this.mapReview(row));
  }

  async listReviewerReviews(
    tenantId: string,
    reviewerId: string,
    limit = 500,
  ): Promise<ReviewRecord[]> {
    return this.all(
      'SELECT * FROM reviews WHERE tenant_id = ? AND reviewer_id = ? ORDER BY submitted_at DESC LIMIT ?',
      tenantId,
      reviewerId,
      limit,
    ).map((row) => this.mapReview(row));
  }

  async listRecentReviews(tenantId: string, limit = 500): Promise<ReviewRecord[]> {
    return this.all(
      'SELECT * FROM reviews WHERE tenant_id = ? ORDER BY submitted_at DESC LIMIT ?',
      tenantId,
      limit,
    ).map((row) => this.mapReview(row));
  }

  private mapReview(row: Row): ReviewRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      sourceId: String(row.source_id),
      externalHmac: String(row.external_hmac),
      itemId: String(row.item_id),
      reviewerId: String(row.reviewer_id),
      rating: Number(row.rating),
      text: String(row.text),
      textSha256: String(row.text_sha256),
      simhash: String(row.simhash),
      language: String(row.language),
      submittedAt: String(row.submitted_at),
      ingestedAt: String(row.ingested_at),
      verified: Number(row.verified) === 1,
      context: parseJson<Record<string, unknown>>(row.context, {}),
      media: parseJson<Array<Record<string, unknown>>>(row.media, []),
      status: String(row.status),
      score: row.score === null ? null : Number(row.score),
      confidence: row.confidence === null ? null : Number(row.confidence),
      decision: row.decision ? (String(row.decision) as ReviewRecord['decision']) : null,
      band: row.band ? (String(row.band) as ReviewRecord['band']) : null,
      provisional: Number(row.provisional) === 1,
      analysisHash: row.analysis_hash ? String(row.analysis_hash) : null,
      modelVersion: row.model_version ? String(row.model_version) : null,
      policyVersion: row.policy_version ? String(row.policy_version) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async insertSignals(reviewId: string, signals: SignalRecord[]): Promise<void> {
    this.tx(() => {
      this.run('DELETE FROM review_signals WHERE review_id = ?', reviewId);
      for (const signal of signals) {
        this.run(
          `INSERT INTO review_signals (review_id, code, family, severity, confidence, contribution, evidence, explanation, hard)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          reviewId,
          signal.code,
          signal.family,
          signal.severity,
          signal.confidence,
          signal.contribution,
          JSON.stringify(signal.evidence),
          signal.explanation,
          signal.hard ? 1 : 0,
        );
      }
    });
  }

  async getSignals(reviewId: string): Promise<SignalRecord[]> {
    return this.all('SELECT * FROM review_signals WHERE review_id = ? ORDER BY id', reviewId).map(
      (row) => ({
        id: Number(row.id),
        reviewId: String(row.review_id),
        code: String(row.code),
        family: String(row.family) as SignalRecord['family'],
        severity: Number(row.severity),
        confidence: Number(row.confidence),
        contribution: Number(row.contribution),
        evidence: parseJson<Record<string, unknown>>(row.evidence, {}),
        explanation: String(row.explanation),
        hard: Number(row.hard) === 1,
      }),
    );
  }

  async upsertTextIndex(input: UpsertTextIndexInput): Promise<void> {
    this.tx(() => {
      const old = this.get(
        'SELECT id FROM text_index WHERE tenant_id = ? AND review_id = ?',
        input.tenantId,
        input.reviewId,
      );
      if (old) {
        this.run('DELETE FROM text_bands WHERE text_index_id = ?', String(old.id));
        this.run('DELETE FROM text_index WHERE id = ?', String(old.id));
      }
      const id = randomUUID();
      this.run(
        `INSERT INTO text_index (id, tenant_id, text_sha256, simhash, minhash, review_id, reviewer_id, item_id, submitted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.tenantId,
        input.textSha256,
        input.simhash,
        JSON.stringify(input.minhashBands.length > 0 ? input.minhashBands : []),
        input.reviewId,
        input.reviewerId,
        input.itemId,
        input.submittedAt,
        nowIso(),
      );
      for (const band of input.simhashBands) {
        this.run(
          'INSERT OR IGNORE INTO text_bands (tenant_id, kind, band_key, text_index_id) VALUES (?, ?, ?, ?)',
          input.tenantId,
          'sim',
          band,
          id,
        );
      }
      for (const band of input.minhashBands) {
        this.run(
          'INSERT OR IGNORE INTO text_bands (tenant_id, kind, band_key, text_index_id) VALUES (?, ?, ?, ?)',
          input.tenantId,
          'min',
          band,
          id,
        );
      }
    });
  }

  async findTextMatches(
    tenantId: string,
    input: {
      textSha256: string;
      simhash: string;
      simhashBands: string[];
      minhashBands: string[];
      excludeReviewId?: string;
      limit?: number;
    },
  ): Promise<TextMatchRow[]> {
    const limit = Math.min(50, Math.max(1, input.limit ?? 20));
    const exclude = input.excludeReviewId ?? '';
    const matches = new Map<string, TextMatchRow>();

    const exact = this.all(
      `SELECT * FROM text_index WHERE tenant_id = ? AND text_sha256 = ? AND review_id != ? LIMIT ?`,
      tenantId,
      input.textSha256,
      exclude,
      limit,
    );
    for (const row of exact) {
      matches.set(String(row.review_id), {
        reviewId: String(row.review_id),
        reviewerId: String(row.reviewer_id),
        itemId: String(row.item_id),
        submittedAt: row.submitted_at ? String(row.submitted_at) : null,
        similarity: 1,
        kind: 'exact',
      });
    }

    const bandKeys = [...input.simhashBands, ...input.minhashBands];
    if (bandKeys.length > 0) {
      const placeholders = bandKeys.map(() => '?').join(',');
      const candidates = this.all(
        `SELECT DISTINCT ti.* FROM text_bands tb
         JOIN text_index ti ON ti.id = tb.text_index_id
         WHERE tb.tenant_id = ? AND tb.band_key IN (${placeholders})
           AND ti.review_id != ?
         LIMIT 500`,
        tenantId,
        ...bandKeys,
        exclude,
      );
      for (const row of candidates) {
        const reviewId = String(row.review_id);
        const simhashSimilarity = 1 - hammingDistanceHex(String(row.simhash), input.simhash) / 64;
        const storedMinhash = parseJson<string[]>(row.minhash, []);
        const minhashSimilarity =
          storedMinhash.length > 0 ? minhashJaccardFromBands(storedMinhash, input.minhashBands) : 0;
        const similarity = Math.max(simhashSimilarity, minhashSimilarity);
        if (similarity < 0.78) continue;
        const existing = matches.get(reviewId);
        if (!existing || similarity > existing.similarity) {
          matches.set(reviewId, {
            reviewId,
            reviewerId: String(row.reviewer_id),
            itemId: String(row.item_id),
            submittedAt: row.submitted_at ? String(row.submitted_at) : null,
            similarity: Number(similarity.toFixed(4)),
            kind: 'near',
          });
        }
      }
    }

    return Array.from(matches.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async getTextIndex(tenantId: string, reviewId: string) {
    const row = this.get(
      'SELECT * FROM text_index WHERE tenant_id = ? AND review_id = ?',
      tenantId,
      reviewId,
    );
    if (!row) return null;
    return {
      id: String(row.id),
      simhash: String(row.simhash),
      minhash: String(row.minhash),
      reviewId: String(row.review_id),
      reviewerId: String(row.reviewer_id),
      itemId: String(row.item_id),
      submittedAt: String(row.submitted_at),
    };
  }

  async upsertMedia(input: UpsertMediaInput): Promise<void> {
    this.tx(() => {
      const existing = this.get(
        `SELECT id FROM media WHERE tenant_id = ? AND review_id = ?
         AND ((${input.sha256 ? 'sha256 = ?' : '1=0'}) OR (${input.urlHmac ? 'url_hmac = ?' : '1=0'}))
         LIMIT 1`,
        tenantIdInput(input),
        input.reviewId,
        ...(input.sha256 ? [input.sha256] : []),
        ...(input.urlHmac ? [input.urlHmac] : []),
      );
      if (existing) {
        this.run('DELETE FROM media_bands WHERE media_id = ?', String(existing.id));
        this.run('DELETE FROM media WHERE id = ?', String(existing.id));
      }
      const id = randomUUID();
      this.run(
        `INSERT INTO media (id, tenant_id, review_id, reviewer_id, item_id, sha256, dhash, phash, width, height, mime, exif, url_hmac, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.tenantId,
        input.reviewId,
        input.reviewerId,
        input.itemId,
        input.sha256 ?? null,
        input.dhash ?? null,
        input.phash ?? null,
        input.width ?? null,
        input.height ?? null,
        input.mime ?? null,
        JSON.stringify(input.exif ?? {}),
        input.urlHmac ?? null,
        nowIso(),
      );
      for (const band of input.phashBands ?? []) {
        this.run(
          'INSERT OR IGNORE INTO media_bands (tenant_id, kind, band_key, media_id) VALUES (?, ?, ?, ?)',
          input.tenantId,
          'phash',
          band,
          id,
        );
      }
    });
  }

  async findMediaMatches(
    tenantId: string,
    input: {
      sha256?: string | null;
      phash?: string | null;
      phashBands?: string[];
      excludeReviewId?: string;
      limit?: number;
    },
  ): Promise<MediaMatchRow[]> {
    const limit = Math.min(50, Math.max(1, input.limit ?? 20));
    const exclude = input.excludeReviewId ?? '';
    const matches = new Map<string, MediaMatchRow>();

    if (input.sha256) {
      const exact = this.all(
        'SELECT * FROM media WHERE tenant_id = ? AND sha256 = ? AND review_id != ? LIMIT ?',
        tenantId,
        input.sha256,
        exclude,
        limit,
      );
      for (const row of exact) {
        matches.set(String(row.review_id), {
          reviewId: String(row.review_id),
          reviewerId: String(row.reviewer_id),
          itemId: String(row.item_id),
          kind: 'exact',
          distance: 0,
        });
      }
    }

    if (input.phash && input.phashBands && input.phashBands.length > 0) {
      const placeholders = input.phashBands.map(() => '?').join(',');
      const candidates = this.all(
        `SELECT DISTINCT m.* FROM media_bands mb
         JOIN media m ON m.id = mb.media_id
         WHERE mb.tenant_id = ? AND mb.kind = 'phash' AND mb.band_key IN (${placeholders})
           AND m.review_id != ?
         LIMIT 500`,
        tenantId,
        ...input.phashBands,
        exclude,
      );
      for (const row of candidates) {
        const distance = hammingDistanceHex(String(row.phash), input.phash);
        if (distance > 12) continue;
        const reviewId = String(row.review_id);
        const existing = matches.get(reviewId);
        if (!existing || distance < existing.distance) {
          matches.set(reviewId, {
            reviewId,
            reviewerId: String(row.reviewer_id),
            itemId: String(row.item_id),
            kind: 'near',
            distance,
          });
        }
      }
    }

    return Array.from(matches.values())
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  async listMedia(tenantId: string, reviewId: string): Promise<MediaRecord[]> {
    return this.all(
      'SELECT * FROM media WHERE tenant_id = ? AND review_id = ? ORDER BY created_at',
      tenantId,
      reviewId,
    ).map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      reviewId: String(row.review_id),
      reviewerId: String(row.reviewer_id),
      itemId: String(row.item_id),
      sha256: row.sha256 ? String(row.sha256) : null,
      dhash: row.dhash ? String(row.dhash) : null,
      phash: row.phash ? String(row.phash) : null,
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      mime: row.mime ? String(row.mime) : null,
      exif: parseJson<Record<string, unknown>>(row.exif, {}),
      urlHmac: row.url_hmac ? String(row.url_hmac) : null,
      createdAt: String(row.created_at),
    }));
  }

  async getReviewerAggregates(tenantId: string, reviewerId: string): Promise<ReviewerAggregates> {
    const counts = this.get(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN submitted_at >= ? THEN 1 ELSE 0 END) AS d1,
        SUM(CASE WHEN submitted_at >= ? THEN 1 ELSE 0 END) AS d7,
        SUM(CASE WHEN submitted_at >= ? THEN 1 ELSE 0 END) AS d30,
        SUM(rating) AS rating_sum,
        MIN(submitted_at) AS first_at,
        MAX(submitted_at) AS last_at
       FROM reviews WHERE tenant_id = ? AND reviewer_id = ?`,
      isoBefore(86_400_000),
      isoBefore(7 * 86_400_000),
      isoBefore(30 * 86_400_000),
      tenantId,
      reviewerId,
    );
    const distributionRows = this.all(
      `SELECT CAST(ROUND(rating) AS INTEGER) AS bucket, COUNT(*) AS count
       FROM reviews WHERE tenant_id = ? AND reviewer_id = ? GROUP BY bucket`,
      tenantId,
      reviewerId,
    );
    const distribution = [0, 0, 0, 0, 0];
    for (const row of distributionRows) {
      const bucket = Number(row.bucket);
      if (bucket >= 1 && bucket <= 5) distribution[bucket - 1] = Number(row.count);
    }
    const total = Number(counts?.total ?? 0);
    const ratingSum = Number(counts?.rating_sum ?? 0);
    const averageRating = total > 0 ? ratingSum / total : null;
    let variance = 0;
    if (total > 0) {
      for (let i = 0; i < 5; i += 1) {
        const rating = i + 1;
        variance += distribution[i]! * (rating - averageRating!) ** 2;
      }
      variance /= total;
    }
    const recent = this.all(
      'SELECT submitted_at FROM reviews WHERE tenant_id = ? AND reviewer_id = ? ORDER BY submitted_at DESC LIMIT 100',
      tenantId,
      reviewerId,
    ).map((row) => String(row.submitted_at));

    const intervals: number[] = [];
    for (let i = 1; i < recent.length; i += 1) {
      const diff = (new Date(recent[i - 1]!).getTime() - new Date(recent[i]!).getTime()) / 1000;
      if (Number.isFinite(diff) && diff >= 0) intervals.push(diff);
    }

    return {
      totalReviews: total,
      reviewsLast24h: Number(counts?.d1 ?? 0),
      reviewsLast7d: Number(counts?.d7 ?? 0),
      reviewsLast30d: Number(counts?.d30 ?? 0),
      averageRating,
      ratingStdDev: total > 0 ? Math.sqrt(variance) : null,
      ratingDistribution: distribution,
      fiveStarRatio: total > 0 ? distribution[4]! / total : null,
      firstReviewAt: counts?.first_at ? String(counts.first_at) : null,
      lastReviewAt: counts?.last_at ? String(counts.last_at) : null,
      recentTimestamps: recent,
      recentIntervalsSeconds: intervals,
    };
  }

  async getItemAggregates(tenantId: string, itemId: string): Promise<ItemAggregates> {
    const counts = this.get(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN submitted_at >= ? THEN 1 ELSE 0 END) AS d1,
        SUM(CASE WHEN submitted_at >= ? THEN 1 ELSE 0 END) AS d7,
        SUM(rating) AS rating_sum
       FROM reviews WHERE tenant_id = ? AND item_id = ?`,
      isoBefore(86_400_000),
      isoBefore(7 * 86_400_000),
      tenantId,
      itemId,
    );
    const distributionRows = this.all(
      `SELECT CAST(ROUND(rating) AS INTEGER) AS bucket, COUNT(*) AS count
       FROM reviews WHERE tenant_id = ? AND item_id = ? GROUP BY bucket`,
      tenantId,
      itemId,
    );
    const distribution = [0, 0, 0, 0, 0];
    for (const row of distributionRows) {
      const bucket = Number(row.bucket);
      if (bucket >= 1 && bucket <= 5) distribution[bucket - 1] = Number(row.count);
    }
    const total = Number(counts?.total ?? 0);
    const averageRating = total > 0 ? Number(counts?.rating_sum ?? 0) / total : null;
    let variance = 0;
    if (total > 0) {
      for (let i = 0; i < 5; i += 1) {
        const rating = i + 1;
        variance += distribution[i]! * (rating - averageRating!) ** 2;
      }
      variance /= total;
    }
    return {
      totalReviews: total,
      averageRating,
      ratingStdDev: total > 0 ? Math.sqrt(variance) : null,
      ratingDistribution: distribution,
      recentReviews24h: Number(counts?.d1 ?? 0),
      recentReviews7d: Number(counts?.d7 ?? 0),
    };
  }

  async getCorpusStats(tenantId: string): Promise<CorpusStatsRow> {
    const row = this.get('SELECT COUNT(*) AS total FROM reviews WHERE tenant_id = ?', tenantId);
    return { totalReviews: Number(row?.total ?? 0) };
  }

  async decisionCounts(
    tenantId: string,
    since: string,
  ): Promise<Array<{ decision: string; count: number }>> {
    return this.all(
      `SELECT decision, COUNT(*) AS count FROM reviews
       WHERE tenant_id = ? AND submitted_at >= ? AND decision IS NOT NULL
       GROUP BY decision ORDER BY count DESC`,
      tenantId,
      since,
    ).map((row) => ({ decision: String(row.decision), count: Number(row.count) }));
  }

  async signalCodeCounts(
    tenantId: string,
    since: string,
    limit = 50,
  ): Promise<Array<{ code: string; family: string; count: number }>> {
    return this.all(
      `SELECT s.code AS code, s.family AS family, COUNT(*) AS count
       FROM review_signals s JOIN reviews r ON r.id = s.review_id
       WHERE r.tenant_id = ? AND r.submitted_at >= ?
       GROUP BY s.code, s.family ORDER BY count DESC LIMIT ?`,
      tenantId,
      since,
      limit,
    ).map((row) => ({
      code: String(row.code),
      family: String(row.family),
      count: Number(row.count),
    }));
  }

  async insertFeedback(input: {
    tenantId: string;
    reviewId: string;
    label: string;
    reasonCode: string;
    notes?: string | null;
    actorHmac?: string | null;
  }): Promise<FeedbackRecord> {
    const id = randomUUID();
    const createdAt = nowIso();
    this.run(
      `INSERT INTO feedback (id, tenant_id, review_id, label, reason_code, notes, actor_hmac, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.tenantId,
      input.reviewId,
      input.label,
      input.reasonCode,
      input.notes ?? null,
      input.actorHmac ?? null,
      createdAt,
    );
    return {
      id,
      tenantId: input.tenantId,
      reviewId: input.reviewId,
      label: input.label,
      reasonCode: input.reasonCode,
      notes: input.notes ?? null,
      actorHmac: input.actorHmac ?? null,
      createdAt,
    };
  }

  async listFeedback(tenantId: string, reviewId?: string, limit = 100): Promise<FeedbackRecord[]> {
    const rows = reviewId
      ? this.all(
          'SELECT * FROM feedback WHERE tenant_id = ? AND review_id = ? ORDER BY created_at DESC LIMIT ?',
          tenantId,
          reviewId,
          limit,
        )
      : this.all(
          'SELECT * FROM feedback WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
          tenantId,
          limit,
        );
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      reviewId: String(row.review_id),
      label: String(row.label),
      reasonCode: String(row.reason_code),
      notes: row.notes ? String(row.notes) : null,
      actorHmac: row.actor_hmac ? String(row.actor_hmac) : null,
      createdAt: String(row.created_at),
    }));
  }

  async createAppeal(input: {
    tenantId: string;
    reviewId: string;
    reason?: string | null;
    slaDueAt?: string | null;
  }): Promise<AppealRecord> {
    const id = randomUUID();
    const createdAt = nowIso();
    this.run(
      'INSERT INTO appeals (id, tenant_id, review_id, status, reason, created_at, sla_due_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      input.tenantId,
      input.reviewId,
      'open',
      input.reason ?? null,
      createdAt,
      input.slaDueAt ?? null,
    );
    return {
      id,
      tenantId: input.tenantId,
      reviewId: input.reviewId,
      status: 'open',
      reason: input.reason ?? null,
      createdAt,
      slaDueAt: input.slaDueAt ?? null,
      resolvedAt: null,
      handlerHmac: null,
      outcomeNote: null,
    };
  }

  async resolveAppeal(
    tenantId: string,
    id: string,
    status: 'upheld' | 'overturned',
    handlerHmac?: string | null,
    outcomeNote?: string | null,
  ): Promise<AppealRecord | null> {
    this.run(
      'UPDATE appeals SET status = ?, resolved_at = ?, handler_hmac = ?, outcome_note = ? WHERE tenant_id = ? AND id = ?',
      status,
      nowIso(),
      handlerHmac ?? null,
      outcomeNote ?? null,
      tenantId,
      id,
    );
    const row = this.get('SELECT * FROM appeals WHERE tenant_id = ? AND id = ?', tenantId, id);
    return row ? this.mapAppeal(row) : null;
  }

  async listAppeals(tenantId: string, status?: AppealRecord['status']): Promise<AppealRecord[]> {
    const rows = status
      ? this.all(
          'SELECT * FROM appeals WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC',
          tenantId,
          status,
        )
      : this.all('SELECT * FROM appeals WHERE tenant_id = ? ORDER BY created_at DESC', tenantId);
    return rows.map((row) => this.mapAppeal(row));
  }

  async insertNotice(input: CreateNoticeInput): Promise<NoticeRecord> {
    const record: NoticeRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      reviewId: input.reviewId,
      type: input.type,
      claim: input.claim,
      substantiated: input.substantiated ?? false,
      status: 'received',
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
      resolvedAt: null,
    };
    this.run(
      'INSERT INTO notices (id, tenant_id, review_id, type, claim, substantiated, status, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      record.id,
      record.tenantId,
      record.reviewId,
      record.type,
      record.claim,
      record.substantiated ? 1 : 0,
      record.status,
      JSON.stringify(record.metadata),
      record.createdAt,
    );
    return record;
  }

  async getNotice(tenantId: string, id: string): Promise<NoticeRecord | null> {
    const row = this.get('SELECT * FROM notices WHERE tenant_id = ? AND id = ?', tenantId, id);
    return row ? this.mapNotice(row) : null;
  }

  async listNotices(
    tenantId: string,
    options?: { status?: NoticeStatus; reviewId?: string; limit?: number },
  ): Promise<NoticeRecord[]> {
    const clauses = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (options?.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options?.reviewId) {
      clauses.push('review_id = ?');
      params.push(options.reviewId);
    }
    params.push(Math.max(1, options?.limit ?? 100));
    const rows = this.all(
      `SELECT * FROM notices WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      ...params,
    );
    return rows.map((row) => this.mapNotice(row));
  }

  async updateNoticeStatus(
    tenantId: string,
    id: string,
    input: { status: NoticeStatus; note?: string },
  ): Promise<NoticeRecord | null> {
    const existing = this.get(
      'SELECT metadata FROM notices WHERE tenant_id = ? AND id = ?',
      tenantId,
      id,
    );
    const metadata = existing ? parseJson<Record<string, unknown>>(existing.metadata, {}) : {};
    if (input.note !== undefined) metadata.statusNote = input.note;
    this.run(
      'UPDATE notices SET status = ?, resolved_at = ?, metadata = ? WHERE tenant_id = ? AND id = ?',
      input.status,
      ['actioned', 'rejected', 'expired'].includes(input.status) ? nowIso() : null,
      JSON.stringify(metadata),
      tenantId,
      id,
    );
    const row = this.get('SELECT * FROM notices WHERE tenant_id = ? AND id = ?', tenantId, id);
    return row ? this.mapNotice(row) : null;
  }

  async listReviewGroupKeys(
    tenantId: string,
    since: string,
    limit = 20_000,
  ): Promise<ReviewGroupKeyRow[]> {
    return this.all(
      'SELECT id, reviewer_id, text_sha256, context, submitted_at FROM reviews WHERE tenant_id = ? AND submitted_at >= ? ORDER BY submitted_at DESC LIMIT ?',
      tenantId,
      since,
      limit,
    ).map((row) => ({
      reviewId: String(row.id),
      reviewerId: String(row.reviewer_id),
      textSha256: String(row.text_sha256),
      context: parseJson<Record<string, unknown>>(row.context, {}),
      submittedAt: String(row.submitted_at),
    }));
  }

  async listRecentMedia(
    tenantId: string,
    since: string,
    limit = 20_000,
  ): Promise<
    Array<{ reviewId: string; reviewerId: string; sha256: string | null; submittedAt: string }>
  > {
    return this.all(
      `SELECT m.review_id, m.reviewer_id, m.sha256, r.submitted_at
       FROM media m JOIN reviews r ON r.tenant_id = m.tenant_id AND r.id = m.review_id
       WHERE m.tenant_id = ? AND m.sha256 IS NOT NULL AND r.submitted_at >= ?
       ORDER BY r.submitted_at DESC LIMIT ?`,
      tenantId,
      since,
      limit,
    ).map((row) => ({
      reviewId: String(row.review_id),
      reviewerId: String(row.reviewer_id),
      sha256: row.sha256 === null ? null : String(row.sha256),
      submittedAt: String(row.submitted_at),
    }));
  }

  private mapAppeal(row: Row): AppealRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      reviewId: String(row.review_id),
      status: String(row.status) as AppealRecord['status'],
      reason: row.reason ? String(row.reason) : null,
      createdAt: String(row.created_at),
      slaDueAt: row.sla_due_at ? String(row.sla_due_at) : null,
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      handlerHmac:
        row.handler_hmac !== undefined && row.handler_hmac !== null
          ? String(row.handler_hmac)
          : row.resolver_hmac
            ? String(row.resolver_hmac)
            : null,
      outcomeNote: row.outcome_note ? String(row.outcome_note) : null,
    };
  }

  private mapNotice(row: Row): NoticeRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      reviewId: String(row.review_id),
      type: String(row.type) as NoticeRecord['type'],
      claim: String(row.claim),
      substantiated: Number(row.substantiated) === 1,
      status: String(row.status) as NoticeRecord['status'],
      metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    };
  }

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    const id = randomUUID();
    const now = nowIso();
    this.run(
      `INSERT INTO jobs (id, tenant_id, kind, status, payload, attempts, max_attempts, run_after, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)`,
      id,
      input.tenantId,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.maxAttempts ?? 3,
      input.runAfter ?? now,
      now,
      now,
    );
    return (await this.getJob(input.tenantId, id))!;
  }

  async getJob(tenantId: string, id: string): Promise<JobRecord | null> {
    const row = this.get('SELECT * FROM jobs WHERE tenant_id = ? AND id = ?', tenantId, id);
    return row ? this.mapJob(row) : null;
  }

  async listJobs(tenantId: string, limit = 100): Promise<JobRecord[]> {
    return this.all(
      'SELECT * FROM jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
      tenantId,
      limit,
    ).map((row) => this.mapJob(row));
  }

  async claimJob(): Promise<JobRecord | null> {
    const now = nowIso();
    const row = this.get(
      `UPDATE jobs SET status = 'running', claimed_at = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = (
         SELECT id FROM jobs WHERE status = 'pending' AND run_after <= ?
         ORDER BY created_at ASC LIMIT 1
       )
       RETURNING *`,
      now,
      now,
      now,
    );
    return row ? this.mapJob(row) : null;
  }

  async completeJob(id: string, result: Record<string, unknown> = {}): Promise<void> {
    this.run(
      "UPDATE jobs SET status = 'completed', result = ?, error = NULL, updated_at = ? WHERE id = ?",
      JSON.stringify(result),
      nowIso(),
      id,
    );
  }

  async failJob(id: string, error: string, retryAfterMs = 0): Promise<void> {
    const row = this.get('SELECT * FROM jobs WHERE id = ?', id);
    if (!row) return;
    const attempts = Number(row.attempts);
    const maxAttempts = Number(row.max_attempts);
    const dead = attempts >= maxAttempts;
    this.run(
      'UPDATE jobs SET status = ?, error = ?, run_after = ?, updated_at = ? WHERE id = ?',
      dead ? 'dead' : 'pending',
      error.slice(0, 2000),
      new Date(Date.now() + retryAfterMs).toISOString(),
      nowIso(),
      id,
    );
  }

  async recoverStaleJobs(olderThanMs: number): Promise<number> {
    const result = this.run(
      `UPDATE jobs SET status = 'pending', claimed_at = NULL, updated_at = ?
       WHERE status = 'running' AND claimed_at < ?`,
      nowIso(),
      new Date(Date.now() - olderThanMs).toISOString(),
    );
    return result.changes;
  }

  private mapJob(row: Row): JobRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      kind: String(row.kind),
      status: String(row.status) as JobRecord['status'],
      payload: parseJson<Record<string, unknown>>(row.payload, {}),
      result: row.result ? parseJson<Record<string, unknown>>(row.result, {}) : null,
      error: row.error ? String(row.error) : null,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      runAfter: String(row.run_after),
      claimedAt: row.claimed_at ? String(row.claimed_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async appendAudit(input: AuditInput): Promise<AuditRecord> {
    const last = this.get(
      'SELECT hash FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1',
      input.tenantId,
    );
    const prevHash = last ? String(last.hash) : '';
    const createdAt = nowIso();
    const payload = input.payload ?? {};
    const canonical = JSON.stringify({
      tenantId: input.tenantId,
      actor: input.actor,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      payload,
      createdAt,
    });
    const hash = sha256Hex(`${prevHash}${canonical}`);
    this.run(
      `INSERT INTO audit_log (tenant_id, actor, action, target_type, target_id, payload, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.tenantId,
      input.actor,
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(payload),
      prevHash,
      hash,
      createdAt,
    );
    const row = this.get(
      'SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1',
      input.tenantId,
    )!;
    return this.mapAudit(row);
  }

  async listAudit(tenantId: string, limit = 500): Promise<AuditRecord[]> {
    return this.all(
      'SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?',
      tenantId,
      limit,
    ).map((row) => this.mapAudit(row));
  }

  async verifyAudit(tenantId: string): Promise<{
    valid: boolean;
    count: number;
    firstBrokenSeq: number | null;
  }> {
    const rows = this.all('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq ASC', tenantId);
    let prevHash = '';
    for (const row of rows) {
      const payload = parseJson<Record<string, unknown>>(row.payload, {});
      const canonical = JSON.stringify({
        tenantId: String(row.tenant_id),
        actor: String(row.actor),
        action: String(row.action),
        targetType: String(row.target_type),
        targetId: String(row.target_id),
        payload,
        createdAt: String(row.created_at),
      });
      const expected = sha256Hex(`${prevHash}${canonical}`);
      if (expected !== String(row.hash) || prevHash !== String(row.prev_hash)) {
        return { valid: false, count: rows.length, firstBrokenSeq: Number(row.seq) };
      }
      prevHash = String(row.hash);
    }
    return { valid: true, count: rows.length, firstBrokenSeq: null };
  }

  private mapAudit(row: Row): AuditRecord {
    return {
      seq: Number(row.seq),
      tenantId: String(row.tenant_id),
      actor: String(row.actor),
      action: String(row.action),
      targetType: String(row.target_type),
      targetId: String(row.target_id),
      payload: parseJson<Record<string, unknown>>(row.payload, {}),
      prevHash: String(row.prev_hash),
      hash: String(row.hash),
      createdAt: String(row.created_at),
    };
  }

  async incrementUsage(
    tenantId: string,
    metric: string,
    period: string,
    amount = 1,
  ): Promise<number> {
    const row = this.get(
      `INSERT INTO usage_counters (tenant_id, metric, period, value) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, metric, period) DO UPDATE SET value = usage_counters.value + excluded.value
       RETURNING value`,
      tenantId,
      metric,
      period,
      amount,
    );
    return Number(row?.value ?? 0);
  }

  async getUsage(tenantId: string, metric: string, period: string): Promise<number> {
    const row = this.get(
      'SELECT value FROM usage_counters WHERE tenant_id = ? AND metric = ? AND period = ?',
      tenantId,
      metric,
      period,
    );
    return Number(row?.value ?? 0);
  }

  async listUsage(tenantId: string, period: string): Promise<UsageRecord[]> {
    return this.all(
      'SELECT metric, period, value FROM usage_counters WHERE tenant_id = ? AND period = ?',
      tenantId,
      period,
    ).map((row) => ({
      metric: String(row.metric),
      period: String(row.period),
      value: Number(row.value),
    }));
  }

  async upsertCampaign(record: CampaignRecord): Promise<void> {
    this.tx(() => {
      this.run(
        `INSERT INTO campaigns (id, tenant_id, kind, score, density, member_count, reviewer_ids, item_ids, evidence, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           score = excluded.score,
           density = excluded.density,
           member_count = excluded.member_count,
           reviewer_ids = excluded.reviewer_ids,
           item_ids = excluded.item_ids,
           evidence = excluded.evidence,
           status = excluded.status,
           updated_at = excluded.updated_at`,
        record.id,
        record.tenantId,
        record.kind,
        record.score,
        record.density,
        record.memberCount,
        JSON.stringify(record.reviewerIds),
        JSON.stringify(record.itemIds),
        JSON.stringify(record.evidence),
        record.status,
        record.createdAt,
        record.updatedAt,
      );
      this.run(
        'DELETE FROM campaign_members WHERE tenant_id = ? AND campaign_id = ?',
        record.tenantId,
        record.id,
      );
      for (const reviewerId of record.reviewerIds) {
        this.run(
          'INSERT OR IGNORE INTO campaign_members (tenant_id, campaign_id, reviewer_id) VALUES (?, ?, ?)',
          record.tenantId,
          record.id,
          reviewerId,
        );
      }
    });
  }

  async getCampaign(tenantId: string, id: string): Promise<CampaignRecord | null> {
    const row = this.get('SELECT * FROM campaigns WHERE tenant_id = ? AND id = ?', tenantId, id);
    return row ? this.mapCampaign(row) : null;
  }

  async listCampaigns(tenantId: string, limit = 100): Promise<CampaignRecord[]> {
    return this.all(
      'SELECT * FROM campaigns WHERE tenant_id = ? ORDER BY score DESC LIMIT ?',
      tenantId,
      limit,
    ).map((row) => this.mapCampaign(row));
  }

  async getCampaignForReviewer(
    tenantId: string,
    reviewerId: string,
  ): Promise<CampaignRecord | null> {
    const row = this.get(
      `SELECT c.* FROM campaigns c
       JOIN campaign_members cm ON cm.campaign_id = c.id AND cm.tenant_id = c.tenant_id
       WHERE c.tenant_id = ? AND cm.reviewer_id = ?
       ORDER BY c.score DESC LIMIT 1`,
      tenantId,
      reviewerId,
    );
    return row ? this.mapCampaign(row) : null;
  }

  private mapCampaign(row: Row): CampaignRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      kind: String(row.kind),
      score: Number(row.score),
      density: Number(row.density),
      memberCount: Number(row.member_count),
      reviewerIds: parseJson<string[]>(row.reviewer_ids, []),
      itemIds: parseJson<string[]>(row.item_ids, []),
      evidence: parseJson<Record<string, unknown>>(row.evidence, {}),
      status: String(row.status) as CampaignRecord['status'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async upsertReviewEdge(input: {
    tenantId: string;
    reviewerId: string;
    itemId: string;
    reviewId: string;
    submittedAt: string;
    risk: number;
    signals: string[];
  }): Promise<void> {
    this.run(
      `INSERT INTO reviewer_item_edges (tenant_id, reviewer_id, item_id, review_id, submitted_at, risk, signals)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, review_id) DO UPDATE SET
         reviewer_id = excluded.reviewer_id, item_id = excluded.item_id,
         submitted_at = excluded.submitted_at, risk = excluded.risk, signals = excluded.signals`,
      input.tenantId,
      input.reviewerId,
      input.itemId,
      input.reviewId,
      input.submittedAt,
      input.risk,
      JSON.stringify(input.signals),
    );
  }

  async listReviewEdges(
    tenantId: string,
    since: string,
    limit = 100_000,
  ): Promise<
    Array<{
      reviewerId: string;
      itemId: string;
      reviewId: string;
      submittedAt: string;
      risk: number;
      signals: string[];
    }>
  > {
    return this.all(
      `SELECT * FROM reviewer_item_edges WHERE tenant_id = ? AND submitted_at >= ?
       ORDER BY submitted_at DESC LIMIT ?`,
      tenantId,
      since,
      limit,
    ).map((row) => ({
      reviewerId: String(row.reviewer_id),
      itemId: String(row.item_id),
      reviewId: String(row.review_id),
      submittedAt: String(row.submitted_at),
      risk: Number(row.risk),
      signals: parseJson<string[]>(row.signals, []),
    }));
  }

  async upsertRiskSnapshot(input: {
    tenantId: string;
    entityType: 'reviewer' | 'item';
    entityId: string;
    score: number;
    band: string;
    version: string;
  }): Promise<void> {
    this.run(
      `INSERT INTO risk_snapshots (tenant_id, entity_type, entity_id, score, band, computed_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, entity_type, entity_id) DO UPDATE SET
         score = excluded.score, band = excluded.band, computed_at = excluded.computed_at, version = excluded.version`,
      input.tenantId,
      input.entityType,
      input.entityId,
      input.score,
      input.band,
      nowIso(),
      input.version,
    );
  }

  async getRiskSnapshot(
    tenantId: string,
    entityType: 'reviewer' | 'item',
    entityId: string,
  ): Promise<{ score: number; band: string; computedAt: string; version: string } | null> {
    const row = this.get(
      'SELECT * FROM risk_snapshots WHERE tenant_id = ? AND entity_type = ? AND entity_id = ?',
      tenantId,
      entityType,
      entityId,
    );
    return row
      ? {
          score: Number(row.score),
          band: String(row.band),
          computedAt: String(row.computed_at),
          version: String(row.version),
        }
      : null;
  }

  async purgeOlderThan(
    tenantId: string,
    before: string,
  ): Promise<{ reviews: number; signals: number; media: number; textIndex: number }> {
    return this.tx(() => {
      const reviewIds = this.all(
        'SELECT id FROM reviews WHERE tenant_id = ? AND submitted_at < ?',
        tenantId,
        before,
      ).map((row) => String(row.id));
      if (reviewIds.length === 0) {
        return { reviews: 0, signals: 0, media: 0, textIndex: 0 };
      }
      const placeholders = reviewIds.map(() => '?').join(',');
      const signalCount = this.get(
        `SELECT COUNT(*) AS total FROM review_signals WHERE review_id IN (${placeholders})`,
        ...reviewIds,
      );
      const mediaIds = this.all(
        `SELECT id FROM media WHERE review_id IN (${placeholders})`,
        ...reviewIds,
      ).map((row) => String(row.id));
      let mediaCount = 0;
      if (mediaIds.length > 0) {
        const mediaPlaceholders = mediaIds.map(() => '?').join(',');
        this.run(`DELETE FROM media_bands WHERE media_id IN (${mediaPlaceholders})`, ...mediaIds);
        mediaCount = this.run(
          `DELETE FROM media WHERE id IN (${mediaPlaceholders})`,
          ...mediaIds,
        ).changes;
      }
      const textIds = this.all(
        `SELECT id FROM text_index WHERE review_id IN (${placeholders})`,
        ...reviewIds,
      ).map((row) => String(row.id));
      let textCount = 0;
      if (textIds.length > 0) {
        const textPlaceholders = textIds.map(() => '?').join(',');
        this.run(`DELETE FROM text_bands WHERE text_index_id IN (${textPlaceholders})`, ...textIds);
        textCount = this.run(
          `DELETE FROM text_index WHERE id IN (${textPlaceholders})`,
          ...textIds,
        ).changes;
      }
      this.run(`DELETE FROM review_signals WHERE review_id IN (${placeholders})`, ...reviewIds);
      this.run(
        `DELETE FROM reviewer_item_edges WHERE review_id IN (${placeholders})`,
        ...reviewIds,
      );
      const reviews = this.run(
        `DELETE FROM reviews WHERE id IN (${placeholders})`,
        ...reviewIds,
      ).changes;
      return {
        reviews,
        signals: Number(signalCount?.total ?? 0),
        media: mediaCount,
        textIndex: textCount,
      };
    });
  }
}

function tenantIdInput(input: UpsertMediaInput): string {
  return input.tenantId;
}

function minhashJaccardFromBands(storedBands: string[], candidateBands: string[]): number {
  // Band keys are derived from the same MinHash permutation layout, so an exact
  // band match is a lower bound on Jaccard. We approximate similarity from the
  // number of matching bands.
  if (storedBands.length === 0 || candidateBands.length === 0) return 0;
  const set = new Set(storedBands);
  let matches = 0;
  for (const band of candidateBands) if (set.has(band)) matches += 1;
  return Math.min(1, matches / Math.max(storedBands.length, candidateBands.length));
}
