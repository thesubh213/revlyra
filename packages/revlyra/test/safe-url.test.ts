import { describe, expect, it, vi } from 'vitest';

// Hoisted before the source module loads, so safe-url's static
// `import { lookup } from 'node:dns/promises'` binds to the stub below.
vi.mock('node:dns/promises', () => ({
  lookup: async (hostname: string) => {
    if (hostname === 'mixed.example') {
      return [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.9', family: 4 },
      ];
    }
    if (hostname === 'clean.example') return [{ address: '93.184.216.34', family: 4 }];
    return [];
  },
}));

const { assertSafeHttpUrl, isPrivateIpForTests } = await import('../src/sources/safe-url');

describe('isPrivateIpForTests', () => {
  it('treats loopback, private, link-local, CGNAT, doc ranges as private', () => {
    for (const value of [
      '0.1.2.3',
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '100.127.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.19.255.255',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateIpForTests(value), value).toBe(true);
    }
  });

  it('treats public IPv4 as public', () => {
    for (const value of [
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1',
      '203.0.113.55',
      '198.20.0.1',
      '192.1.0.1',
    ]) {
      expect(isPrivateIpForTests(value), value).toBe(false);
    }
  });

  it('treats IPv6 private and mapped forms as private', () => {
    for (const value of [
      '::1',
      '::',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      'febf::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:192.168.1.1',
    ]) {
      expect(isPrivateIpForTests(value), value).toBe(true);
    }
  });

  it('treats garbage as private (fail-closed)', () => {
    expect(isPrivateIpForTests('not-an-ip')).toBe(true);
    expect(isPrivateIpForTests('')).toBe(true);
  });
});

describe('assertSafeHttpUrl', () => {
  it('rejects unparseable URLs', async () => {
    await expect(assertSafeHttpUrl('not a url at all')).rejects.toThrow('URL_INVALID');
    await expect(assertSafeHttpUrl('')).rejects.toThrow('URL_INVALID');
    await expect(assertSafeHttpUrl('http://')).rejects.toThrow();
  });

  it('blocks non-http(s) protocols', async () => {
    for (const raw of [
      'ftp://example.com/x',
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      'javascript://void(0)',
      'sftp://example.com',
      'gopher://example.com',
    ]) {
      await expect(assertSafeHttpUrl(raw)).rejects.toThrow('URL_PROTOCOL_BLOCKED');
    }
  });

  it('blocks embedded credentials', async () => {
    await expect(assertSafeHttpUrl('https://user:pass@example.com/')).rejects.toThrow(
      'URL_CREDENTIALS_BLOCKED',
    );
  });

  it('blocks literal private IPs and metadata hostnames', async () => {
    for (const raw of [
      'http://127.0.0.1/x',
      'http://10.1.2.3/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.0.15/x',
      'http://0.0.0.0/x',
    ]) {
      await expect(assertSafeHttpUrl(raw)).rejects.toThrow('URL_PRIVATE_HOST_BLOCKED');
    }
  });

  it('fails closed for bracketed IPv6 literals (WHATWG keeps brackets, so they hit the DNS path)', async () => {
    // With the stubbed DNS returning nothing, bracketed hosts are blocked via
    // URL_DNS_EMPTY fail-closed semantics; the fetch would equally fail.
    for (const raw of ['http://[::1]/x', 'http://[fd00::1]/x']) {
      await expect(assertSafeHttpUrl(raw)).rejects.toThrow('URL_DNS_EMPTY');
    }
  });

  it('blocks localhost/internal hostnames without DNS', async () => {
    for (const hostname of ['localhost', 'my.localhost', 'api.internal', 'x.internal']) {
      await expect(assertSafeHttpUrl(`http://${hostname}/`)).rejects.toThrow(
        'URL_PRIVATE_HOST_BLOCKED',
      );
    }
  });

  it('allows private hosts when explicitly opted in (test seam)', async () => {
    const url = await assertSafeHttpUrl('http://127.0.0.1:3000/x?y=1', { allowPrivateHosts: true });
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe('3000');
  });

  it('resolves DNS and blocks when any record is private', async () => {
    await expect(assertSafeHttpUrl('http://mixed.example/x')).rejects.toThrow(
      'URL_PRIVATE_HOST_BLOCKED',
    );
    const allowed = await assertSafeHttpUrl('http://clean.example/x');
    expect(allowed.hostname).toBe('clean.example');
  });

  it('fails closed on empty DNS records', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    await expect(assertSafeHttpUrl('http://missing.example/x')).rejects.toThrow('URL_DNS_EMPTY');
    vi.unstubAllEnvs();
  });

  it('returns the parsed URL unchanged for public hosts', async () => {
    // example.com resolves publicly on any network this runs on; fall back to
    // an IP literal to stay network-agnostic.
    const url = await assertSafeHttpUrl('https://93.184.216.34:8443/path?a=b');
    expect(url.pathname).toBe('/path');
    expect(url.searchParams.get('a')).toBe('b');
  });
});

describe('assertSafeHttpUrl vs mapped forms (rebinding vectors)', () => {
  it('untouched IPv6 forms still classify privately at the isPrivateIp level', () => {
    expect(isPrivateIpForTests('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIpForTests('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIpForTests('::ffff:192.168.1.1')).toBe(true);
  });

  it('bracketed mapped literals fail closed through the DNS path', async () => {
    await expect(assertSafeHttpUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow('URL_DNS_EMPTY');
  });
});
