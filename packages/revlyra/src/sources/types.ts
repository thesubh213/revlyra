import type { CanonicalReview, ReviewMedia } from '@revlyra/core';

export interface SourceReview {
  review: CanonicalReview;
  reviewer?: {
    accountCreatedAt?: string;
    stats?: Record<string, unknown>;
  };
  item?: {
    category?: string;
    attributes?: Record<string, unknown>;
    stats?: Record<string, unknown>;
  };
}

export interface PullOptions {
  limit?: number;
  batchSize?: number;
  since?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface SourceTestResult {
  ok: boolean;
  sampleCount: number;
  message?: string;
  sample?: SourceReview | null;
}

export interface ReviewSource {
  readonly kind: string;
  readonly id: string;
  capabilities: {
    incremental: boolean;
    reviewerHistory: boolean;
    media: boolean;
    context: boolean;
  };
  test(): Promise<SourceTestResult>;
  pull(options?: PullOptions): AsyncIterable<SourceReview>;
  close?(): Promise<void>;
}

export interface FieldSource {
  path: string;
  transform?: 'string' | 'number' | 'boolean' | 'date' | 'json';
  default?: unknown;
}

export interface SourceMapping {
  fields?: Record<string, string | FieldSource>;
  reviewerFields?: Record<string, string | FieldSource>;
  itemFields?: Record<string, string | FieldSource>;
  mediaField?: string;
  mediaFields?: Record<string, string>;
}

export const KNOWN_MEDIA_KEYS: Array<keyof ReviewMedia> = [
  'url',
  'sha256',
  'dhash',
  'phash',
  'width',
  'height',
  'mime',
  'exif',
  'capturedAt',
];
