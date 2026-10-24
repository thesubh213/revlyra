import { describe, expect, it } from 'vitest';
import { type CanonicalReview, extractNetworkFeatures } from '../src';
import { deriveSubnet } from '../src/features/network';

function review(context?: CanonicalReview['context'], language = 'en'): CanonicalReview {
  return {
    id: 'r',
    itemId: 'i',
    reviewerId: 'u',
    rating: 5,
    text: 'text',
    submittedAt: '2026-10-24T10:00:00.000Z',
    language,
    context,
  };
}

describe('deriveSubnet', () => {
  it('null for missing/empty/hostname inputs', () => {
    expect(deriveSubnet(undefined)).toBeNull();
    expect(deriveSubnet('')).toBeNull();
    expect(deriveSubnet('example.com')).toBeNull();
    expect(deriveSubnet('10.1.2')).toBeNull();
    expect(deriveSubnet('10.1.2.3.4')).toBeNull();
  });

  it('masks IPv4 to a /24', () => {
    expect(deriveSubnet('203.0.113.55')).toBe('203.0.113.0/24');
    expect(deriveSubnet('10.0.0.1')).toBe('10.0.0.0/24');
    expect(deriveSubnet(' 10.1.2.3 ')).toBe('10.1.2.0/24');
  });

  it('masks IPv6 to the first three groups + ::/48 (empty groups filtered)', () => {
    expect(deriveSubnet('2606:4700:4700::1111')).toBe('2606:4700:4700::/48');
    expect(deriveSubnet('fe80::1')).toBe('fe80:1::/48');
    // "::1" keeps only the non-empty group `1` -> "1::/48".
    expect(deriveSubnet('::1')).toBe('1::/48');
    expect(deriveSubnet('::ffff:10.0.0.5')).toBe('ffff:10.0.0.5::/48');
  });
});

describe('extractNetworkFeatures', () => {
  it('marks signal presence flags from the context', () => {
    const f = extractNetworkFeatures(
      review({ ip: '203.0.113.9', deviceId: 'dev-1', subnet: '203.0.113.0/24' }),
      {},
    );
    expect(f['net.ipPresent']).toBe(1);
    expect(f['net.subnetPresent']).toBe(1);
    expect(f['net.devicePresent']).toBe(1);
  });

  it('derives the subnet from the IP when not explicit', () => {
    const f = extractNetworkFeatures(review({ ip: '198.51.100.4' }), {});
    expect(f['net.subnetPresent']).toBe(1);
  });

  it('prefers recent-account context counts over reviewer shared counts', () => {
    const f = extractNetworkFeatures(
      review({ recentAccountsOnDevice: 9, recentAccountsOnSubnet: 30 }),
      { reviewer: { id: 'u', sharedDeviceCount: 2, sharedSubnetCount: 4 } as never },
    );
    expect(f['net.accountsOnDevice']).toBe(9);
    expect(f['net.accountsOnSubnet']).toBe(30);
    expect(f['net.deviceReuse']).toBeCloseTo(1, 8);
    expect(f['net.subnetReuse']).toBeCloseTo(1, 8);

    const fromProfile = extractNetworkFeatures(review({}), {
      reviewer: { id: 'u', sharedDeviceCount: 10, sharedSubnetCount: 20 } as never,
    });
    expect(fromProfile['net.deviceReuse']).toBe(1);
    expect(fromProfile['net.subnetReuse']).toBe(1);
  });

  it('detects headless user agents by name', () => {
    for (const ua of [
      'Mozilla/5.0 HeadlessChrome/131',
      'phantomjs agent',
      'Puppeteer/1.2',
      'Playwright',
      'Automated Selenium browser',
    ]) {
      expect(extractNetworkFeatures(review({ userAgent: ua }), {})['net.headless']).toBe(1);
    }
    expect(
      extractNetworkFeatures(
        review({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }),
        {},
      )['net.headless'],
    ).toBe(0);
    expect(extractNetworkFeatures(review({}), {})['net.headless']).toBe(0);
  });

  it('honors an explicit headlessUserAgent flag', () => {
    expect(extractNetworkFeatures(review({ headlessUserAgent: true }), {})['net.headless']).toBe(1);
  });

  it('computes locale mismatch when locale and declared language disagree', () => {
    const f = extractNetworkFeatures(review(undefined, 'en'), {});
    expect(f['net.localeMismatch']).toBe(0);
    const mismatched = extractNetworkFeatures(
      { ...review(undefined, 'en'), context: { locale: 'fr-FR' } } as never,
      {},
    );
    expect(mismatched['net.localeMismatch']).toBe(1);
  });

  it('does not flag locale mismatch on und language or missing pieces', () => {
    expect(
      extractNetworkFeatures(
        { ...review(undefined, 'und'), context: { locale: 'fr-FR' } } as never,
        {},
      )['net.localeMismatch'],
    ).toBe(0);
    const noLanguage = { ...review(), language: undefined } as never;
    expect(
      extractNetworkFeatures({ ...noLanguage, context: { locale: 'fr-FR' } } as never, {})[
        'net.localeMismatch'
      ],
    ).toBe(0);
  });

  it('passes through an explicit localeMismatch; a false flag cannot mask an inconsistent pair', () => {
    expect(extractNetworkFeatures(review({ localeMismatch: true }), {})['net.localeMismatch']).toBe(
      1,
    );
    // Same reviewer experience: locale fr-FR vs declared en still computes true.
    const forced = extractNetworkFeatures(review({ locale: 'fr-FR', localeMismatch: false }), {});
    expect(forced['net.localeMismatch']).toBe(1);
  });

  it('flags datacenter ASN and computes subnet concentration', () => {
    expect(extractNetworkFeatures(review({ isDatacenterAsn: true }), {})['net.datacenter']).toBe(1);
    expect(extractNetworkFeatures(review({ isDatacenterAsn: false }), {})['net.datacenter']).toBe(
      0,
    );
    const f = extractNetworkFeatures(review({ recentReviewsOnSubnet: 250 }), {});
    expect(f['net.reviewsOnSubnet']).toBe(250);
    expect(f['net.subnetConcentration']).toBe(1);
  });
});
