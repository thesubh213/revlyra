import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { WebhookDispatcher } from '../src/server/webhooks';

const received: Array<{ headers: Record<string, string | undefined>; body: string }> = [];
let server: Server;
let port = 0;

function createDispatcher(secret?: string): WebhookDispatcher {
  const config = loadConfig({
    cwd: process.cwd(),
    overrides: { privacy: { pepper: 'x'.repeat(24) } },
  });
  config.webhooks = { url: `http://127.0.0.1:${port}/hook`, ...(secret ? { secret } : {}) };
  return new WebhookDispatcher(config);
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      response.writeHead(200);
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('WebhookDispatcher', () => {
  it('is disabled without both url and secret', () => {
    const config = loadConfig({});
    config.webhooks = { url: 'https://hooks.example' };
    expect(new WebhookDispatcher(config).enabled).toBe(false);
    config.webhooks = { secret: 's' };
    expect(new WebhookDispatcher(config).enabled).toBe(false);
    config.webhooks = { url: 'https://hooks.example', secret: 's' };
    expect(new WebhookDispatcher(config).enabled).toBe(true);
  });

  it('signs payloads as t=<unix>,v1=hmac(timestamp.body)', async () => {
    const dispatcher = createDispatcher('test-secret-1');
    expect(dispatcher.enabled).toBe(true);
    await dispatcher.emit('review.analyzed', { reviewId: 'r1' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const first = received.at(-1)!;
    const signature = first.headers['x-revlyra-signature'];
    expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/u);
    const parts = signature!.split(',');
    expect(parts[0]?.startsWith('t=')).toBe(true);
    const ts = parts[0]!.slice(2);
    const sig = parts[1]!.slice(3);
    const expected = await crypto.subtle
      .importKey(
        'raw',
        new TextEncoder().encode('test-secret-1'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
      .then((key) =>
        crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${first.body}`)),
      )
      .then((digest) => Buffer.from(digest).toString('hex'));
    expect(sig).toBe(expected);
    expect(first.headers['x-revlyra-event']).toBe('review.analyzed');
    const parsed = JSON.parse(first.body);
    expect(parsed.event).toBe('review.analyzed');
    expect(parsed.timestamp).toBe(Number(ts));
    expect(parsed.data.reviewId).toBe('r1');
  });

  it('drops events silently for malformed webhook urls', async () => {
    const before = received.length;
    const config = loadConfig({});
    config.webhooks = { url: '://|not-a-url', secret: 's' };
    const dispatcher = new WebhookDispatcher(config);
    expect(dispatcher.enabled).toBe(true);
    await dispatcher.emit('scan.queued', {});
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(received.length).toBe(before);
  });

  it('drops non-localhost http targets but allows loopback', async () => {
    let before = received.length;
    const config = loadConfig({});
    config.webhooks = { url: 'http://example.com/hook', secret: 's' };
    expect(new WebhookDispatcher(config).enabled).toBe(true);
    await new WebhookDispatcher(config).emit('test.external', { ok: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received.length).toBe(before);
    config.webhooks = { url: `http://127.0.0.1:${port}/hook`, secret: 's' };
    before = received.length;
    await new WebhookDispatcher(config).emit('test.allowed', { ok: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received.length).toBe(before + 1);
    expect(received.at(-1)?.headers['x-revlyra-event']).toBe('test.allowed');
  });
});
