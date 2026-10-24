import { createHmac, timingSafeEqual } from 'node:crypto';
import { maskContacts } from '@revlyra/core';

export function hmacHex(pepper: string, value: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex');
}

export function scopedHmac(
  pepper: string,
  tenantId: string,
  kind: 'reviewer' | 'item' | 'review' | 'ip' | 'actor',
  value: string,
): string {
  return hmacHex(pepper, `${tenantId}:${kind}:${value}`);
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function normalizeIp(ip?: string): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice(7);
  return trimmed;
}

export function deriveSubnet(ip?: string): string | null {
  const normalized = normalizeIp(ip);
  if (!normalized) return null;
  if (normalized.includes(':')) {
    const groups = normalized.split(':').filter(Boolean);
    if (groups.length < 3) return null;
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  const parts = normalized.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

export function redactText(text: string): string {
  return maskContacts(text).text;
}

/**
 * Keys that would reintroduce proven real-world identity for pseudonymous
 * reviewers (the Glassdoor failure mode, doc 2.3: no retroactive identity
 * linking without explicit granular opt-in). Applied defensively to review
 * metadata before persistence.
 */
const IDENTITY_KEY_RE =
  /(^|_)(facebook|instagram|linkedin|twitter|glassdoor|fishbowl|profile|social)((_|profile)?url|link)?$|resum[eé]|cv$|passport|national.?id|social.?security|ssn|street.?address|date.?of.?birth|birthday|dob$/iu;
const IDENTITY_VALUE_RE = /@(linkedin|facebook|instagram)\./iu;

export function stripIdentityKeys(
  metadata: Record<string, unknown> | undefined,
  options?: { enabled?: boolean },
): { metadata: Record<string, unknown>; stripped: string[] } {
  if (!metadata || options?.enabled === false) {
    return { metadata: { ...(metadata ?? {}) }, stripped: [] };
  }
  const stripped: string[] = [];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (IDENTITY_KEY_RE.test(key)) {
      stripped.push(key);
      continue;
    }
    if (typeof value === 'string' && IDENTITY_VALUE_RE.test(value)) {
      stripped.push(key);
      continue;
    }
    result[key] = value;
  }
  return { metadata: result, stripped };
}

export function redactEvidence(
  evidence: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  if (!enabled) return evidence;
  const clone = JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return redactText(value)
        .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/giu, '[email]')
        .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/gu, '[phone]');
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        result[key] = walk(item);
      }
      return result;
    }
    return value;
  };
  return walk(clone) as Record<string, unknown>;
}

export function installIdFile(configDir: string): string {
  return `${configDir}/install-id`;
}
