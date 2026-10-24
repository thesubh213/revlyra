import { describe, expect, it } from 'vitest';
import { normalizeReview } from '../src/normalize';
import { fingerprintText, maskContacts } from '../src/normalize/text';
import { normalizeUnicode } from '../src/normalize/unicode';

const baseReview = {
  id: 'r1',
  itemId: 'p1',
  reviewerId: 'u1',
  rating: 5,
  submittedAt: '2026-10-20T12:00:00Z',
};

describe('text normalization', () => {
  it('fingerprints through casing, punctuation, spacing, and contacts', () => {
    const a = fingerprintText('The battery lasts 8 hours. Email me at a@b.com!');
    const b = fingerprintText('the BATTERY lasts 8 hours email me at c@d.com');
    expect(a).toBe(b);
    const masked = maskContacts('Visit https://example.com or call +1 415 555 0100.');
    expect(masked.urlCount).toBe(1);
    expect(masked.phoneCount).toBe(1);
    expect(masked.text).toContain('[url]');
    expect(masked.text).toContain('[phone]');
  });

  it('maps homoglyphs used to disguise Latin text', () => {
    const result = normalizeUnicode('This is pаypal and gооgle'); // Cyrillic а/о
    expect(result.text).toBe('This is paypal and google');
    expect(result.homoglyphsMapped).toBeGreaterThan(0);
  });

  it('does not rewrite legitimate Cyrillic text', () => {
    const result = normalizeUnicode('Отличный товар, очень доволен покупкой');
    expect(result.text).toBe('Отличный товар, очень доволен покупкой');
    expect(result.homoglyphsMapped).toBe(0);
  });

  it('does not treat emoji or symbols as mixed-script evasion', () => {
    const result = normalizeUnicode('great product 😀 works well');
    expect(result.mixedScriptTokens).toBe(0);
  });

  it('strips zero-width characters', () => {
    const result = normalizeUnicode('best\u200b product\u200d ever');
    expect(result.text).toBe('best product ever');
    expect(result.zeroWidthRemoved).toBe(2);
  });

  it('produces stable hashes for trivial variations', () => {
    const left = normalizeReview({ ...baseReview, text: 'Great battery life. Lasts 8 hours!' });
    const right = normalizeReview({ ...baseReview, text: 'great battery life lasts 8 hours' });
    expect(left.exactHash).toBe(right.exactHash);
    expect(left.language).toBe('en');
  });
});
