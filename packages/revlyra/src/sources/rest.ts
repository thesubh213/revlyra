import { getPath, mapRecord, resolveMapping } from './mapping';
import { assertSafeHttpUrl } from './safe-url';
import type {
  PullOptions,
  ReviewSource,
  SourceMapping,
  SourceReview,
  SourceTestResult,
} from './types';

export interface RestSourceConfig {
  url: string;
  method?: 'GET';
  headers?: Record<string, string>;
  auth?:
    | { type: 'bearer'; token?: string; tokenRef?: string }
    | {
        type: 'basic';
        username?: string;
        password?: string;
        usernameRef?: string;
        passwordRef?: string;
      }
    | { type: 'header'; headerName: string; token?: string; tokenRef?: string };
  pagination?: {
    mode?: 'cursor' | 'page' | 'offset' | 'none';
    cursorParam?: string;
    nextField?: string;
    pageParam?: string;
    offsetParam?: string;
    limitParam?: string;
    pageSize?: number;
    startPage?: number;
    startOffset?: number;
    maxPages?: number;
  };
  itemsPath?: string;
  allowPrivateHosts?: boolean;
  mapping?: SourceMapping;
}

function envValue(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return process.env[ref];
}

function buildHeaders(config: RestSourceConfig): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'revlyra/0.1 (+https://revlyra.dev)',
    ...(config.headers ?? {}),
  };
  const auth = config.auth;
  if (auth?.type === 'bearer') {
    const token = auth.token ?? envValue(auth.tokenRef);
    if (!token) throw new Error('REST auth token missing.');
    headers.authorization = `Bearer ${token}`;
  } else if (auth?.type === 'basic') {
    const username = auth.username ?? envValue(auth.usernameRef);
    const password = auth.password ?? envValue(auth.passwordRef);
    if (!username || !password) throw new Error('REST basic auth credentials missing.');
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  } else if (auth?.type === 'header') {
    const token = auth.token ?? envValue(auth.tokenRef);
    if (!token) throw new Error('REST header auth token missing.');
    headers[auth.headerName.toLowerCase()] = token;
  }
  delete headers.host;
  delete headers['content-length'];
  return headers;
}

function extractItems(payload: unknown, path?: string): unknown[] {
  if (!path) {
    if (Array.isArray(payload)) return payload;
    for (const candidate of ['data', 'items', 'results', 'reviews']) {
      const value = (payload as Record<string, unknown> | null)?.[candidate];
      if (Array.isArray(value)) return value;
    }
    return [];
  }
  const value = getPath(payload, path);
  return Array.isArray(value) ? value : [];
}

function withParams(url: URL, params: Record<string, string | number | undefined>): URL {
  const next = new URL(url.toString());
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) next.searchParams.set(key, String(value));
  }
  return next;
}

export class RestSource implements ReviewSource {
  readonly kind = 'rest';
  readonly id: string;
  private readonly config: RestSourceConfig;

  constructor(id: string, config: RestSourceConfig) {
    this.id = id;
    this.config = config;
  }

  capabilities = {
    incremental: true,
    reviewerHistory: false,
    media: true,
    context: false,
  };

  private async fetchPage(url: URL): Promise<unknown> {
    await assertSafeHttpUrl(url.toString(), {
      allowPrivateHosts: this.config.allowPrivateHosts ?? false,
    });
    const response = await fetch(url, {
      method: this.config.method ?? 'GET',
      headers: buildHeaders(this.config),
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`REST_SOURCE_HTTP_${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      throw new Error(`REST_SOURCE_CONTENT_TYPE_UNSUPPORTED:${contentType}`);
    }
    return response.json();
  }

  async test(): Promise<SourceTestResult> {
    try {
      const url = await assertSafeHttpUrl(this.config.url, {
        allowPrivateHosts: this.config.allowPrivateHosts ?? false,
      });
      const payload = await this.fetchPage(url);
      const items = extractItems(payload, this.config.itemsPath);
      const sample =
        items.length > 0
          ? mapRecord(items[0], resolveMapping(this.config.mapping, items[0]), this.kind)
          : null;
      return { ok: true, sampleCount: items.length, sample };
    } catch (error) {
      return { ok: false, sampleCount: 0, message: String(error), sample: null };
    }
  }

  async *pull(options: PullOptions = {}): AsyncIterable<SourceReview> {
    const base = await assertSafeHttpUrl(this.config.url, {
      allowPrivateHosts: this.config.allowPrivateHosts ?? false,
    });
    const pagination = this.config.pagination ?? {};
    const mode = pagination.mode ?? 'none';
    const pageSize = Math.max(1, Math.min(pagination.pageSize ?? 100, 1000));
    const maxPages = Math.max(1, Math.min(pagination.maxPages ?? 100, 1000));
    const hardLimit = Math.min(options.limit ?? Number.POSITIVE_INFINITY, 1_000_000);

    let page = pagination.startPage ?? 1;
    let offset = pagination.startOffset ?? 0;
    let cursor: string | undefined;
    let emitted = 0;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      if (options.signal?.aborted) throw new Error('PULL_ABORTED');
      const params: Record<string, string | number | undefined> = {};
      if (mode === 'cursor' && cursor) {
        params[pagination.cursorParam ?? 'cursor'] = cursor;
      } else if (mode === 'page') {
        params[pagination.pageParam ?? 'page'] = page;
      } else if (mode === 'offset') {
        params[pagination.offsetParam ?? 'offset'] = offset;
      }
      if (mode !== 'none') {
        params[pagination.limitParam ?? 'limit'] = Math.min(
          pageSize,
          Number.isFinite(hardLimit) ? Math.max(0, hardLimit - emitted) : pageSize,
        );
      }

      const payload = await this.fetchPage(withParams(base, params));
      const items = extractItems(payload, this.config.itemsPath);
      if (items.length === 0) break;

      for (const item of items) {
        if (emitted >= hardLimit) return;
        yield mapRecord(item, resolveMapping(this.config.mapping, item), this.kind);
        emitted += 1;
      }

      if (mode === 'cursor') {
        const next = pagination.nextField
          ? getPath(payload, pagination.nextField)
          : (payload as Record<string, unknown> | null)?.nextCursor;
        if (next === undefined || next === null || next === '') break;
        cursor = String(next);
      } else if (mode === 'page') {
        page += 1;
      } else if (mode === 'offset') {
        offset += items.length;
      } else {
        break;
      }
      if (items.length < pageSize) break;
    }
  }
}
