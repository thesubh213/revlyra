import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { sqliteModule } from '../sqlite';
import { mapRecord, resolveMapping } from './mapping';
import type {
  PullOptions,
  ReviewSource,
  SourceMapping,
  SourceReview,
  SourceTestResult,
} from './types';

export interface SqliteSourceConfig {
  path: string;
  query?: string;
  table?: string;
  where?: string;
  limit?: number;
  mapping?: SourceMapping;
}

function assertReadOnlyQuery(query: string): string {
  const trimmed = query.trim().replace(/;+\s*$/u, '');
  if (trimmed.includes(';')) {
    throw new Error('Only a single SQL statement is allowed.');
  }
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

export class SqliteSource implements ReviewSource {
  readonly kind = 'sqlite';
  readonly id: string;
  private readonly config: SqliteSourceConfig;
  private readonly absolutePath: string;
  private db: DatabaseSyncType | null = null;

  constructor(id: string, config: SqliteSourceConfig) {
    this.id = id;
    this.config = config;
    this.absolutePath = resolve(config.path);
  }

  capabilities = {
    incremental: false,
    reviewerHistory: true,
    media: false,
    context: false,
  };

  private connection(): DatabaseSyncType {
    if (!existsSync(this.absolutePath)) {
      throw new Error(`SQLite source not found: ${this.absolutePath}`);
    }
    if (!this.db) {
      const sqlite = sqliteModule();
      this.db = new sqlite.DatabaseSync(this.absolutePath, { readOnly: true });
      this.db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
    }
    return this.db;
  }

  private baseQuery(): string {
    if (this.config.query) return assertReadOnlyQuery(this.config.query);
    if (this.config.table) {
      const where = this.config.where ? ` WHERE ${this.config.where}` : '';
      return `SELECT * FROM ${quoteIdentifier(this.config.table)}${where}`;
    }
    throw new Error('SQLite source requires either query or table.');
  }

  private limitedQuery(limit: number): string {
    const base = this.baseQuery();
    return `SELECT * FROM (${base}) AS revlyra_source LIMIT ${Math.max(1, Math.floor(limit))}`;
  }

  async test(): Promise<SourceTestResult> {
    try {
      const db = this.connection();
      const rows = db.prepare(this.limitedQuery(5)).all() as Array<Record<string, unknown>>;
      const sample =
        rows.length > 0
          ? mapRecord(rows[0]!, resolveMapping(this.config.mapping, rows[0]), this.kind)
          : null;
      return { ok: true, sampleCount: rows.length, sample };
    } catch (error) {
      return { ok: false, sampleCount: 0, message: String(error), sample: null };
    }
  }

  async *pull(options: PullOptions = {}): AsyncIterable<SourceReview> {
    const db = this.connection();
    const limit = Math.min(options.limit ?? this.config.limit ?? 100_000, 1_000_000);
    const statement = db.prepare(this.limitedQuery(limit));
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      if (options.signal?.aborted) throw new Error('PULL_ABORTED');
      yield mapRecord(row, resolveMapping(this.config.mapping, row), this.kind);
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}
