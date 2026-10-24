import type { AnalysisContext, CanonicalReview, FeatureSet } from '../types';
import { clamp } from './content';
import { HEADLESS_UA_RE } from './lexicons';

export function deriveSubnet(ip?: string): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (trimmed.includes(':')) {
    const groups = trimmed.split(':').filter(Boolean);
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  const parts = trimmed.split('.');
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

export function extractNetworkFeatures(
  review: CanonicalReview,
  analysis: AnalysisContext,
): FeatureSet {
  const context = review.context ?? {};
  const reviewer = analysis.reviewer;
  const subnet = context.subnet ?? deriveSubnet(context.ip) ?? null;

  const accountsOnDevice = context.recentAccountsOnDevice ?? reviewer?.sharedDeviceCount ?? 0;
  const accountsOnSubnet = context.recentAccountsOnSubnet ?? reviewer?.sharedSubnetCount ?? 0;

  const headless =
    context.headlessUserAgent === true ||
    (context.userAgent ? HEADLESS_UA_RE.test(context.userAgent) : false);

  const localeMismatch =
    context.localeMismatch === true ||
    (context.locale !== undefined &&
      review.language !== undefined &&
      !context.locale.toLowerCase().startsWith(review.language.slice(0, 2).toLowerCase()) &&
      review.language !== 'und');

  return {
    'net.ipPresent': context.ip ? 1 : 0,
    'net.subnetPresent': subnet ? 1 : 0,
    'net.devicePresent': context.deviceId ? 1 : 0,
    'net.accountsOnDevice': accountsOnDevice,
    'net.accountsOnSubnet': accountsOnSubnet,
    'net.deviceReuse': clamp(accountsOnDevice / 5),
    'net.subnetReuse': clamp(accountsOnSubnet / 20),
    'net.headless': headless ? 1 : 0,
    'net.datacenter': context.isDatacenterAsn === true ? 1 : 0,
    'net.localeMismatch': localeMismatch ? 1 : 0,
    'net.reviewsOnSubnet': context.recentReviewsOnSubnet ?? 0,
    'net.subnetConcentration': clamp((context.recentReviewsOnSubnet ?? 0) / 100),
  };
}
