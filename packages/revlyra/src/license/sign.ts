import { sign } from 'node:crypto';
import type { LicensePayload } from './types';

/**
 * Internal/test helper. This is intentionally NOT exported from the package
 * entry point; production licenses are signed by the vendor control plane.
 */
export function signLicenseToken(
  payload: LicensePayload,
  privateKeyPem: string,
  prefix = 'rvlyra_lic_v1_',
): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const body = payloadBytes.toString('base64url');
  const signature = sign(null, payloadBytes, privateKeyPem).toString('base64url');
  return `${prefix}${body}.${signature}`;
}
