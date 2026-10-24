export type LicenseTier = 'dev' | 'pro' | 'enterprise';
export type LicenseKind = 'dev' | 'license' | 'lease' | 'none';

export interface LicenseLimits {
  reviewsPerMonth: number;
  sources: number;
  rps: number;
  seats: number;
}

export interface LicensePayload {
  sub: string;
  tier: LicenseTier;
  features: string[];
  limits: LicenseLimits;
  iat: number;
  nbf?: number;
  exp: number;
  jti: string;
  kid?: string;
  licenseJti?: string;
  installIdHash?: string;
}

export interface LicenseStatus {
  valid: boolean;
  kind: LicenseKind;
  tier: LicenseTier;
  subject: string;
  features: string[];
  limits: LicenseLimits;
  expiresAt?: string;
  issuedAt?: string;
  jti?: string;
  grace: boolean;
  reason?: string;
}

export const DEV_LIMITS: LicenseLimits = {
  reviewsPerMonth: 10_000,
  sources: 3,
  rps: 10,
  seats: 1,
};

export const DEV_FEATURES = [
  'server',
  'sdk',
  'api_access',
  'webhooks',
  'media',
  'campaigns',
  'graph',
];

export const PRO_LIMITS: LicenseLimits = {
  reviewsPerMonth: 1_000_000,
  sources: 25,
  rps: 100,
  seats: 10,
};

export const ENTERPRISE_LIMITS: LicenseLimits = {
  reviewsPerMonth: 100_000_000,
  sources: 500,
  rps: 1_000,
  seats: 1_000,
};

export const ALL_FEATURES = [
  'server',
  'sdk',
  'api_access',
  'webhooks',
  'media',
  'campaigns',
  'graph',
  'transformer',
  'postgres',
  'multi_tenant',
  'audit_export',
  'retention_custom',
  'campaign_actions',
  'sso',
];
