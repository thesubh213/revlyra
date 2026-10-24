import type {
  AnalysisResult,
  CanonicalReview,
  IntegrityResult,
  SelectionOptions,
  SelectionResult,
} from '@revlyra/core';

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

export interface AnalyzeInput {
  review: CanonicalReview;
  reviewer?: Record<string, unknown>;
  item?: {
    category?: string;
    attributes?: Record<string, unknown>;
    stats?: Record<string, unknown>;
  };
  sourceId?: string;
}

export interface AnalyzeResponse extends AnalysisResult {
  reviewId: string;
  mediaWarnings?: string[];
}

export interface BatchInput {
  reviews: CanonicalReview[];
  reviewer?: Record<string, unknown>;
  item?: AnalyzeInput['item'];
  sourceId?: string;
}

export interface BatchResponse {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<Record<string, unknown>>;
}

export interface ReviewSummary {
  id: string;
  sourceId: string;
  itemId: string;
  reviewerId: string;
  rating: number;
  submittedAt: string;
  language: string;
  verified: boolean;
  decision: string | null;
  band: string | null;
  score: number | null;
  confidence: number | null;
  provisional: boolean;
  modelVersion: string | null;
  policyVersion: string | null;
  text?: string;
}

export interface FeedbackInput {
  reviewId: string;
  label: 'genuine' | 'fake' | 'unsure' | 'policy_violation';
  reasonCode: string;
  notes?: string;
}

export interface AppealInput {
  reviewId: string;
  reason?: string;
}

export interface ScanInput {
  sourceId: string;
  limit?: number;
  batchSize?: number;
  sync?: boolean;
}

export interface UsageResponse {
  period: string;
  reviewsUsed: number;
  reviewsLimit: number;
  entitlements: Record<string, unknown>;
  usage: Array<{ metric: string; period: string; value: number }>;
}

export class RevlyraApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RevlyraApiError';
  }
}

function normalizeBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/u, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export class RevlyraClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly headers: Record<string, string>;

  constructor(options: ClientOptions) {
    if (!options.baseUrl) throw new Error('baseUrl is required.');
    if (!options.apiKey) throw new Error('apiKey is required.');
    this.baseUrl = normalizeBase(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = Math.max(0, options.retries ?? 2);
    this.headers = options.headers ?? {};
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { idempotent?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const signal = options.signal
        ? AbortSignal.any
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal
        : controller.signal;
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...this.headers,
          ...(options.idempotent ? { 'idempotency-key': idempotencyKey() } : {}),
        };
        const response = await this.fetcher(`${this.baseUrl}${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal,
        });
        const text = await response.text();
        let payload: unknown;
        if (text.length > 0) {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = text;
          }
        }
        if (!response.ok) {
          const error = (payload as { error?: Record<string, unknown> } | undefined)?.error;
          const apiError = new RevlyraApiError(
            response.status,
            typeof error?.code === 'string' ? error.code : `HTTP_${response.status}`,
            typeof error?.message === 'string' ? error.message : response.statusText,
            typeof error?.request_id === 'string' ? error.request_id : undefined,
            error?.details,
          );
          if ((response.status === 429 || response.status >= 500) && attempt < this.retries) {
            lastError = apiError;
            await sleep(200 * 2 ** attempt + Math.random() * 100);
            continue;
          }
          throw apiError;
        }
        return payload as T;
      } catch (error) {
        lastError = error;
        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (isAbort) throw new RevlyraApiError(408, 'REQUEST_TIMEOUT', 'Request timed out.');
        if (attempt < this.retries && !(error instanceof RevlyraApiError && error.status < 500)) {
          await sleep(200 * 2 ** attempt + Math.random() * 100);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  analyze(input: AnalyzeInput, signal?: AbortSignal): Promise<AnalyzeResponse> {
    return this.request('POST', '/reviews/analyze', input, { idempotent: true, signal });
  }

  analyzeBatch(input: BatchInput, signal?: AbortSignal): Promise<BatchResponse> {
    return this.request('POST', '/reviews/batch', input, { idempotent: true, signal });
  }

  ingest(
    input: BatchInput,
    signal?: AbortSignal,
  ): Promise<BatchResponse | { jobId: string; accepted: number; status: string }> {
    return this.request('POST', '/ingest/reviews', input, { idempotent: true, signal });
  }

  getReview(
    id: string,
    options: { includeText?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ review: ReviewSummary; result: AnalysisResult }> {
    const query = options.includeText ? '?includeText=1' : '';
    return this.request('GET', `/reviews/${encodeURIComponent(id)}${query}`, undefined, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  explain(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('GET', `/reviews/${encodeURIComponent(id)}/explain`, undefined, {
      ...(signal ? { signal } : {}),
    });
  }

  feedback(input: FeedbackInput, signal?: AbortSignal): Promise<{ id: string }> {
    return this.request('POST', '/feedback', input, { idempotent: true, signal });
  }

  createAppeal(input: AppealInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('POST', '/appeals', input, { idempotent: true, signal });
  }

  listAppeals(status?: 'open' | 'upheld' | 'overturned', signal?: AbortSignal) {
    const query = status ? `?status=${status}` : '';
    return this.request('GET', `/appeals${query}`, undefined, { ...(signal ? { signal } : {}) });
  }

  getReviewerRisk(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('GET', `/reviewers/${encodeURIComponent(id)}/risk`, undefined, {
      ...(signal ? { signal } : {}),
    });
  }

  getItemIntegrity(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ itemId: string; integrity: IntegrityResult }> {
    return this.request('GET', `/items/${encodeURIComponent(id)}/integrity`, undefined, {
      ...(signal ? { signal } : {}),
    });
  }

  selectReviews(
    id: string,
    options: SelectionOptions = {},
    signal?: AbortSignal,
  ): Promise<{ itemId: string; selection: SelectionResult }> {
    return this.request('POST', `/items/${encodeURIComponent(id)}/select`, options, {
      idempotent: true,
      ...(signal ? { signal } : {}),
    });
  }

  listCampaigns(limit = 100, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('GET', `/campaigns?limit=${limit}`, undefined, {
      ...(signal ? { signal } : {}),
    });
  }

  getCampaign(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('GET', `/campaigns/${encodeURIComponent(id)}`, undefined, {
      ...(signal ? { signal } : {}),
    });
  }

  scan(input: ScanInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('POST', '/scan', input, {
      idempotent: true,
      ...(signal ? { signal } : {}),
    });
  }

  getJob(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('GET', `/jobs/${encodeURIComponent(id)}`, undefined, {
      ...(signal ? { signal } : {}),
    });
  }

  getUsage(signal?: AbortSignal): Promise<UsageResponse> {
    return this.request('GET', '/usage', undefined, { ...(signal ? { signal } : {}) });
  }

  /**
   * DSA Art. 17 statement of reasons for a stored decision.
   */
  getStatementOfReasons(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request(
      'GET',
      `/reviews/${encodeURIComponent(id)}/statement-of-reasons`,
      undefined,
      { ...(signal ? { signal } : {}) },
    );
  }

  /**
   * DSA Art. 20 adjudication: record the human outcome for an appeal.
   * `handler` is the raw handler identity; the server stores only its HMAC.
   */
  adjudicateAppeal(
    id: string,
    input: { outcome: 'upheld' | 'overturned'; handler: string; reason?: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      `/appeals/${encodeURIComponent(id)}/adjudication`,
      {
        outcome: input.outcome,
        handlerHmac: input.handler,
        ...(input.reason ? { reason: input.reason } : {}),
      },
      { idempotent: true, ...(signal ? { signal } : {}) },
    );
  }

  /**
   * DSA Art. 16 notice and action: record an external notice against a review.
   */
  createNotice(
    input: {
      reviewId: string;
      type: 'complaint' | 'legal' | 'authority';
      claim: string;
      substantiated?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.request('POST', '/notices', input, { idempotent: true, signal });
  }

  listNotices(
    options: { status?: string; reviewId?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const parts: string[] = [];
    if (options.status) parts.push(`status=${encodeURIComponent(options.status)}`);
    if (options.reviewId) parts.push(`reviewId=${encodeURIComponent(options.reviewId)}`);
    if (options.limit) parts.push(`limit=${options.limit}`);
    const query = parts.length > 0 ? `?${parts.join('&')}` : '';
    return this.request('GET', `/notices${query}`, undefined, { ...(signal ? { signal } : {}) });
  }

  /**
   * Aggregate transparency and fairness report (requires the admin key).
   */
  transparencyReport(
    options: { days?: number; format?: 'json' | 'html' } = {},
    signal?: AbortSignal,
  ): Promise<string | Record<string, unknown>> {
    const parts: string[] = [];
    if (options.days) parts.push(`days=${options.days}`);
    if (options.format === 'html') parts.push('format=html');
    const query = parts.length > 0 ? `?${parts.join('&')}` : '';
    return this.request('GET', `/admin/transparency${query}`, undefined, {
      ...(signal ? { signal } : {}),
    });
  }

  health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('GET', '/health', undefined, { ...(signal ? { signal } : {}) });
  }

  version(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('GET', '/version', undefined, { ...(signal ? { signal } : {}) });
  }
}

export function createClient(options: ClientOptions): RevlyraClient {
  return new RevlyraClient(options);
}
