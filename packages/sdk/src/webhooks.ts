function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

export interface VerifyWebhookOptions {
  toleranceSeconds?: number;
  now?: Date;
}

/**
 * Verifies `X-Revlyra-Signature: t=<unix>,v1=<hex>` using Web Crypto.
 * Works in Node, browsers, and edge runtimes.
 */
export async function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<boolean> {
  if (!rawBody || !signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader
      .split(',')
      .map((part) => part.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2),
  ) as Record<string, string>;
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature) return false;

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));
  return constantTimeEqual(toHex(digest), signature.toLowerCase());
}

export function parseWebhookEvent(rawBody: string): {
  event: string;
  timestamp: number;
  data: Record<string, unknown>;
} {
  const parsed = JSON.parse(rawBody) as {
    event?: unknown;
    timestamp?: unknown;
    data?: unknown;
  };
  return {
    event: String(parsed.event ?? ''),
    timestamp: Number(parsed.timestamp ?? 0),
    data:
      parsed.data && typeof parsed.data === 'object'
        ? (parsed.data as Record<string, unknown>)
        : {},
  };
}
