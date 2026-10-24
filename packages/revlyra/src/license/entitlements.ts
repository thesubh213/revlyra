import type { LicenseStatus } from './types';

export class EntitlementError extends Error {
  readonly code = 'FEATURE_NOT_ENTITLED';

  constructor(
    message: string,
    readonly feature: string,
  ) {
    super(message);
    this.name = 'EntitlementError';
  }
}

export class Entitlements {
  readonly status: LicenseStatus;
  private readonly features: Set<string>;

  constructor(status: LicenseStatus) {
    this.status = status;
    this.features = new Set(status.features);
  }

  get valid(): boolean {
    return this.status.valid;
  }

  get tier(): string {
    return this.status.tier;
  }

  has(feature: string): boolean {
    if (!this.status.valid) return false;
    if (this.status.tier === 'enterprise') return true;
    return this.features.has(feature);
  }

  assert(feature: string): void {
    if (!this.has(feature)) {
      throw new EntitlementError(
        `The "${feature}" feature is not included in this license (tier: ${this.status.tier}).`,
        feature,
      );
    }
  }

  get reviewsPerMonth(): number {
    return this.status.limits.reviewsPerMonth;
  }

  get sources(): number {
    return this.status.limits.sources;
  }

  get rps(): number {
    return this.status.limits.rps;
  }

  get seats(): number {
    return this.status.limits.seats;
  }

  toJSON(): Record<string, unknown> {
    return {
      tier: this.status.tier,
      valid: this.status.valid,
      features: this.status.features,
      limits: this.status.limits,
      expiresAt: this.status.expiresAt,
      grace: this.status.grace,
      reason: this.status.reason,
    };
  }
}
