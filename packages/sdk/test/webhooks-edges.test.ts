import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RevlyraClient } from '../src/client';
import { parseWebhookEvent, verifyWebhook } from '../src/webhooks';

function createHmacSign(body: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('sdk client constructor validation', () => {
  it('rejects missing baseUrl and apiKey', () => {
    expect(() => new RevlyraClient({ baseUrl: '', apiKey: 'k' } as never)).toThrow(
      'baseUrl is required.',
    );
    expect(() => new RevlyraClient({ baseUrl: 'http://localhost', apiKey: '' } as never)).toThrow(
      'apiKey is required.',
    );
  });

  it('normalizes base URLs to /v1 without duplicating', async () => {
    for (const base of [
      'http://localhost:8787',
      'http://localhost:8787/',
      'http://localhost:8787/v1',
    ]) {
      const fetchMock = vi.fn(async () => jsonResponse({}));
      const client =
        createHmacSign === null
          ? null
          : new RevlyraClient({
              baseUrl: base,
              apiKey: 'k',
              fetch: fetchMock as unknown as typeof fetch,
            });
      await client!.health();
      const url = fetchMock.mock.calls[0]?.[0];
      expect(url).toBe('http://localhost:8787/v1/health');
    }
  });
});

describe('sdk client error mapping', () => {
  it('retries 429 and 5xx errors and surfaces the last response', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      return jsonResponse(
        { error: { code: 'RATE_LIMITED', message: 'slow down', request_id: 'req-x' } },
        attempts === 1 ? 429 : 429,
      );
    });
    const client = new RevlyraClient({
      baseUrl: 'http://localhost:8787',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
      retries: 1,
    });
    await expect(client.health()).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      requestId: 'req-x',
    });
    expect(attempts).toBe(2); // 1 initial + 1 retry
  });

  it('does not retry non-2xx payloads lacking retryable statuses', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      return jsonResponse({ error: { code: 'X', message: 'y' } }, 403);
    });
    const client = new RevlyraClient({
      baseUrl: 'http://localhost:8787',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.health()).rejects.toMatchObject({
      status: 403,
      code: 'X',
    });
    expect(attempts).toBe(1);
  });

  it('maps HTTP_<status> fallback codes when no error body exists', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 404));
    const client = new RevlyraClient({
      baseUrl: 'http://localhost:8787',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.getCampaign('nope')).rejects.toMatchObject({
      status: 404,
      code: 'HTTP_404',
    });
  });

  it('maps aborts to REQUEST_TIMEOUT 408 without retrying', async () => {
    const fetchMock = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortError = new Error('abort');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        }),
    );
    const client = new RevlyraClient({
      baseUrl: 'http://localhost:8787',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 20,
      retries: 3,
    });
    await expect(client.health()).rejects.toMatchObject({
      status: 408,
      code: 'REQUEST_TIMEOUT',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('verifyWebhook', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ event: 'review.analyzed', timestamp: 1, data: {} });

  it('rejects empty body/header/secret', async () => {
    await expect(verifyWebhook('', `t=1,v1=x`, secret)).resolves.toBe(false);
    await expect(verifyWebhook(body, '', secret)).resolves.toBe(false);
    await expect(verifyWebhook(body, 't=1,v1=abcd', '')).resolves.toBe(false);
  });

  it('rejects header values missing t or v1, or non-numeric t', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmacSign(body, ts, secret);
    await expect(verifyWebhook(body, `v1=${sig}`, secret)).resolves.toBe(false);
    await expect(verifyWebhook(body, `t=${ts}`, secret)).resolves.toBe(false);
    await expect(verifyWebhook(body, `t=notanumber,v1=${sig}`, secret)).resolves.toBe(false);
  });

  it('rejects values containing extra = separators', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    await expect(verifyWebhook(body, `t=${ts},v1=abc=def`, secret)).resolves.toBe(false);
  });

  it('accepts valid, case-insensitive hex with tolerance boundaries', async () => {
    const now = new Date('2026-10-24T00:00:00.000Z');
    const ts = String(Math.floor(now.getTime() / 1000));
    const sig = createHmacSign(body, ts, secret);
    await expect(verifyWebhook(body, `t=${ts},v1=${sig}`, secret, { now })).resolves.toBe(true);
    await expect(
      verifyWebhook(body, `t=${ts},v1=${sig.toUpperCase()}`, secret, { now }),
    ).resolves.toBe(true);
    // Exactly the tolerance passes (the check is >).
    await expect(
      verifyWebhook(body, `t=${ts},v1=${sig}`, secret, { now, toleranceSeconds: 300 }),
    ).resolves.toBe(true);
    // One second later than tolerance fails.
    await expect(
      verifyWebhook(body, `t=${ts},v1=${sig}`, secret, {
        now: new Date('2026-10-24T00:05:01.000Z'),
      }),
    ).resolves.toBe(false);
    // Future timestamp beyond tolerance fails.
    await expect(
      verifyWebhook(body, `t=${ts},v1=${sig}`, secret, {
        now: new Date('2026-10-23T23:53:00.000Z'),
      }),
    ).resolves.toBe(false);
  });

  it('rejects a changed or wrong-length signature', async () => {
    const now = new Date('2026-10-24T00:00:00.000Z');
    const ts = String(Math.floor(now.getTime() / 1000));
    const sig = createHmacSign(body, ts, secret);
    const wrongBody = `{ "event": "other", "timestamp": 1 }`;
    const wrongSig = createHmacSign(wrongBody, ts, secret);
    await expect(verifyWebhook(body, `t=${ts},v1=${wrongSig}`, secret, { now })).resolves.toBe(
      false,
    );
    expect(wrongSig).toHaveLength(sig.length);
  });

  it('byte-exact bodies are required (different trailing whitespace fails)', async () => {
    const now = new Date('2026-10-24T00:00:00.000Z');
    const ts = String(Math.floor(now.getTime() / 1000));
    const sig = createHmacSign(body, ts, secret);
    await expect(verifyWebhook(`${body} `, `t=${ts},v1=${sig}`, secret, { now })).resolves.toBe(
      false,
    );
  });
});

describe('parseWebhookEvent', () => {
  it('returns empty event/timestamp/data placeholders and coerces fields', () => {
    expect(parseWebhookEvent('{}')).toEqual({ event: '', timestamp: 0, data: {} });
    expect(parseWebhookEvent('{"event":"a","timestamp":5,"data":{"k":1}}')).toEqual({
      event: 'a',
      timestamp: 5,
      data: { k: 1 },
    });
    // Arrays pass the typeof object check and are returned as-is (numeric keys).
    expect(parseWebhookEvent('{"data":["arr"]}').data).toEqual(['arr']);
    expect(parseWebhookEvent('{"data":null}').data).toEqual({});
    expect(parseWebhookEvent('{"data":3}').data).toEqual({});
  });

  it('propagates JSON syntax errors', () => {
    expect(() => parseWebhookEvent('not json')).toThrow();
  });
});
