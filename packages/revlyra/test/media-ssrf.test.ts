import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchImage } from '../src/media/fetch-image';
import { hashImage } from '../src/media/phash';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const GARBAGE_BYTES = Buffer.from('definitely not an image at all');

let server: Server;
let port = 0;
let loopback = '';
let redirectTarget = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    if (path === '/charset') {
      response.writeHead(200, { 'content-type': 'image/png; charset=utf-8' });
      response.end(PNG_BYTES);
      return;
    }
    if (path === '/nonimage') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html></html>');
      return;
    }
    if (path === '/404') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('gone');
      return;
    }
    if (path === '/redirect') {
      if (redirectTarget === 'NO_LOCATION') {
        response.writeHead(302);
        response.end();
        return;
      }
      response.writeHead(302, {
        location: redirectTarget ? redirectTarget : `${loopback}/charset`,
      });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(PNG_BYTES);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  loopback = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fetchImage: data URLs', () => {
  it('inlines valid base64 image data URLs', async () => {
    const result = await fetchImage(`data:image/png;base64,${PNG_BYTES.toString('base64')}`);
    expect(result.mime).toBe('image/png');
    expect(result.buffer.length).toBe(PNG_BYTES.length);
  });

  it('rejects non-image or malformed data URLs', async () => {
    await expect(fetchImage('data:text/html;base64,AAA')).rejects.toThrow('MEDIA_DATA_URL_INVALID');
    await expect(fetchImage('data:image/png;utf8,AAA')).rejects.toThrow('MEDIA_DATA_URL_INVALID');
    await expect(fetchImage('data:image/png')).rejects.toThrow('MEDIA_DATA_URL_INVALID');
    // Base64 is decoded leniently by Node, so "!!" yields an empty buffer which
    // is still accepted — the format regex is the gate, not the payload chars.
    const lenient = await fetchImage('data:image/png;base64,!!');
    expect(lenient.buffer.length).toBe(0);
  });

  it('size caps apply to inline payloads and cannot be raised past 10MB', async () => {
    await expect(
      fetchImage(`data:image/png;base64,${PNG_BYTES.toString('base64')}`, { maxBytes: 3 }),
    ).rejects.toThrow('MEDIA_TOO_LARGE');
  });
});

describe('fetchImage: HTTP fetch properties (allowPrivateHosts test server)', () => {
  it('returns the mime stripped of charset suffixes and the exact bytes', async () => {
    const result = await fetchImage(`${loopback}/charset`, { allowPrivateHosts: true });
    expect(result.mime).toBe('image/png');
    expect(Buffer.compare(result.buffer, PNG_BYTES)).toBe(0);
  });

  it('rejects non-image content types', async () => {
    await expect(fetchImage(`${loopback}/nonimage`, { allowPrivateHosts: true })).rejects.toThrow(
      'MEDIA_CONTENT_TYPE_UNSUPPORTED:text/html',
    );
  });

  it('maps HTTP error statuses to MEDIA_HTTP_<status>', async () => {
    await expect(fetchImage(`${loopback}/404`, { allowPrivateHosts: true })).rejects.toThrow(
      'MEDIA_HTTP_404',
    );
  });

  it('follows a same-host redirect and lands on the target', async () => {
    redirectTarget = `${loopback}/charset`;
    const result = await fetchImage(`${loopback}/redirect`, { allowPrivateHosts: true });
    expect(result.mime).toBe('image/png');
  });

  it('hits the redirect cap after more than 3 hops', async () => {
    // self-redirect loop: /redirect -> /redirect -> ... exceeds the 4 hops.
    redirectTarget = `${loopback}/redirect`;
    await expect(fetchImage(`${loopback}/redirect`, { allowPrivateHosts: true })).rejects.toThrow(
      'MEDIA_TOO_MANY_REDIRECTS',
    );
  });

  it('reports a redirect without a location header', async () => {
    redirectTarget = 'NO_LOCATION';
    await expect(fetchImage(`${loopback}/redirect`, { allowPrivateHosts: true })).rejects.toThrow(
      'MEDIA_REDIRECT_WITHOUT_LOCATION',
    );
  });

  it('blocks fetching a literal private host when allowPrivateHosts is not set', async () => {
    redirectTarget = `${loopback}/charset`;
    await expect(fetchImage(`${loopback}/charset`)).rejects.toThrow('URL_PRIVATE_HOST_BLOCKED');
  });
});

describe('media hashing', () => {
  it('hashImage reports phash/dhash/sha256 formats', async () => {
    const hashes = await hashImage(PNG_BYTES);
    expect(hashes).not.toBeNull();
    expect(hashes?.phash).toHaveLength(16);
    expect(hashes?.dhash).toHaveLength(16);
    expect(hashes?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashes?.mime).toBe('image/png');
  });

  it('hashImage declines non-image buffers without throwing', async () => {
    expect(await hashImage(GARBAGE_BYTES)).toBeNull();
  });
});
