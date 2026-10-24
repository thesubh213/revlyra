import type { Pool } from 'mysql2/promise';
import { mapRecord, resolveMapping } from './mapping';
import type {
  PullOptions,
  ReviewSource,
  SourceMapping,
  SourceReview,
  SourceTestResult,
} from './types';

export interface MysqlSourceConfig {
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
      return `\`${part.replace(/`/gu, '``')}\``;
    })
    .join('.');
}

function resolveUrl(config: MysqlSourceConfig): string {
  const value = config.url ?? (config.urlRef ? process.env[config.urlRef] : undefined);
  if (!value) {
    throw new Error(
      `MySQL source credentials missing. Set ${config.urlRef ?? 'the configured env var'}.`,
    );
  }
  return value;
}

export class MysqlSource implements ReviewSource {
  readonly kind = 'mysql';
  readonly id: string;
  private readonly config: MysqlSourceConfig;
  private pool: Pool | null = null;

  constructor(id: string, config: MysqlSourceConfig) {
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
      const mysql = await import('mysql2/promise');
      this.pool = mysql.createPool(resolveUrl(this.config));
    }
    return this.pool;
  }

  private baseQuery(): string {
    if (this.config.query) return assertReadOnlyQuery(this.config.query);
    if (this.config.table) {
      const where = this.config.where ? ` WHERE ${this.config.where}` : '';
      return `SELECT * FROM ${quoteIdentifier(this.config.table)}${where}`;
    }
    throw new Error('MySQL source requires either query or table.');
  }

  async test(): Promise<SourceTestResult> {
    try {
      const pool = await this.connection();
      const connection = await pool.getConnection();
      try {
        await connection.query('START TRANSACTION READ ONLY');
        await connection.query('SET SESSION MAX_EXECUTION_TIME = 15000');
        const [rows] = await connection.query(
          `SELECT * FROM (${this.baseQuery()}) AS revlyra_source LIMIT 5`,
        );
        await connection.query('COMMIT');
        const list = rows as Array<Record<string, unknown>>;
        const sample =
          list.length > 0
            ? mapRecord(list[0]!, resolveMapping(this.config.mapping, list[0]), this.kind)
            : null;
        return { ok: true, sampleCount: list.length, sample };
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        connection.release();
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
      const connection = await pool.getConnection();
      let rows: Array<Record<string, unknown>> = [];
      try {
        await connection.query('START TRANSACTION READ ONLY');
        await connection.query('SET SESSION MAX_EXECUTION_TIME = 30000');
        const [result] = await connection.query(
          `SELECT * FROM (${this.baseQuery()}) AS revlyra_source LIMIT ? OFFSET ?`,
          [limit, offset],
        );
        rows = result as Array<Record<string, unknown>>;
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        connection.release();
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
