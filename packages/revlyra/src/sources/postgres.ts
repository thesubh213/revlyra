import type { Pool } from 'pg';
import { mapRecord, resolveMapping } from './mapping';
import type {
  PullOptions,
  ReviewSource,
  SourceMapping,
  SourceReview,
  SourceTestResult,
} from './types';

export interface PostgresSourceConfig {
  url?: string;
  urlRef?: string;
  query?: string;
  table?: string;
  where?: string;
  limit?: number;
  batchSize?: number;
  mapping?: SourceMapping;
}

function assertReadOnlyQuery(query: string): string {
  const trimmed = query.trim().replace(/;+\s*$/u, '');
  if (trimmed.includes(';')) throw new Error('Only a single SQL statement is allowed.');
  if (!/^(select|with)\b/iu.test(trimmed)) {
    throw new Error('Only SELECT or WITH queries are allowed.');
  }
  return trimmed;
}

function quoteIdentifier(table: string): string {
  const parts = table.split('.');
  if (parts.length === 0 || parts.length > 2) throw new Error(`Invalid table name: ${table}`);
  return parts
    .map((part) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(part)) {
        throw new Error(`Invalid table identifier: ${part}`);
      }
      return `"${part.replace(/"/gu, '""')}"`;
    })
    .join('.');
}

function resolveUrl(config: PostgresSourceConfig): string {
  const value = config.url ?? (config.urlRef ? process.env[config.urlRef] : undefined);
  if (!value) {
    throw new Error(
      `Postgres source credentials missing. Set ${config.urlRef ?? 'the configured env var'}.`,
    );
  }
  return value;
}

export class PostgresSource implements ReviewSource {
  readonly kind = 'postgres';
  readonly id: string;
  private readonly config: PostgresSourceConfig;
  private pool: Pool | null = null;

  constructor(id: string, config: PostgresSourceConfig) {
    this.id = id;
    this.config = config;
  }

  capabilities = {
    incremental: false,
    reviewerHistory: true,
    media: false,
    context: false,
  };

  private async connection(): Promise<Pool> {
    if (!this.pool) {
      const { Pool: PgPool } = await import('pg');
      this.pool = new PgPool({
        connectionString: resolveUrl(this.config),
        max: 2,
        statement_timeout: 30_000,
        query_timeout: 30_000,
      });
    }
    return this.pool;
  }

  private baseQuery(): string {
    if (this.config.query) return assertReadOnlyQuery(this.config.query);
    if (this.config.table) {
      const where = this.config.where ? ` WHERE ${this.config.where}` : '';
      return `SELECT * FROM ${quoteIdentifier(this.config.table)}${where}`;
    }
    throw new Error('Postgres source requires either query or table.');
  }

  async test(): Promise<SourceTestResult> {
    try {
      const pool = await this.connection();
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '15s'");
        const rows = await client.query(
          `SELECT * FROM (${this.baseQuery()}) AS revlyra_source LIMIT 5`,
        );
        await client.query('COMMIT');
        const sample =
          rows.rows.length > 0
            ? mapRecord(rows.rows[0], resolveMapping(this.config.mapping, rows.rows[0]), this.kind)
            : null;
        return { ok: true, sampleCount: rows.rows.length, sample };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      return { ok: false, sampleCount: 0, message: String(error), sample: null };
    }
  }

  async *pull(options: PullOptions = {}): AsyncIterable<SourceReview> {
    const pool = await this.connection();
    const totalLimit = Math.min(options.limit ?? this.config.limit ?? 100_000, 1_000_000);
    const batchSize = Math.max(
      1,
      Math.min(options.batchSize ?? this.config.batchSize ?? 500, 5000),
    );
    let offset = 0;
    let emitted = 0;

    while (emitted < totalLimit) {
      if (options.signal?.aborted) throw new Error('PULL_ABORTED');
      const limit = Math.min(batchSize, totalLimit - emitted);
      const client = await pool.connect();
      let rows: Array<Record<string, unknown>> = [];
      try {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '30s'");
        const result = await client.query(
          `SELECT * FROM (${this.baseQuery()}) AS revlyra_source LIMIT $1 OFFSET $2`,
          [limit, offset],
        );
        rows = result.rows as Array<Record<string, unknown>>;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      for (const row of rows) {
        yield mapRecord(row, resolveMapping(this.config.mapping, row), this.kind);
        emitted += 1;
      }
      if (rows.length < limit) break;
      offset += rows.length;
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }
}
