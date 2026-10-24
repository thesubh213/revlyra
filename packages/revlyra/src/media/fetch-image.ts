import { assertSafeHttpUrl } from '../sources/safe-url';

const MAX_BYTES = 10 * 1024 * 1024;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface FetchedImage {
  buffer: Buffer;
  mime: string;
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > maxBytes) throw new Error('MEDIA_TOO_LARGE');
  if (!response.body) throw new Error('MEDIA_EMPTY');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('MEDIA_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export async function fetchImage(
  source: string,
  options: { allowPrivateHosts?: boolean; maxBytes?: number } = {},
): Promise<FetchedImage> {
  const maxBytes = Math.min(options.maxBytes ?? MAX_BYTES, MAX_BYTES);

  if (source.startsWith('data:')) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/u.exec(source);
    if (!match) throw new Error('MEDIA_DATA_URL_INVALID');
    const mime = match[1]!;
    const buffer = Buffer.from(match[2]!, 'base64');
    if (buffer.byteLength > maxBytes) throw new Error('MEDIA_TOO_LARGE');
    return { buffer, mime };
  }

  let url = await assertSafeHttpUrl(source, {
    allowPrivateHosts: options.allowPrivateHosts ?? false,
  });
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'image/*' },
    });
    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('MEDIA_REDIRECT_WITHOUT_LOCATION');
      url = await assertSafeHttpUrl(new URL(location, url).toString(), {
        allowPrivateHosts: options.allowPrivateHosts ?? false,
      });
      continue;
    }
    if (!response.ok) throw new Error(`MEDIA_HTTP_${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new Error(`MEDIA_CONTENT_TYPE_UNSUPPORTED:${contentType}`);
    }
    const buffer = await readLimited(response, maxBytes);
    return { buffer, mime: contentType.split(';')[0]! };
  }
  throw new Error('MEDIA_TOO_MANY_REDIRECTS');
}
