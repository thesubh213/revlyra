import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const CLI = join(process.cwd(), 'packages/revlyra/dist/cli/index.js');

const dirs: string[] = [];

function runCli(args: string[], cwd?: string): { stdout: string; json: Record<string, unknown> } {
  const result = execFileSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? process.cwd(),
    timeout: 60_000,
    encoding: 'utf8',
    env: { ...process.env, REVLYRA_LOG_LEVEL: 'silent' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout = String(result);
  const start = stdout.indexOf('{');
  let json: Record<string, unknown> = {};
  if (start >= 0) {
    try {
      json = JSON.parse(stdout.slice(start));
    } catch {
      // Machine-readable payload may be interleaved with human lines.
    }
  }
  return { stdout, json };
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function analyzeRoundTrip(dir: string): void {
  const analyze = runCli(
    [
      '--json',
      'analyze',
      '--text',
      'The 12 mm chuck holds bits securely and the battery lasted about four hours.',
      '--item',
      'drill-1',
      '--reviewer',
      'user-1',
    ],
    dir,
  );
  expect(analyze.json.ok).toBe(true);
  const result = analyze.json.result as Record<string, unknown> | undefined;
  expect(result?.score).toBeTypeOf('number');
  const doctor = runCli(['--json', 'doctor'], dir);
  expect(doctor.stdout.length).toBeGreaterThan(0);
}

describe.skipIf(!existsSync(CLI))('revlyra CLI (built dist)', () => {
  it('reports help and version flags', () => {
    const help = runCli(['--help']);
    expect(help.stdout).toContain('revlyra');
    expect(help.stdout).toContain('init');

    const version = runCli(['--version']);
    expect(version.stdout.trim()).toMatch(/^[0-9]+\.[0-9]/u);
  });

  it('init creates pepper/config/db/license + one-time keys and analyze works', () => {
    const dir = mkdtempSync(join(tmpdir(), 'revlyra-cli-'));
    dirs.push(dir);
    const init = runCli(['--json', 'init'], dir);
    void init;
    expect(existsSync(join(dir, '.revlyra', 'config.json'))).toBe(true);
    expect(existsSync(join(dir, '.revlyra', 'revlyra.db'))).toBe(true);
    expect(existsSync(join(dir, '.env.local'))).toBe(true);
    const envFile = readFileSync(join(dir, '.env.local'), 'utf8');
    expect(envFile).toContain('REVLYRA_PII_PEPPER=');
    expect(envFile).toContain('REVLYRA_ADMIN_KEY=');

    analyzeRoundTrip(dir);
  });
});
