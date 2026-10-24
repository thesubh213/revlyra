import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RestSource } from '../src/sources/rest';

let lastHeaders: Record<string, unknown> = {};
let server: Server;
let port = 0;

const items = Array.from({ length: 7 }, (_, i) => ({
  id: `r${i}`,
  item_id: `p${i % 3}`,
  reviewer_id: `u${i}`,
  rating: (i % 5) + 1,
  text: `rest review number ${i} and the battery worked`,
}));

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    // Header-echo endpoint for auth checks (server records the headers).
    if (path === '/headers') {
      lastHeaders = {
        auth: request.headers.authorization ?? null,
        custom: request.headers['x-custom'] ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { items: [items[0]] } }));
      return;
    }

    const cursor = url.searchParams.get('cursor');
    let offset = 0;
    if (url.searchParams.get('offset') !== null) {
      offset = Number(url.searchParams.get('offset') ?? 0);
    } else if (url.searchParams.get('page') !== null) {
      offset = (Number(url.searchParams.get('page') ?? 1) - 1) * 3;
    } else if (cursor !== null) {
      offset = Number(cursor ?? 0);
    }

    const slice = items.slice(offset, offset + 3);
    const next = offset + 3 < items.length ? String(offset + 3) : null;
    response.setHeader('content-type', 'application/json');
    if (path === '/error') {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { code: 'BOOM', message: 'Boom happened' } }));
      return;
    }
    if (path === '/notjson') {
      response.setHeader('content-type', 'text/plain');
      response.end('plain text body');
      return;
    }
    if (path === '/teapot') {
      response.statusCode = 418;
      response.end(JSON.stringify({}));
      return;
    }
    response.end(JSON.stringify({ data: { items: slice }, next }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function paginate(mode: 'offset' | 'cursor' | 'none') {
  return new RestSource(`rest-${mode}`, {
    url: `http://127.0.0.1:${port}/reviews`,
    allowPrivateHosts: true,
    pagination:
      mode === 'offset'
        ? { mode: 'offset', offsetParam: 'offset', limitParam: 'limit', pageSize: 3, maxPages: 10 }
        : mode === 'cursor'
          ? {
              mode: 'cursor',
              cursorParam: 'cursor',
              nextField: 'next',
              limitParam: 'limit',
              pageSize: 3,
              maxPages: 10,
            }
          : { mode: 'none', limitParam: 'limit', pageSize: 3, maxPages: 10 },
    itemsPath: 'data.items',
  });
}

describe('REST pagination modes', () => {
  it('offset mode walks until fewer than pageSize items return', async () => {
    const pulled = [];
    for await (const item of paginate('offset').pull()) pulled.push(item);
    expect(pulled).toHaveLength(7);
  });

  it('cursor mode follows nextField', async () => {
    const pulled = [];
    for await (const item of paginate('cursor').pull()) pulled.push(item);
    expect(pulled).toHaveLength(7);
  });

  it('none mode stops after the first page', async () => {
    const pulled = [];
    for await (const item of paginate('none').pull()) pulled.push(item);
    expect(pulled).toHaveLength(3);
  });

  it('limit trims the pulled set (client limit)', async () => {
    const pulled = [];
    for await (const item of paginate('offset').pull({ limit: 4 })) pulled.push(item);
    expect(pulled).toHaveLength(4);
  });

  it('maxPages caps the number of HTTP pages', async () => {
    const source = new RestSource('rest-maxpages', {
      url: `http://127.0.0.1:${port}/reviews`,
      allowPrivateHosts: true,
      pagination: { mode: 'offset', offsetParam: 'offset', pageSize: 3, maxPages: 2 },
      itemsPath: 'data.items',
    });
    const pulled = [];
    for await (const item of source.pull()) pulled.push(item);
    expect(pulled).toHaveLength(6);
  });
});

describe('REST auth modes', () => {
  it('sends bearer, basic, and custom header auth and a default UA', async () => {
    // bearer
    const bearer = new RestSource('rest-auth-b', {
      url: `http://127.0.0.1:${port}/headers`,
      allowPrivateHosts: true,
      auth: { type: 'bearer', token: 'tok-1' },
      itemsPath: 'data.items',
      pagination: { mode: 'none' },
    });
    await collect(bearer.pull());
    expect(lastHeaders.auth).toBe('Bearer tok-1');

    // basic
    const basic = new RestSource('rest-auth-c', {
      url: `http://127.0.0.1:${port}/headers`,
      allowPrivateHosts: true,
      auth: { type: 'basic', username: 'user', password: 'pass' },
      itemsPath: 'data.items',
      pagination: { mode: 'none' },
    });
    await collect(basic.pull());
    expect(lastHeaders.auth).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);

    // custom header
    const header = new RestSource('rest-auth-d', {
      url: `http://127.0.0.1:${port}/headers`,
      allowPrivateHosts: true,
      auth: { type: 'header', headerName: 'X-Custom', token: 'custom-tok' },
      itemsPath: 'data.items',
      pagination: { mode: 'none' },
    });
    await collect(header.pull());
    expect(lastHeaders.custom).toBe('custom-tok');
    // default UA when not overridden
    expect(lastHeaders.userAgent).toContain('revlyra');
  });
});

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}
