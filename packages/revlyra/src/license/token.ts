import { verify } from 'node:crypto';
import { z } from 'zod';
import { DEV_LIMITS, type LicenseKind, type LicensePayload, type LicenseStatus } from './types';

export const LICENSE_PREFIX = 'rvlyra_lic_v1_';
export const LEASE_PREFIX = 'rvlyra_lease_v1_';

const limitsSchema = z.object({
  reviewsPerMonth: z.number().int().nonnegative(),
  sources: z.number().int().nonnegative(),
  rps: z.number().int().positive(),
  seats: z.number().int().positive(),
});

export const licensePayloadSchema = z.object({
  sub: z.string().min(1),
  tier: z.enum(['dev', 'pro', 'enterprise']),
  features: z.array(z.string()),
  limits: limitsSchema,
  iat: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative().optional(),
  exp: z.number().int().positive(),
  jti: z.string().min(1),
  kid: z.string().optional(),
  licenseJti: z.string().optional(),
  installIdHash: z.string().optional(),
});

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export interface ParsedToken {
  prefix: string;
  payload: LicensePayload;
  payloadBuffer: Buffer;
  signature: Buffer;
}

export function parseLicenseToken(token: string, prefix = LICENSE_PREFIX): ParsedToken {
  if (!token.startsWith(prefix)) {
    throw new Error('LICENSE_PREFIX_INVALID');
  }
  const body = token.slice(prefix.length);
  const [payloadPart, signaturePart, extra] = body.split('.');
  if (!payloadPart || !signaturePart || extra !== undefined) {
    throw new Error('LICENSE_FORMAT_INVALID');
  }
  const payloadBuffer = decodeBase64Url(payloadPart);
  let payload: LicensePayload;
  try {
    payload = licensePayloadSchema.parse(JSON.parse(payloadBuffer.toString('utf8')));
  } catch {
    throw new Error('LICENSE_PAYLOAD_INVALID');
  }
  return {
    prefix,
    payload,
    payloadBuffer,
    signature: decodeBase64Url(signaturePart),
  };
}

export function verifySignedToken(
  token: string,
  publicKeyPem: string,
  options: { prefix?: string; now?: Date } = {},
): LicensePayload {
  const parsed = parseLicenseToken(token, options.prefix ?? LICENSE_PREFIX);
  let valid = false;
  try {
    valid = verify(null, parsed.payloadBuffer, publicKeyPem, parsed.signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new Error('LICENSE_SIGNATURE_INVALID');

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (parsed.payload.nbf !== undefined && nowSeconds < parsed.payload.nbf) {
    throw new Error('LICENSE_NOT_YET_VALID');
  }
  if (parsed.payload.exp <= nowSeconds) throw new Error('LICENSE_EXPIRED');
  return parsed.payload;
}

export function statusFromPayload(
  payload: LicensePayload,
  kind: 'license' | 'lease',
  grace = false,
): LicenseStatus {
  return {
    valid: true,
    kind,
    tier: payload.tier,
    subject: payload.sub,
    features: payload.features,
    limits: payload.limits,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    issuedAt: new Date(payload.iat * 1000).toISOString(),
    jti: payload.jti,
    grace,
  };
}

export function invalidStatus(reason: string, kind: LicenseKind = 'license'): LicenseStatus {
  return {
    valid: false,
    kind,
    tier: 'dev',
    subject: '',
    features: [],
    limits: DEV_LIMITS,
    grace: false,
    reason,
  };
}
