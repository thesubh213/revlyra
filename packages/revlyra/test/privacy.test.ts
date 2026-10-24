import { describe, expect, it } from 'vitest';
import {
  deriveSubnet,
  hmacHex,
  installIdFile,
  normalizeIp,
  redactEvidence,
  redactText,
  safeEqualHex,
  scopedHmac,
  stripIdentityKeys,
} from '../src/privacy';

describe('hmacHex / scopedHmac', () => {
  it('produces stable 64-char hex digests', () => {
    const value = hmacHex('pepper', 'user-1');
    expect(value).toMatch(/^[0-9a-f]{64}$/u);
    expect(hmacHex('pepper', 'user-1')).toBe(value);
    expect(hmacHex('other', 'user-1')).not.toBe(value);
  });

  it('distinguishes tenant scopes and kinds', () => {
    const base = scopedHmac('p', 'acme', 'reviewer', '100');
    expect(scopedHmac('p', 'acme', 'reviewer', '100')).toBe(base);
    expect(scopedHmac('p', 'other', 'reviewer', '100')).not.toBe(base);
    expect(scopedHmac('p', 'acme', 'item', '100')).not.toBe(base);
    for (const kind of ['reviewer', 'item', 'review', 'ip', 'actor'] as const) {
      expect(scopedHmac('p', 't', kind, 'value')).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe('safeEqualHex', () => {
  it('compares equal strings and rejects mismatching ones', () => {
    expect(safeEqualHex('abc', 'abc')).toBe(true);
    expect(safeEqualHex('abc', 'abd')).toBe(false);
    expect(safeEqualHex('', '')).toBe(true);
  });

  it('short-circuits on length mismatch', () => {
    expect(safeEqualHex('a'.repeat(10), 'a'.repeat(11))).toBe(false);
    // Same char count but different utf8 byte length (é is 2 bytes) -> false.
    expect(safeEqualHex('é', 'a')).toBe(false);
  });
});

describe('normalizeIp / deriveSubnet', () => {
  it('null for missing inputs and trimmed otherwise', () => {
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp('  10.1.2.3 ')).toBe('10.1.2.3');
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
  });

  it('requires four numeric parts for IPv4', () => {
    expect(deriveSubnet('10.1.2.3')).toBe('10.1.2.0/24');
    expect(deriveSubnet('10.1.2')).toBeNull();
    expect(deriveSubnet('a.b.c.d')).toBeNull();
    expect(deriveSubnet('example.com')).toBeNull();
  });

  it('requires >= 3 colon groups for IPv6', () => {
    expect(deriveSubnet('2606:4700:4700::1111')).toBe('2606:4700:4700::/48');
    expect(deriveSubnet('fe80::1')).toBeNull(); // only 2 non-empty groups
    expect(deriveSubnet('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1::/48');
  });
});

describe('redactText', () => {
  it('masks URLs, emails, and phones', () => {
    const redacted = redactText('email a@b.example call 8005551234 link https://x.example');
    expect(redacted).not.toContain('a@b.example');
    expect(redacted).not.toContain('x.example');
    expect(redacted).not.toContain('8005551234');
  });
});

describe('stripIdentityKeys', () => {
  it('is disabled cleanly and copies metadata', () => {
    const original = { profileUrl: 'x' };
    const disabled = stripIdentityKeys(original, { enabled: false });
    expect(disabled.stripped).toEqual([]);
    expect(disabled.metadata.profileUrl).toBe('x');
  });

  it('strips identity-shaped keys by regex (platform names only as prefixes)', () => {
    const result = stripIdentityKeys({
      linkedin_url: 'https://linkedin.com/in/x',
      social: 'page',
      resume: 'file.pdf',
      cv: 'file2.pdf',
      passport: 'P123',
      national_id: 'N',
      date_of_birth: '1990-01-01',
      dob: '1990-01-01',
      street_address: 'somewhere',
      rating_history: [1, 2],
    });
    expect(result.stripped).toEqual(
      expect.arrayContaining([
        'linkedin_url',
        'social',
        'resume',
        'cv',
        'passport',
        'national_id',
        'date_of_birth',
        'dob',
        'street_address',
      ]),
    );
    expect(Object.keys(result.metadata)).toEqual(['rating_history']);
  });

  it('strips string values that embed social handles (@platform.)', () => {
    const result = stripIdentityKeys({
      note: 'find me on @linkedin.com/in/someone',
      harmless: 'look up my favorites',
    });
    expect(result.stripped).toEqual(['note']);
    expect(result.metadata.harmless).toBe('look up my favorites');
  });

  it('leaves non-string objects intact', () => {
    const result = stripIdentityKeys({ notes: { linkedin: 'plain' } });
    expect(result.stripped).toEqual([]);
    expect(result.metadata).toEqual({ notes: { linkedin: 'plain' } });
  });
});

describe('redactEvidence', () => {
  it('is identity when disabled', () => {
    const evidence = { matches: ['a@b.example'] };
    expect(redactEvidence(evidence, false)).toBe(evidence);
  });

  it('walks nested strings, arrays, and objects replacing contacts', () => {
    const redacted = redactEvidence(
      {
        reviewer: 'email me a@b.example or call 8005551234, visit https://c.example',
        nested: { list: ['phone 8005551234', 42, null, true] },
      },
      true,
    );
    const stringified = JSON.stringify(redacted);
    expect(stringified).not.toContain('a@b.example');
    expect(stringified).not.toContain('8005551234');
    expect(stringified).not.toContain('c.example');
    expect(stringified).toContain('[email]');
    expect(stringified).toContain('[phone]');
    expect(stringified).toContain('[url]');
    expect(stringified).toContain('42');
  });

  it('preserves numbers/booleans/null in place', () => {
    const redacted = redactEvidence({ n: 7, b: true, z: null }, true);
    expect(redacted).toEqual({ n: 7, b: true, z: null });
  });
});

describe('installIdFile', () => {
  it('joins the configDir with the file name', () => {
    expect(installIdFile('/var/lib/revlyra')).toBe('/var/lib/revlyra/install-id');
    expect(installIdFile('C:/x')).toBe('C:/x/install-id');
  });
});
