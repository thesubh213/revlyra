import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parse as parseCsv } from 'csv-parse';
import streamJson from 'stream-json';
import streamArrayModule from 'stream-json/streamers/StreamArray.js';
import { mapRecord, resolveMapping } from './mapping';
import type {
  PullOptions,
  ReviewSource,
  SourceMapping,
  SourceReview,
  SourceTestResult,
} from './types';

const { parser } = streamJson;
const { streamArray } = streamArrayModule;

export interface FilesSourceConfig {
  path: string;
  format?: 'json' | 'ndjson' | 'csv';
  csv?: {
    delimiter?: string;
    columns?: boolean;
  };
  mapping?: SourceMapping;
}

function detectFormat(path: string, configured?: string): 'json' | 'ndjson' | 'csv' {
  if (configured === 'json' || configured === 'ndjson' || configured === 'csv') {
    return configured;
  }
  const lower = path.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.ndjson') || lower.endsWith('.jsonl')) return 'ndjson';
  return 'json';
}

async function* readJsonArray(path: string, signal?: AbortSignal): AsyncGenerator<unknown> {
  const pipeline = createReadStream(path).pipe(parser()).pipe(streamArray());
  for await (const entry of pipeline) {
    if (signal?.aborted) throw new Error('PULL_ABORTED');
    yield (entry as { value: unknown }).value;
  }
}

async function* readNdjson(path: string, signal?: AbortSignal): AsyncGenerator<unknown> {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (signal?.aborted) throw new Error('PULL_ABORTED');
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      throw new Error(`Invalid NDJSON line: ${trimmed.slice(0, 80)}`);
    }
  }
}

async function* readCsv(
  path: string,
  config: FilesSourceConfig,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const stream = createReadStream(path).pipe(
    parseCsv({
      bom: true,
      columns: config.csv?.columns ?? true,
      delimiter: config.csv?.delimiter ?? ',',
      relax_column_count: true,
      skip_empty_lines: true,
    }),
  );
  for await (const entry of stream) {
    if (signal?.aborted) throw new Error('PULL_ABORTED');
    yield entry;
  }
}

export class FilesSource implements ReviewSource {
  readonly kind = 'files';
  readonly id: string;
  private readonly config: FilesSourceConfig;
  private readonly absolutePath: string;

  constructor(id: string, config: FilesSourceConfig) {
    this.id = id;
    this.config = config;
    this.absolutePath = resolve(config.path);
  }

  capabilities = {
    incremental: false,
    reviewerHistory: false,
    media: true,
    context: false,
  };

  private async *rawRecords(signal?: AbortSignal): AsyncGenerator<unknown> {
    if (!existsSync(this.absolutePath)) {
      throw new Error(`Source file not found: ${this.absolutePath}`);
    }
    const format = detectFormat(this.absolutePath, this.config.format);
    if (format === 'csv') {
      yield* readCsv(this.absolutePath, this.config, signal);
    } else if (format === 'ndjson') {
      yield* readNdjson(this.absolutePath, signal);
    } else {
      yield* readJsonArray(this.absolutePath, signal);
    }
  }

  async test(): Promise<SourceTestResult> {
    let seen = 0;
    let sample: SourceReview | null = null;
    try {
      for await (const raw of this.rawRecords()) {
        sample = mapRecord(raw, resolveMapping(this.config.mapping, raw), this.kind);
        seen += 1;
        if (seen >= 5) break;
      }
      return { ok: true, sampleCount: seen, sample };
    } catch (error) {
      return { ok: false, sampleCount: seen, message: String(error), sample: null };
    }
  }

  async *pull(options: PullOptions = {}): AsyncIterable<SourceReview> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const batchSize = Math.max(1, options.batchSize ?? 500);
    let count = 0;
    let batch: unknown[] = [];

    for await (const raw of this.rawRecords(options.signal)) {
      batch.push(raw);
      if (batch.length < batchSize) continue;
      for (const record of batch) {
        if (count >= limit) return;
        count += 1;
        yield mapRecord(record, resolveMapping(this.config.mapping, record), this.kind);
      }
      batch = [];
    }
    for (const record of batch) {
      if (count >= limit) return;
      count += 1;
      yield mapRecord(record, resolveMapping(this.config.mapping, record), this.kind);
    }
  }
}
