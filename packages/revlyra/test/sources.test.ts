import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FilesSource } from '../src/sources/files';
import { RestSource } from '../src/sources/rest';
import { SqliteSource } from '../src/sources/sqlite';
import { sqliteModule } from '../src/sqlite';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-sources-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const records = [
  {
    id: 'r1',
    product_id: 'p1',
    user_id: 'u1',
    stars: 5,
    review: 'The battery lasted eight hours and the case is solid.',
    created_at: '2026-10-20T10:00:00Z',
    verified: 1,
  },
  {
    id: 'r2',
    product_id: 'p1',
    user_id: 'u2',
    stars: 3,
    review: 'Shipping was slow and the box arrived damaged.',
    created_at: '2026-10-21T10:00:00Z',
    verified: 0,
  },
];

describe('files source', () => {
  it('streams a JSON array and auto-maps fields', async () => {
    const dir = tempDir();
    const file = join(dir, 'reviews.json');
    writeFileSync(file, JSON.stringify(records));
    const source = new FilesSource('files-1', { path: file, format: 'json' });

    const test = await source.test();
    expect(test.ok).toBe(true);
    expect(test.sampleCount).toBe(2);

    const pulled = [];
    for await (const item of source.pull({ limit: 1 })) pulled.push(item);
    expect(pulled).toHaveLength(1);
    expect(pulled[0]?.review.itemId).toBe('p1');
    expect(pulled[0]?.review.rating).toBe(5);
  });

  it('streams NDJSON', async () => {
    const dir = tempDir();
    const file = join(dir, 'reviews.ndjson');
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'));
    const source = new FilesSource('files-2', { path: file, format: 'ndjson' });
    const pulled = [];
    for await (const item of source.pull()) pulled.push(item);
    expect(pulled).toHaveLength(2);
    expect(pulled[1]?.review.reviewerId).toBe('u2');
  });
});

describe('sqlite source', () => {
  it('reads a table in read-only mode', async () => {
    const dir = tempDir();
    const file = join(dir, 'reviews.db');
    const sqlite = sqliteModule();
    const db = new sqlite.DatabaseSync(file);
    db.exec(
      'CREATE TABLE reviews (id TEXT, product_id TEXT, user_id TEXT, stars INTEGER, review TEXT, created_at TEXT)',
    );
    for (const record of records) {
      db.prepare(
        'INSERT INTO reviews (id, product_id, user_id, stars, review, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        record.id,
        record.product_id,
        record.user_id,
        record.stars,
        record.review,
        record.created_at,
      );
    }
    db.close();

    const source = new SqliteSource('sqlite-1', { path: file, table: 'reviews', limit: 10 });
    const test = await source.test();
    expect(test.ok).toBe(true);
    expect(test.sampleCount).toBe(2);

    const pulled = [];
    for await (const item of source.pull({ limit: 1 })) pulled.push(item);
    expect(pulled).toHaveLength(1);
    await source.close();
  });
});

describe('rest source', () => {
  it('paginates and maps JSON through a private test server', async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const page = Number(url.searchParams.get('page') ?? 1);
      const limit = Number(url.searchParams.get('limit') ?? 2);
      const start = (page - 1) * limit;
      const items = records.slice(start, start + limit);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { items } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const source = new RestSource('rest-1', {
        url: `http://127.0.0.1:${port}/reviews`,
        allowPrivateHosts: true,
        pagination: {
          mode: 'page',
          pageParam: 'page',
          limitParam: 'limit',
          pageSize: 1,
          maxPages: 5,
        },
        itemsPath: 'data.items',
      });
      const test = await source.test();
      expect(test.ok).toBe(true);
      expect(test.sampleCount).toBe(2);

      const pulled = [];
      for await (const item of source.pull()) pulled.push(item);
      expect(pulled).toHaveLength(2);
      expect(pulled[0]?.review.itemId).toBe('p1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
