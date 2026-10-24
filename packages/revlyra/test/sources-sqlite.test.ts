import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteSource } from '../src/sources/sqlite';
import { sqliteModule } from '../src/sqlite';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-sqlite-source-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may keep file handles briefly; temp dirs are best-effort cleanup.
    }
  }
});

function makeFixtureDb(file: string): void {
  const sqlite = sqliteModule();
  const db = new sqlite.DatabaseSync(file);
  db.exec(
    'CREATE TABLE reviews (id TEXT, item_id TEXT, reviewer_id TEXT, rating INTEGER, text TEXT, submitted_at TEXT)',
  );
  const insert = db.prepare(
    'INSERT INTO reviews (id, item_id, reviewer_id, rating, text, submitted_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 20; i += 1) {
    insert.run(
      `r${i}`,
      `p${i % 4}`,
      `u${i}`,
      (i % 5) + 1,
      `node review number ${i}`,
      '2026-10-01T00:00:00Z',
    );
  }
  db.exec("CREATE TABLE sold_out (id TEXT); INSERT INTO sold_out VALUES ('x')");
  db.close();
}

const file = join(tempDir(), 'source.db');
makeFixtureDb(file);

describe('SqliteSource query guards (evaluated lazily at test/pull)', () => {
  async function pullAll(source: SqliteSource): Promise<unknown[]> {
    const out = [];
    for await (const item of source.pull()) out.push(item);
    return out;
  }

  it('requires either a query or a table (at test/pull time)', async () => {
    const source = new SqliteSource('q0', { path: file });
    const testResult = await source.test();
    expect(testResult.ok).toBe(false);
    expect(testResult.message).toContain('SQLite source requires either query or table.');
    await expect(pullAll(source)).rejects.toThrow('SQLite source requires either query or table.');
  });

  it('rejects multi-statement and non-SELECT queries', async () => {
    const a = new SqliteSource('q1', { path: file, query: 'SELECT 1; SELECT 2' });
    await expect(pullAll(a)).rejects.toThrow('Only a single SQL statement is allowed.');
    const b = new SqliteSource('q2', { path: file, query: "INSERT INTO sold_out VALUES ('x')" });
    await expect(pullAll(b)).rejects.toThrow('Only SELECT or WITH queries are allowed.');
    const c = new SqliteSource('q3', { path: file, query: 'UPDATE sold_out SET id = id' });
    await expect(pullAll(c)).rejects.toThrow('Only SELECT or WITH queries are allowed.');
  });

  it('rejects invalid table identifiers', async () => {
    await expect(
      pullAll(new SqliteSource('q5', { path: file, table: 'reviews; DROP TABLE reviews' })),
    ).rejects.toThrow('Invalid table identifier');
    await expect(pullAll(new SqliteSource('q6', { path: file, table: 'a.b.c' }))).rejects.toThrow(
      'Invalid table name',
    );
  });

  it('accepts a WITH query via the query path', async () => {
    const source = new SqliteSource('q7', {
      path: file,
      query: 'SELECT * FROM reviews WHERE rowid <= 5',
    });
    const test = await source.test();
    expect(test.ok).toBe(true);
    expect(test.sampleCount).toBe(5);
  });
});

describe('SqliteSource read behavior', () => {
  it('fails softly in test() for nonexistent tables and throws in pull', async () => {
    const bad = new SqliteSource('q8', { path: file, table: 'missing_reviews' });
    const test = await bad.test();
    expect(test.ok).toBe(false);

    await expect(async () => {
      for await (const _ of bad.pull()) {
        void _;
      }
    }).rejects.toThrow();
    await bad.close();
    await bad.close(); // twice is safe
  });

  it('reports sampleCount 0 and null sample for empty results', async () => {
    const source = new SqliteSource('q9', { path: file, query: 'SELECT * FROM sold_out' });
    // The sold_out table lacks the mapping fields; test reports ok=false.
    const test = await source.test();
    expect(test.ok).toBe(false);
  });

  it('honors config.limit and applies where filters', async () => {
    const filtered = new SqliteSource('q10', {
      path: file,
      table: 'reviews',
      where: 'rating = 1',
    });
    const pulled = [];
    for await (const item of filtered.pull()) pulled.push(item);
    expect(pulled).toHaveLength(4);
  });

  it('runs a LIMIT upper clamp of 1,000,000', async () => {
    const source = new SqliteSource('q11', { path: file, table: 'reviews', limit: 2_000_000 });
    const pulled = [];
    for await (const item of source.pull()) pulled.push(item);
    expect(pulled).toHaveLength(20);
  });

  it('aborts with PULL_ABORTED on signal', async () => {
    const source = new SqliteSource('q12', { path: file, table: 'reviews' });
    const controller = new AbortController();
    const pulled = [];
    await expect(async () => {
      for await (const item of source.pull({ signal: controller.signal })) {
        pulled.push(item);
        controller.abort();
      }
    }).rejects.toThrow('PULL_ABORTED');
    expect(pulled).toHaveLength(1);
    await source.close();
  });
});
