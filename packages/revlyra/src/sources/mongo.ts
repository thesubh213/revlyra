import type { MongoClient } from 'mongodb';
import { mapRecord, resolveMapping } from './mapping';
import type {
  PullOptions,
  ReviewSource,
  SourceMapping,
  SourceReview,
  SourceTestResult,
} from './types';

export interface MongoSourceConfig {
  url?: string;
  urlRef?: string;
  database: string;
  collection: string;
  filter?: Record<string, unknown>;
  projection?: Record<string, 0 | 1>;
  limit?: number;
  batchSize?: number;
  mapping?: SourceMapping;
}

function resolveUrl(config: MongoSourceConfig): string {
  const value = config.url ?? (config.urlRef ? process.env[config.urlRef] : undefined);
  if (!value) {
    throw new Error(
      `MongoDB source credentials missing. Set ${config.urlRef ?? 'the configured env var'}.`,
    );
  }
  return value;
}

function assertSafeName(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value) || value.includes('$')) {
    throw new Error(`Invalid MongoDB ${label}: ${value}`);
  }
  return value;
}

export class MongoSource implements ReviewSource {
  readonly kind = 'mongodb';
  readonly id: string;
  private readonly config: MongoSourceConfig;
  private client: MongoClient | null = null;

  constructor(id: string, config: MongoSourceConfig) {
    this.id = id;
    this.config = config;
  }

  capabilities = {
    incremental: false,
    reviewerHistory: true,
    media: false,
    context: false,
  };

  private async connection(): Promise<MongoClient> {
    if (!this.client) {
      const { MongoClient: Client } = await import('mongodb');
      this.client = new Client(resolveUrl(this.config));
      await this.client.connect();
    }
    return this.client;
  }

  private collection() {
    return this.client!.db(assertSafeName(this.config.database, 'database')).collection(
      assertSafeName(this.config.collection, 'collection'),
    );
  }

  async test(): Promise<SourceTestResult> {
    try {
      await this.connection();
      const doc = await this.collection().findOne(this.config.filter ?? {}, {
        projection: this.config.projection,
        maxTimeMS: 15_000,
        readPreference: 'secondaryPreferred',
      });
      return {
        ok: true,
        sampleCount: doc ? 1 : 0,
        sample: doc ? mapRecord(doc, resolveMapping(this.config.mapping, doc), this.kind) : null,
      };
    } catch (error) {
      return { ok: false, sampleCount: 0, message: String(error), sample: null };
    }
  }

  async *pull(options: PullOptions = {}): AsyncIterable<SourceReview> {
    await this.connection();
    const limit = Math.min(options.limit ?? this.config.limit ?? 100_000, 1_000_000);
    const cursor = this.collection()
      .find(this.config.filter ?? {}, {
        projection: this.config.projection,
        batchSize: Math.max(1, Math.min(options.batchSize ?? this.config.batchSize ?? 500, 5000)),
        maxTimeMS: 30_000,
        readPreference: 'secondaryPreferred',
      })
      .limit(limit);

    for await (const doc of cursor) {
      if (options.signal?.aborted) throw new Error('PULL_ABORTED');
      yield mapRecord(doc, resolveMapping(this.config.mapping, doc), this.kind);
    }
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}
