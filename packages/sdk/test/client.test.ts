import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createClient, RevlyraApiError } from '../src/client';
import { parseWebhookEvent, verifyWebhook } from '../src/webhooks';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('sdk client', () => {
  it('calls the API with auth and normalizes the base URL', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ reviewId: 'r1', score: 0.1, decision: 'allow' }),
    );
    const client = createClient({
      baseUrl: 'http://localhost:8787/',
      apiKey: 'rvlyra_live_test',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const response = await client.analyze({
      review: {
        itemId: 'p1',
        reviewerId: 'u1',
        rating: 5,
        text: 'Great',
        submittedAt: '2026-10-20T10:00:00Z',
      },
    });
    expect(response.reviewId).toBe('r1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8787/v1/reviews/analyze');
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer rvlyra_live_test',
    });
    expect((init as RequestInit).headers).toHaveProperty('idempotency-key');
  });

  it('maps API errors and does not retry client errors', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'VALIDATION_ERROR', message: 'bad', request_id: 'req-1' } },
        400,
      ),
    );
    const client = createClient({
      baseUrl: 'http://localhost:8787',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      client.analyze({
        review: {
          itemId: 'p1',
          reviewerId: 'u1',
          rating: 5,
          text: 'x',
          submittedAt: '2026-10-20T10:00:00Z',
        },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      requestId: 'req-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries server errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'INTERNAL' } }, 500))
      .mockResolvedValueOnce(jsonResponse({ itemId: 'p1', integrity: { rawRating: 4 } }));
    const client = createClient({
      baseUrl: 'http://localhost:8787',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
      retries: 1,
    });
    const result = await client.getItemIntegrity('p1');
    expect(result.itemId).toBe('p1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('supports the DSA governance endpoints', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ spec: 'revlyra.sor/0.1', reviewId: 'r1' }));
    const client = createClient({
      baseUrl: 'http://localhost:8787',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.getStatementOfReasons('r1');
    expect(fetchMock.mock.lastCall?.[0]).toBe(
      'http://localhost:8787/v1/reviews/r1/statement-of-reasons',
    );

    await client.adjudicateAppeal('a1', { outcome: 'overturned', handler: 'staffer-42' });
    const [, adjudicationInit] = fetchMock.mock.calls[1]!;
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:8787/v1/appeals/a1/adjudication');
    expect(JSON.parse(String(adjudicationInit?.body))).toMatchObject({
      outcome: 'overturned',
      handlerHmac: 'staffer-42',
    });

    await client.createNotice({
      reviewId: 'r1',
      type: 'complaint',
      claim: 'the statement is inaccurate',
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('http://localhost:8787/v1/notices');
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      type: 'complaint',
    });

    await client.listNotices({ status: 'received', limit: 5 });
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      'http://localhost:8787/v1/notices?status=received&limit=5',
    );

    await client.transparencyReport({ days: 30, format: 'json' });
    expect(fetchMock.mock.calls[4]?.[0]).toBe(
      'http://localhost:8787/v1/admin/transparency?days=30',
    );
  });
});

describe('webhook verification', () => {
  it('verifies a correctly signed payload and rejects tampering/expiry', async () => {
    const secret = 'whsec_test';
    const body = JSON.stringify({
      event: 'review.flagged',
      timestamp: 1700000000,
      data: { id: 'r1' },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const header = `t=${timestamp},v1=${signature}`;

    await expect(verifyWebhook(body, header, secret)).resolves.toBe(true);
    await expect(verifyWebhook(`${body} `, header, secret)).resolves.toBe(false);
    await expect(
      verifyWebhook(body, header, secret, { now: new Date((timestamp + 10_000) * 1000) }),
    ).resolves.toBe(false);

    expect(parseWebhookEvent(body).event).toBe('review.flagged');
  });

  it('exposes a typed API error class', () => {
    const error = new RevlyraApiError(429, 'RATE_LIMITED', 'slow down', 'req-2');
    expect(error.status).toBe(429);
    expect(error.code).toBe('RATE_LIMITED');
  });
});
