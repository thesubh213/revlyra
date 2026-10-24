import { randomUUID } from 'node:crypto';
import { hammingDistanceHex, sha256Hex } from '@revlyra/core';
import type { Pool, PoolClient } from 'pg';
import type { Store } from './interface';
import { POSTGRES_SCHEMA } from './schema';
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

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't';
}

function isoBefore(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

export class PostgresStore implements Store {
  private readonly poolPromise: Promise<Pool>;

  constructor(connectionString: string, poolSize = 10) {
    this.poolPromise = import('pg').then(
      ({ Pool: PgPool }) => new PgPool({ connectionString, max: poolSize }),
    );
  }

  private async db(): Promise<Pool> {
    return this.poolPromise;
  }

  async migrate(): Promise<void> {
    await (await this.db()).query(POSTGRES_SCHEMA);
    // Postgres can add columns idempotently; existing pre-002 databases get
    // the DSA appeal columns here.
    await (await this.db()).query(
      `ALTER TABLE appeals
        ADD COLUMN IF NOT EXISTS sla_due_at TEXT,
        ADD COLUMN IF NOT EXISTS handler_hmac TEXT,
        ADD COLUMN IF NOT EXISTS outcome_note TEXT;`,
    );
    await (await this.db()).query(
      'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      ['001_init', nowIso()],
    );
    await (await this.db()).query(
      'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      ['002_dsa_review_integrity', nowIso()],
    );
  }

  async close(): Promise<void> {
    await (await this.db()).end();
  }

  private async all(sql: string, params: any[] = []): Promise<Row[]> {
    const result = await (await this.db()).query(sql, params);
    return result.rows;
  }

  private async get(sql: string, params: any[] = []): Promise<Row | undefined> {
    const result = await (await this.db()).query(sql, params);
    return result.rows[0];
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await (await this.db()).connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureTenant(id: string, name = id): Promise<TenantRecord> {
    await (await this.db()).query(
      'INSERT INTO tenants (id, name, policy_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [id, name, 'balanced', nowIso()],
    );
    return (await this.getTenant(id))!;
  }

  async getTenant(id: string): Promise<TenantRecord | null> {
    const row = await this.get('SELECT * FROM tenants WHERE id = $1', [id]);
    return row ? this.mapTenant(row) : null;
  }

  async listTenants(): Promise<TenantRecord[]> {
    return (await this.all('SELECT * FROM tenants ORDER BY created_at')).map((row) =>
      this.mapTenant(row),
    );
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
    const row = await this.get(
      `INSERT INTO api_keys (id, tenant_id, prefix, key_hash, scopes, rate_limit, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        randomUUID(),
        input.tenantId,
        input.prefix,
        input.keyHash,
        JSON.stringify(input.scopes),
        input.rateLimit ?? null,
        nowIso(),
        input.expiresAt ?? null,
      ],
    );
    return this.mapApiKey(row!);
  }

  async findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    const row = await this.get('SELECT * FROM api_keys WHERE key_hash = $1', [hash]);
    return row ? this.mapApiKey(row) : null;
  }

  async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const row = await this.get('SELECT * FROM api_keys WHERE prefix = $1', [prefix]);
    return row ? this.mapApiKey(row) : null;
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    return (
      await this.all('SELECT * FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC', [
        tenantId,
      ])
    ).map((row) => this.mapApiKey(row));
  }

  async revokeApiKey(tenantId: string, id: string): Promise<boolean> {
    const result = await (await this.db()).query(
      'UPDATE api_keys SET revoked_at = $1 WHERE tenant_id = $2 AND id = $3 AND revoked_at IS NULL',
      [nowIso(), tenantId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async touchApiKey(id: string): Promise<void> {
    await (await this.db()).query('UPDATE api_keys SET last_used_at = $1 WHERE id = $2', [
      nowIso(),
      id,
    ]);
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
    await (await this.db()).query(
      `INSERT INTO sources (id, tenant_id, kind, name, config, mapping, cursor, enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9)`,
      [
        id,
        input.tenantId,
        input.kind,
        input.name,
        JSON.stringify(input.config),
        JSON.stringify(input.mapping),
        input.enabled !== false,
        now,
        now,
      ],
    );
    return (await this.getSource(input.tenantId, id))!;
  }

  async getSource(tenantId: string, id: string): Promise<SourceRecord | null> {
    const row = await this.get('SELECT * FROM sources WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      id,
    ]);
    return row ? this.mapSource(row) : null;
  }

  async listSources(tenantId: string): Promise<SourceRecord[]> {
    return (
      await this.all('SELECT * FROM sources WHERE tenant_id = $1 ORDER BY created_at', [tenantId])
    ).map((row) => this.mapSource(row));
  }

  async updateSourceCursor(
    tenantId: string,
    id: string,
    cursor: Record<string, unknown>,
  ): Promise<void> {
    await (await this.db()).query(
      'UPDATE sources SET cursor = $1, updated_at = $2 WHERE tenant_id = $3 AND id = $4',
      [JSON.stringify(cursor), nowIso(), tenantId, id],
    );
  }

  async deleteSource(tenantId: string, id: string): Promise<boolean> {
    const result = await (await this.db()).query(
      'DELETE FROM sources WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return (result.rowCount ?? 0) > 0;
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
      enabled: bool(row.enabled),
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
    await (await this.db()).query(
      `INSERT INTO reviewers (id, tenant_id, external_hmac, account_created_at, stats, risk_score, risk_band, first_seen, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, external_hmac) DO UPDATE SET
         account_created_at = COALESCE(EXCLUDED.account_created_at, reviewers.account_created_at),
         stats = EXCLUDED.stats,
         risk_score = EXCLUDED.risk_score,
         risk_band = EXCLUDED.risk_band,
         last_seen = EXCLUDED.last_seen`,
      [
        randomUUID(),
        input.tenantId,
        input.externalHmac,
        input.accountCreatedAt ?? null,
        JSON.stringify(input.stats ?? {}),
        input.riskScore ?? 0,
        input.riskBand ?? 'low',
        now,
        now,
      ],
    );
    return (await this.getReviewer(input.tenantId, input.externalHmac))!;
  }

  async getReviewer(tenantId: string, externalHmac: string): Promise<ReviewerRecord | null> {
    const row = await this.get(
      'SELECT * FROM reviewers WHERE tenant_id = $1 AND external_hmac = $2',
      [tenantId, externalHmac],
    );
    return row ? this.mapReviewer(row) : null;
  }

  async getReviewerById(tenantId: string, id: string): Promise<ReviewerRecord | null> {
    const row = await this.get('SELECT * FROM reviewers WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      id,
    ]);
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
    await (await this.db()).query(
      `INSERT INTO items (id, tenant_id, external_hmac, type, category, attributes, stats, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id, external_hmac) DO UPDATE SET
         type = EXCLUDED.type,
         category = COALESCE(EXCLUDED.category, items.category),
         attributes = EXCLUDED.attributes,
         stats = EXCLUDED.stats`,
      [
        randomUUID(),
        input.tenantId,
        input.externalHmac,
        input.type ?? 'product',
        input.category ?? null,
        JSON.stringify(input.attributes ?? {}),
        JSON.stringify(input.stats ?? {}),
        nowIso(),
      ],
    );
    return (await this.getItem(input.tenantId, input.externalHmac))!;
  }

  async getItem(tenantId: string, externalHmac: string): Promise<ItemRecord | null> {
    const row = await this.get('SELECT * FROM items WHERE tenant_id = $1 AND external_hmac = $2', [
      tenantId,
      externalHmac,
    ]);
    return row ? this.mapItem(row) : null;
  }

  async getItemById(tenantId: string, id: string): Promise<ItemRecord | null> {
    const row = await this.get('SELECT * FROM items WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      id,
    ]);
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
    const row = await this.get(
      `INSERT INTO reviews (
        id, tenant_id, source_id, external_hmac, item_id, reviewer_id, rating, text, text_sha256,
        simhash, language, submitted_at, ingested_at, verified, context, media, status,
        analysis_hash, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (tenant_id, source_id, external_hmac) DO UPDATE SET
        rating = EXCLUDED.rating, text = EXCLUDED.text, text_sha256 = EXCLUDED.text_sha256,
        simhash = EXCLUDED.simhash, language = EXCLUDED.language, submitted_at = EXCLUDED.submitted_at,
        verified = EXCLUDED.verified, context = EXCLUDED.context, media = EXCLUDED.media,
        updated_at = EXCLUDED.updated_at, analysis_hash = EXCLUDED.analysis_hash
      RETURNING *`,
      [
        input.id ?? randomUUID(),
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
        input.verified,
        JSON.stringify(input.context),
        JSON.stringify(input.media),
        'pending',
        input.analysisHash ?? null,
        now,
        now,
      ],
    );
    return this.mapReview(row!);
  }

  async getReview(tenantId: string, id: string): Promise<ReviewRecord | null> {
    const row = await this.get('SELECT * FROM reviews WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      id,
    ]);
    return row ? this.mapReview(row) : null;
  }

  async findReviewByExternal(
    tenantId: string,
    sourceId: string,
    externalHmac: string,
  ): Promise<ReviewRecord | null> {
    const row = await this.get(
      'SELECT * FROM reviews WHERE tenant_id = $1 AND source_id = $2 AND external_hmac = $3',
      [tenantId, sourceId, externalHmac],
    );
    return row ? this.mapReview(row) : null;
  }

  async updateReviewAnalysis(
    tenantId: string,
    id: string,
    input: UpdateReviewAnalysisInput,
  ): Promise<void> {
    await (await this.db()).query(
      `UPDATE reviews SET score = $1, confidence = $2, decision = $3, band = $4, provisional = $5,
        model_version = $6, policy_version = $7, analysis_hash = $8, status = 'analyzed', updated_at = $9
       WHERE tenant_id = $10 AND id = $11`,
      [
        input.score,
        input.confidence,
        input.decision,
        input.band,
        input.provisional,
        input.modelVersion,
        input.policyVersion,
        input.analysisHash,
        nowIso(),
        tenantId,
        id,
      ],
    );
  }

  async listItemReviews(tenantId: string, itemId: string, limit = 500): Promise<ReviewRecord[]> {
    return (
      await this.all(
        'SELECT * FROM reviews WHERE tenant_id = $1 AND item_id = $2 ORDER BY submitted_at DESC LIMIT $3',
        [tenantId, itemId, limit],
      )
    ).map((row) => this.mapReview(row));
  }

  async listReviewerReviews(
    tenantId: string,
    reviewerId: string,
    limit = 500,
  ): Promise<ReviewRecord[]> {
    return (
      await this.all(
        'SELECT * FROM reviews WHERE tenant_id = $1 AND reviewer_id = $2 ORDER BY submitted_at DESC LIMIT $3',
        [tenantId, reviewerId, limit],
      )
    ).map((row) => this.mapReview(row));
  }

  async listRecentReviews(tenantId: string, limit = 500): Promise<ReviewRecord[]> {
    return (
      await this.all(
        'SELECT * FROM reviews WHERE tenant_id = $1 ORDER BY submitted_at DESC LIMIT $2',
        [tenantId, limit],
      )
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
      verified: bool(row.verified),
      context: parseJson<Record<string, unknown>>(row.context, {}),
      media: parseJson<Array<Record<string, unknown>>>(row.media, []),
      status: String(row.status),
      score: row.score === null ? null : Number(row.score),
      confidence: row.confidence === null ? null : Number(row.confidence),
      decision: row.decision ? (String(row.decision) as ReviewRecord['decision']) : null,
      band: row.band ? (String(row.band) as ReviewRecord['band']) : null,
      provisional: bool(row.provisional),
      analysisHash: row.analysis_hash ? String(row.analysis_hash) : null,
      modelVersion: row.model_version ? String(row.model_version) : null,
      policyVersion: row.policy_version ? String(row.policy_version) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async insertSignals(reviewId: string, signals: SignalRecord[]): Promise<void> {
    await this.tx(async (client) => {
      await client.query('DELETE FROM review_signals WHERE review_id = $1', [reviewId]);
      for (const signal of signals) {
        await client.query(
          `INSERT INTO review_signals (review_id, code, family, severity, confidence, contribution, evidence, explanation, hard)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            reviewId,
            signal.code,
            signal.family,
            signal.severity,
            signal.confidence,
            signal.contribution,
            JSON.stringify(signal.evidence),
            signal.explanation,
            signal.hard,
          ],
        );
      }
    });
  }

  async getSignals(reviewId: string): Promise<SignalRecord[]> {
    return (
      await this.all('SELECT * FROM review_signals WHERE review_id = $1 ORDER BY id', [reviewId])
    ).map((row) => ({
      id: Number(row.id),
      reviewId: String(row.review_id),
      code: String(row.code),
      family: String(row.family) as SignalRecord['family'],
      severity: Number(row.severity),
      confidence: Number(row.confidence),
      contribution: Number(row.contribution),
      evidence: parseJson<Record<string, unknown>>(row.evidence, {}),
      explanation: String(row.explanation),
      hard: bool(row.hard),
    }));
  }

  async upsertTextIndex(input: UpsertTextIndexInput): Promise<void> {
    await this.tx(async (client) => {
      const existing = await client.query(
        'SELECT id FROM text_index WHERE tenant_id = $1 AND review_id = $2',
        [input.tenantId, input.reviewId],
      );
      if (existing.rows[0]) {
        await client.query('DELETE FROM text_bands WHERE text_index_id = $1', [
          existing.rows[0].id,
        ]);
        await client.query('DELETE FROM text_index WHERE id = $1', [existing.rows[0].id]);
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO text_index (id, tenant_id, text_sha256, simhash, minhash, review_id, reviewer_id, item_id, submitted_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          input.tenantId,
          input.textSha256,
          input.simhash,
          JSON.stringify(input.minhashBands),
          input.reviewId,
          input.reviewerId,
          input.itemId,
          input.submittedAt,
          nowIso(),
        ],
      );
      for (const band of input.simhashBands) {
        await client.query(
          'INSERT INTO text_bands (tenant_id, kind, band_key, text_index_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [input.tenantId, 'sim', band, id],
        );
      }
      for (const band of input.minhashBands) {
        await client.query(
          'INSERT INTO text_bands (tenant_id, kind, band_key, text_index_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [input.tenantId, 'min', band, id],
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

    const exact = await this.all(
      'SELECT * FROM text_index WHERE tenant_id = $1 AND text_sha256 = $2 AND review_id != $3 LIMIT $4',
      [tenantId, input.textSha256, exclude, limit],
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
      const candidates = await this.all(
        `SELECT DISTINCT ti.* FROM text_bands tb
         JOIN text_index ti ON ti.id = tb.text_index_id
         WHERE tb.tenant_id = $1 AND tb.band_key = ANY($2::text[]) AND ti.review_id != $3
         LIMIT 500`,
        [tenantId, bandKeys, exclude],
      );
      for (const row of candidates) {
        const reviewId = String(row.review_id);
        const simhashSimilarity = 1 - hammingDistanceHex(String(row.simhash), input.simhash) / 64;
        const storedBands = parseJson<string[]>(row.minhash, []);
        const set = new Set(storedBands);
        let bandMatches = 0;
        for (const band of input.minhashBands) if (set.has(band)) bandMatches += 1;
        const minhashSimilarity =
          storedBands.length > 0
            ? Math.min(1, bandMatches / Math.max(storedBands.length, input.minhashBands.length))
            : 0;
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
    const row = await this.get('SELECT * FROM text_index WHERE tenant_id = $1 AND review_id = $2', [
      tenantId,
      reviewId,
    ]);
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
    await this.tx(async (client) => {
      const existing = await client.query(
        `SELECT id FROM media WHERE tenant_id = $1 AND review_id = $2
         AND (($3::text IS NOT NULL AND sha256 = $3) OR ($4::text IS NOT NULL AND url_hmac = $4))
         LIMIT 1`,
        [input.tenantId, input.reviewId, input.sha256 ?? null, input.urlHmac ?? null],
      );
      if (existing.rows[0]) {
        await client.query('DELETE FROM media_bands WHERE media_id = $1', [existing.rows[0].id]);
        await client.query('DELETE FROM media WHERE id = $1', [existing.rows[0].id]);
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO media (id, tenant_id, review_id, reviewer_id, item_id, sha256, dhash, phash, width, height, mime, exif, url_hmac, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
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
        ],
      );
      for (const band of input.phashBands ?? []) {
        await client.query(
          'INSERT INTO media_bands (tenant_id, kind, band_key, media_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [input.tenantId, 'phash', band, id],
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
      const exact = await this.all(
        'SELECT * FROM media WHERE tenant_id = $1 AND sha256 = $2 AND review_id != $3 LIMIT $4',
        [tenantId, input.sha256, exclude, limit],
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
      const candidates = await this.all(
        `SELECT DISTINCT m.* FROM media_bands mb
         JOIN media m ON m.id = mb.media_id
         WHERE mb.tenant_id = $1 AND mb.kind = 'phash' AND mb.band_key = ANY($2::text[])
           AND m.review_id != $3
         LIMIT 500`,
        [tenantId, input.phashBands, exclude],
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
    return (
      await this.all(
        'SELECT * FROM media WHERE tenant_id = $1 AND review_id = $2 ORDER BY created_at',
        [tenantId, reviewId],
      )
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
    const counts = await this.get(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN submitted_at >= $1 THEN 1 ELSE 0 END) AS d1,
        SUM(CASE WHEN submitted_at >= $2 THEN 1 ELSE 0 END) AS d7,
        SUM(CASE WHEN submitted_at >= $3 THEN 1 ELSE 0 END) AS d30,
        SUM(rating) AS rating_sum,
        MIN(submitted_at) AS first_at,
        MAX(submitted_at) AS last_at
       FROM reviews WHERE tenant_id = $4 AND reviewer_id = $5`,
      [
        isoBefore(86_400_000),
        isoBefore(7 * 86_400_000),
        isoBefore(30 * 86_400_000),
        tenantId,
        reviewerId,
      ],
    );
    const distributionRows = await this.all(
      `SELECT CAST(ROUND(rating) AS INTEGER) AS bucket, COUNT(*) AS count
       FROM reviews WHERE tenant_id = $1 AND reviewer_id = $2 GROUP BY bucket`,
      [tenantId, reviewerId],
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
        variance += distribution[i]! * (i + 1 - averageRating!) ** 2;
      }
      variance /= total;
    }
    const recent = (
      await this.all(
        'SELECT submitted_at FROM reviews WHERE tenant_id = $1 AND reviewer_id = $2 ORDER BY submitted_at DESC LIMIT 100',
        [tenantId, reviewerId],
      )
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
    const counts = await this.get(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN submitted_at >= $1 THEN 1 ELSE 0 END) AS d1,
        SUM(CASE WHEN submitted_at >= $2 THEN 1 ELSE 0 END) AS d7,
        SUM(rating) AS rating_sum
       FROM reviews WHERE tenant_id = $3 AND item_id = $4`,
      [isoBefore(86_400_000), isoBefore(7 * 86_400_000), tenantId, itemId],
    );
    const distributionRows = await this.all(
      `SELECT CAST(ROUND(rating) AS INTEGER) AS bucket, COUNT(*) AS count
       FROM reviews WHERE tenant_id = $1 AND item_id = $2 GROUP BY bucket`,
      [tenantId, itemId],
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
        variance += distribution[i]! * (i + 1 - averageRating!) ** 2;
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
    const row = await this.get('SELECT COUNT(*) AS total FROM reviews WHERE tenant_id = $1', [
      tenantId,
    ]);
    return { totalReviews: Number(row?.total ?? 0) };
  }

  async decisionCounts(
    tenantId: string,
    since: string,
  ): Promise<Array<{ decision: string; count: number }>> {
    return (
      await this.all(
        `SELECT decision, COUNT(*) AS count FROM reviews
         WHERE tenant_id = $1 AND submitted_at >= $2 AND decision IS NOT NULL
         GROUP BY decision ORDER BY count DESC`,
        [tenantId, since],
      )
    ).map((row) => ({ decision: String(row.decision), count: Number(row.count) }));
  }

  async signalCodeCounts(
    tenantId: string,
    since: string,
    limit = 50,
  ): Promise<Array<{ code: string; family: string; count: number }>> {
    return (
      await this.all(
        `SELECT s.code AS code, s.family AS family, COUNT(*) AS count
         FROM review_signals s JOIN reviews r ON r.id = s.review_id
         WHERE r.tenant_id = $1 AND r.submitted_at >= $2
         GROUP BY s.code, s.family ORDER BY count DESC LIMIT $3`,
        [tenantId, since, limit],
      )
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
    const record: FeedbackRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      reviewId: input.reviewId,
      label: input.label,
      reasonCode: input.reasonCode,
      notes: input.notes ?? null,
      actorHmac: input.actorHmac ?? null,
      createdAt: nowIso(),
    };
    await (await this.db()).query(
      `INSERT INTO feedback (id, tenant_id, review_id, label, reason_code, notes, actor_hmac, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        record.id,
        record.tenantId,
        record.reviewId,
        record.label,
        record.reasonCode,
        record.notes,
        record.actorHmac,
        record.createdAt,
      ],
    );
    return record;
  }

  async listFeedback(tenantId: string, reviewId?: string, limit = 100): Promise<FeedbackRecord[]> {
    const rows = reviewId
      ? await this.all(
          'SELECT * FROM feedback WHERE tenant_id = $1 AND review_id = $2 ORDER BY created_at DESC LIMIT $3',
          [tenantId, reviewId, limit],
        )
      : await this.all(
          'SELECT * FROM feedback WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
          [tenantId, limit],
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
    const record: AppealRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      reviewId: input.reviewId,
      status: 'open',
      reason: input.reason ?? null,
      createdAt: nowIso(),
      slaDueAt: input.slaDueAt ?? null,
      resolvedAt: null,
      handlerHmac: null,
      outcomeNote: null,
    };
    await (await this.db()).query(
      'INSERT INTO appeals (id, tenant_id, review_id, status, reason, created_at, sla_due_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [
        record.id,
        record.tenantId,
        record.reviewId,
        record.status,
        record.reason,
        record.createdAt,
        record.slaDueAt,
      ],
    );
    return record;
  }

  async resolveAppeal(
    tenantId: string,
    id: string,
    status: 'upheld' | 'overturned',
    handlerHmac?: string | null,
    outcomeNote?: string | null,
  ): Promise<AppealRecord | null> {
    await (await this.db()).query(
      'UPDATE appeals SET status = $1, resolved_at = $2, handler_hmac = $3, outcome_note = $4 WHERE tenant_id = $5 AND id = $6',
      [status, nowIso(), handlerHmac ?? null, outcomeNote ?? null, tenantId, id],
    );
    const row = await this.get('SELECT * FROM appeals WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      id,
    ]);
    return row ? this.mapAppeal(row) : null;
  }

  async listAppeals(tenantId: string, status?: AppealRecord['status']): Promise<AppealRecord[]> {
    const rows = status
      ? await this.all(
          'SELECT * FROM appeals WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC',
          [tenantId, status],
        )
      : await this.all('SELECT * FROM appeals WHERE tenant_id = $1 ORDER BY created_at DESC', [
          tenantId,
        ]);
    return rows.map((row) => this.mapAppeal(row));
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
    await (await this.db()).query(
      'INSERT INTO notices (id, tenant_id, review_id, type, claim, substantiated, status, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [
        record.id,
        record.tenantId,
        record.reviewId,
        record.type,
        record.claim,
        record.substantiated,
        record.status,
        JSON.stringify(record.metadata),
        record.createdAt,
      ],
    );
    return record;
  }

  async getNotice(tenantId: string, id: string): Promise<NoticeRecord | null> {
    const row = await this.get('SELECT * FROM notices WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      id,
    ]);
    return row ? this.mapNotice(row) : null;
  }

  async listNotices(
    tenantId: string,
    options?: { status?: NoticeStatus; reviewId?: string; limit?: number },
  ): Promise<NoticeRecord[]> {
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (options?.status) {
      clauses.push(`status = ${params.length + 1}`);
      params.push(options.status);
    }
    if (options?.reviewId) {
      clauses.push(`review_id = ${params.length + 1}`);
      params.push(options.reviewId);
    }
    params.push(Math.max(1, options?.limit ?? 100));
    const rows = await this.all(
      `SELECT * FROM notices WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => this.mapNotice(row));
  }

  async updateNoticeStatus(
    tenantId: string,
    id: string,
    input: { status: NoticeStatus; note?: string },
  ): Promise<NoticeRecord | null> {
    const existing = await this.get(
      'SELECT metadata FROM notices WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    const metadata: Record<string, unknown> = existing
      ? parseJson<Record<string, unknown>>(existing.metadata, {})
      : {};
    if (input.note !== undefined) metadata.statusNote = input.note;
    const resolved = ['actioned', 'rejected', 'expired'].includes(input.status);
    await (await this.db()).query(
      'UPDATE notices SET status = $1, resolved_at = $2, metadata = $3 WHERE tenant_id = $4 AND id = $5',
      [input.status, resolved ? nowIso() : null, JSON.stringify(metadata), tenantId, id],
    );
    const row = await this.get('SELECT * FROM notices WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      id,
    ]);
    return row ? this.mapNotice(row) : null;
  }

  private mapNotice(row: Row): NoticeRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      reviewId: String(row.review_id),
      type: String(row.type) as NoticeRecord['type'],
      claim: String(row.claim),
      substantiated: bool(row.substantiated),
      status: String(row.status) as NoticeRecord['status'],
      metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    };
  }

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    const now = nowIso();
    const row = await this.get(
      `INSERT INTO jobs (id, tenant_id, kind, status, payload, attempts, max_attempts, run_after, created_at, updated_at)
       VALUES ($1,$2,$3,'pending',$4,0,$5,$6,$7,$8) RETURNING *`,
      [
        randomUUID(),
        input.tenantId,
        input.kind,
        JSON.stringify(input.payload ?? {}),
        input.maxAttempts ?? 3,
        input.runAfter ?? now,
        now,
        now,
      ],
    );
    return this.mapJob(row!);
  }

  async getJob(tenantId: string, id: string): Promise<JobRecord | null> {
    const row = await this.get('SELECT * FROM jobs WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      id,
    ]);
    return row ? this.mapJob(row) : null;
  }

  async listJobs(tenantId: string, limit = 100): Promise<JobRecord[]> {
    return (
      await this.all('SELECT * FROM jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2', [
        tenantId,
        limit,
      ])
    ).map((row) => this.mapJob(row));
  }

  async claimJob(): Promise<JobRecord | null> {
    const now = nowIso();
    const row = await this.get(
      `UPDATE jobs SET status = 'running', claimed_at = $1, attempts = attempts + 1, updated_at = $2
       WHERE id = (
         SELECT id FROM jobs WHERE status = 'pending' AND run_after <= $3
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [now, now, now],
    );
    return row ? this.mapJob(row) : null;
  }

  async completeJob(id: string, result: Record<string, unknown> = {}): Promise<void> {
    await (await this.db()).query(
      "UPDATE jobs SET status = 'completed', result = $1, error = NULL, updated_at = $2 WHERE id = $3",
      [JSON.stringify(result), nowIso(), id],
    );
  }

  async failJob(id: string, error: string, retryAfterMs = 0): Promise<void> {
    const row = await this.get('SELECT * FROM jobs WHERE id = $1', [id]);
    if (!row) return;
    const dead = Number(row.attempts) >= Number(row.max_attempts);
    await (await this.db()).query(
      'UPDATE jobs SET status = $1, error = $2, run_after = $3, updated_at = $4 WHERE id = $5',
      [
        dead ? 'dead' : 'pending',
        error.slice(0, 2000),
        new Date(Date.now() + retryAfterMs).toISOString(),
        nowIso(),
        id,
      ],
    );
  }

  async recoverStaleJobs(olderThanMs: number): Promise<number> {
    const result = await (await this.db()).query(
      `UPDATE jobs SET status = 'pending', claimed_at = NULL, updated_at = $1
       WHERE status = 'running' AND claimed_at < $2`,
      [nowIso(), new Date(Date.now() - olderThanMs).toISOString()],
    );
    return result.rowCount ?? 0;
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
    return this.tx(async (client) => {
      const last = await client.query(
        'SELECT hash FROM audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1',
        [input.tenantId],
      );
      const prevHash = last.rows[0] ? String(last.rows[0].hash) : '';
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
      const inserted = await client.query(
        `INSERT INTO audit_log (tenant_id, actor, action, target_type, target_id, payload, prev_hash, hash, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          input.tenantId,
          input.actor,
          input.action,
          input.targetType,
          input.targetId,
          JSON.stringify(payload),
          prevHash,
          hash,
          createdAt,
        ],
      );
      return this.mapAudit(inserted.rows[0]);
    });
  }

  async listAudit(tenantId: string, limit = 500): Promise<AuditRecord[]> {
    return (
      await this.all('SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT $2', [
        tenantId,
        limit,
      ])
    ).map((row) => this.mapAudit(row));
  }

  async verifyAudit(tenantId: string): Promise<{
    valid: boolean;
    count: number;
    firstBrokenSeq: number | null;
  }> {
    const rows = await this.all('SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY seq ASC', [
      tenantId,
    ]);
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
    const row = await this.get(
      `INSERT INTO usage_counters (tenant_id, metric, period, value) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, metric, period) DO UPDATE SET value = usage_counters.value + EXCLUDED.value
       RETURNING value`,
      [tenantId, metric, period, amount],
    );
    return Number(row?.value ?? 0);
  }

  async getUsage(tenantId: string, metric: string, period: string): Promise<number> {
    const row = await this.get(
      'SELECT value FROM usage_counters WHERE tenant_id = $1 AND metric = $2 AND period = $3',
      [tenantId, metric, period],
    );
    return Number(row?.value ?? 0);
  }

  async listUsage(tenantId: string, period: string): Promise<UsageRecord[]> {
    return (
      await this.all(
        'SELECT metric, period, value FROM usage_counters WHERE tenant_id = $1 AND period = $2',
        [tenantId, period],
      )
    ).map((row) => ({
      metric: String(row.metric),
      period: String(row.period),
      value: Number(row.value),
    }));
  }

  async upsertCampaign(record: CampaignRecord): Promise<void> {
    await this.tx(async (client) => {
      await client.query(
        `INSERT INTO campaigns (id, tenant_id, kind, score, density, member_count, reviewer_ids, item_ids, evidence, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET
           score = EXCLUDED.score, density = EXCLUDED.density, member_count = EXCLUDED.member_count,
           reviewer_ids = EXCLUDED.reviewer_ids, item_ids = EXCLUDED.item_ids,
           evidence = EXCLUDED.evidence, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
        [
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
        ],
      );
      await client.query('DELETE FROM campaign_members WHERE tenant_id = $1 AND campaign_id = $2', [
        record.tenantId,
        record.id,
      ]);
      for (const reviewerId of record.reviewerIds) {
        await client.query(
          'INSERT INTO campaign_members (tenant_id, campaign_id, reviewer_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [record.tenantId, record.id, reviewerId],
        );
      }
    });
  }

  async getCampaign(tenantId: string, id: string): Promise<CampaignRecord | null> {
    const row = await this.get('SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      id,
    ]);
    return row ? this.mapCampaign(row) : null;
  }

  async listCampaigns(tenantId: string, limit = 100): Promise<CampaignRecord[]> {
    return (
      await this.all('SELECT * FROM campaigns WHERE tenant_id = $1 ORDER BY score DESC LIMIT $2', [
        tenantId,
        limit,
      ])
    ).map((row) => this.mapCampaign(row));
  }

  async getCampaignForReviewer(
    tenantId: string,
    reviewerId: string,
  ): Promise<CampaignRecord | null> {
    const row = await this.get(
      `SELECT c.* FROM campaigns c
       JOIN campaign_members cm ON cm.campaign_id = c.id AND cm.tenant_id = c.tenant_id
       WHERE c.tenant_id = $1 AND cm.reviewer_id = $2
       ORDER BY c.score DESC LIMIT 1`,
      [tenantId, reviewerId],
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
    await (await this.db()).query(
      `INSERT INTO reviewer_item_edges (tenant_id, reviewer_id, item_id, review_id, submitted_at, risk, signals)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, review_id) DO UPDATE SET
         reviewer_id = EXCLUDED.reviewer_id, item_id = EXCLUDED.item_id,
         submitted_at = EXCLUDED.submitted_at, risk = EXCLUDED.risk, signals = EXCLUDED.signals`,
      [
        input.tenantId,
        input.reviewerId,
        input.itemId,
        input.reviewId,
        input.submittedAt,
        input.risk,
        JSON.stringify(input.signals),
      ],
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
    return (
      await this.all(
        `SELECT * FROM reviewer_item_edges WHERE tenant_id = $1 AND submitted_at >= $2
       ORDER BY submitted_at DESC LIMIT $3`,
        [tenantId, since, limit],
      )
    ).map((row) => ({
      reviewerId: String(row.reviewer_id),
      itemId: String(row.item_id),
      reviewId: String(row.review_id),
      submittedAt: String(row.submitted_at),
      risk: Number(row.risk),
      signals: parseJson<string[]>(row.signals, []),
    }));
  }

  async listReviewGroupKeys(
    tenantId: string,
    since: string,
    limit = 20_000,
  ): Promise<ReviewGroupKeyRow[]> {
    return (
      await this.all(
        `SELECT id, reviewer_id, text_sha256, context, submitted_at FROM reviews
         WHERE tenant_id = $1 AND submitted_at >= $2
         ORDER BY submitted_at DESC LIMIT $3`,
        [tenantId, since, limit],
      )
    ).map((row) => ({
      reviewId: String(row.id),
      reviewerId: String(row.reviewer_id),
      textSha256: String(row.text_sha256),
      context: row.context ? parseJson<Record<string, unknown>>(row.context, {}) : {},
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
    return (
      await this.all(
        `SELECT m.review_id, m.reviewer_id, m.sha256, r.submitted_at
         FROM media m JOIN reviews r ON r.tenant_id = m.tenant_id AND r.id = m.review_id
         WHERE m.tenant_id = $1 AND m.sha256 IS NOT NULL AND r.submitted_at >= $2
         ORDER BY r.submitted_at DESC LIMIT $3`,
        [tenantId, since, limit],
      )
    ).map((row) => ({
      reviewId: String(row.review_id),
      reviewerId: String(row.reviewer_id),
      sha256: row.sha256 === null ? null : String(row.sha256),
      submittedAt: String(row.submitted_at),
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
    await (await this.db()).query(
      `INSERT INTO risk_snapshots (tenant_id, entity_type, entity_id, score, band, computed_at, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, entity_type, entity_id) DO UPDATE SET
         score = EXCLUDED.score, band = EXCLUDED.band, computed_at = EXCLUDED.computed_at, version = EXCLUDED.version`,
      [
        input.tenantId,
        input.entityType,
        input.entityId,
        input.score,
        input.band,
        nowIso(),
        input.version,
      ],
    );
  }

  async getRiskSnapshot(
    tenantId: string,
    entityType: 'reviewer' | 'item',
    entityId: string,
  ): Promise<{ score: number; band: string; computedAt: string; version: string } | null> {
    const row = await this.get(
      'SELECT * FROM risk_snapshots WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3',
      [tenantId, entityType, entityId],
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
    return this.tx(async (client) => {
      const ids = await client.query(
        'SELECT id FROM reviews WHERE tenant_id = $1 AND submitted_at < $2',
        [tenantId, before],
      );
      const reviewIds = ids.rows.map((row) => String(row.id));
      if (reviewIds.length === 0) {
        return { reviews: 0, signals: 0, media: 0, textIndex: 0 };
      }
      const signalCount = await client.query(
        'SELECT COUNT(*) AS total FROM review_signals WHERE review_id = ANY($1::text[])',
        [reviewIds],
      );
      await client.query(
        `DELETE FROM media_bands WHERE media_id IN (
           SELECT id FROM media WHERE review_id = ANY($1::text[])
         )`,
        [reviewIds],
      );
      const mediaCount = await client.query(`DELETE FROM media WHERE review_id = ANY($1::text[])`, [
        reviewIds,
      ]);
      await client.query(
        `DELETE FROM text_bands WHERE text_index_id IN (
           SELECT id FROM text_index WHERE review_id = ANY($1::text[])
         )`,
        [reviewIds],
      );
      const textCount = await client.query(
        `DELETE FROM text_index WHERE review_id = ANY($1::text[])`,
        [reviewIds],
      );
      await client.query('DELETE FROM review_signals WHERE review_id = ANY($1::text[])', [
        reviewIds,
      ]);
      await client.query('DELETE FROM reviewer_item_edges WHERE review_id = ANY($1::text[])', [
        reviewIds,
      ]);
      const reviews = await client.query('DELETE FROM reviews WHERE id = ANY($1::text[])', [
        reviewIds,
      ]);
      return {
        reviews: reviews.rowCount ?? 0,
        signals: Number(signalCount.rows[0]?.total ?? 0),
        media: mediaCount.rowCount ?? 0,
        textIndex: textCount.rowCount ?? 0,
      };
    });
  }
}
