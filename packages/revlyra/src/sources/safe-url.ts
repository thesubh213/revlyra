import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPrivateIp(value: string): boolean {
  if (isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    const [a, b] = parts;
    if (a === undefined || b === undefined) return true;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 198 && b >= 18 && b <= 19) ||
      a >= 224
    );
  }
  if (isIP(value) === 6) {
    const lower = value.toLowerCase();
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:192.168.')
    );
  }
  return true;
}

export async function assertSafeHttpUrl(
  raw: string,
  options: { allowPrivateHosts?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL_INVALID');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('URL_PROTOCOL_BLOCKED');
  }
  if (url.username || url.password) {
    throw new Error('URL_CREDENTIALS_BLOCKED');
  }
  if (options.allowPrivateHosts) return url;

  const host = url.hostname;
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('URL_PRIVATE_HOST_BLOCKED');
    return url;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('URL_PRIVATE_HOST_BLOCKED');
  }
  const records = await lookup(host, { all: true, verbatim: true });
  if (records.length === 0) throw new Error('URL_DNS_EMPTY');
  if (records.some((record) => isPrivateIp(record.address))) {
    throw new Error('URL_PRIVATE_HOST_BLOCKED');
  }
  return url;
}

export function isPrivateIpForTests(value: string): boolean {
  return isPrivateIp(value);
}
