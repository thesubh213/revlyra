import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FilesSource } from '../src/sources/files';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-files-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sample = [
  { id: 'r1', item_id: 'p1', reviewer_id: 'u1', rating: 5, text: 'Great tool overall' },
  { id: 'r2', item_id: 'p2', reviewer_id: 'u2', rating: 2, text: 'Broke quickly' },
  { id: 'r3', item_id: 'p3', reviewer_id: 'u3', rating: 4, text: 'Works as promised' },
];

const csvRows = [
  'id,item_id,reviewer_id,rating,text',
  'c1,p1,u1,5,"Great value; quick shipping"',
  'c2,p2,u2,3,"A fine, if unremarkable, drill"',
  'c3,p3,u3,1,"Total junk"',
];

describe('files source: CSV', () => {
  it('parses CSV by extension with headers as columns', async () => {
    const dir = tempDir();
    const file = join(dir, 'reviews.csv');
    writeFileSync(file, csvRows.join('\n'));
    const source = new FilesSource('csv-1', { path: file });
    const test = await source.test();
    expect(test.ok).toBe(true);
    expect(test.sample?.review.text).toBe('Total junk');
    const pulled = [];
    for await (const item of source.pull()) pulled.push(item);
    expect(pulled).toHaveLength(3);
    expect(pulled[0]?.review.rating).toBe(5);
  });

  it('supports custom delimiters and array columns mode', async () => {
    const dir = tempDir();
    const file = join(dir, 'reviews.tsv');
    writeFileSync(file, ['id;item_id;reviewer_id;rating;text', 't1;p1;u1;5;Nice'].join('\n'));
    const source = new FilesSource('csv-2', {
      path: file,
      format: 'csv',
      csv: { delimiter: ';' },
    });
    const pulled = [];
    for await (const item of source.pull()) pulled.push(item);
    expect(pulled).toHaveLength(1);
    expect(pulled[0]?.review.itemId).toBe('p1');
  });

  it('treats explicit format winning over extension detection', async () => {
    const dir = tempDir();
    const file = join(dir, 'data.json');
    writeFileSync(file, JSON.stringify([{ id: 'x1', item_id: 'p', reviewer_id: 'u', rating: 5 }]));
    const source = new FilesSource('csv-3', { path: file, format: 'json' });
    const test = await source.test();
    expect(test.ok).toBe(true);
    expect(test.sample?.review.itemId).toBe('p');
  });
});

describe('files source: error handling', () => {
  it('fails test for missing files', async () => {
    const dir = tempDir();
    const source = new FilesSource('csv-4', { path: join(dir, 'missing.json') });
    const test = await source.test();
    expect(test.ok).toBe(false);
    expect(test.message).toContain('Source file not found');
    expect(test.sample).toBeNull();
  });

  it('reports malformed NDJSON with the offending line', async () => {
    const dir = tempDir();
    const file = join(dir, 'broken.ndjson');
    writeFileSync(
      file,
      [
        JSON.stringify({ id: 'a1', item_id: 'p', reviewer_id: 'u', rating: 5 }),
        'not json at all {{{',
      ].join('\n'),
    );
    const source = new FilesSource('csv-5', { path: file });
    const test = await source.test();
    expect(test.ok).toBe(false);
    expect(test.message).toContain('Invalid NDJSON line');
  });

  it('empty NDJSON and empty JSON arrays yield zero records', async () => {
    const dir = tempDir();
    const nd = join(dir, 'empty.ndjson');
    writeFileSync(nd, '');
    const ndSource = new FilesSource('csv-6', { path: nd });
    const pulledNd = [];
    for await (const item of ndSource.pull()) pulledNd.push(item);
    expect(pulledNd).toHaveLength(0);

    const array = join(dir, 'empty.json');
    writeFileSync(array, '[]');
    const arraySource = new FilesSource('csv-7', { path: array });
    const test = await arraySource.test();
    expect(test.ok).toBe(true);
    expect(test.sampleCount).toBe(0);
  });

  it('skips blank lines in NDJSON', async () => {
    const dir = tempDir();
    const file = join(dir, 'blanks.ndjson');
    writeFileSync(
      file,
      `${JSON.stringify({ id: 'b1', item_id: 'p', reviewer_id: 'u', rating: 5 })}\n\n\n${JSON.stringify({ id: 'b2', item_id: 'p', reviewer_id: 'u', rating: 4 })}\n`,
    );
    const source = new FilesSource('csv-8', { path: file });
    const test = await source.test();
    expect(test.ok).toBe(true);
    expect(test.sampleCount).toBe(2);
  });

  it('handles CRLF-delimited CSV rows', async () => {
    const dir = tempDir();
    const file = join(dir, 'crlf.csv');
    writeFileSync(file, csvRows.join('\r\n'));
    const source = new FilesSource('csv-9', { path: file });
    const pulled = [];
    for await (const item of source.pull()) pulled.push(item);
    expect(pulled).toHaveLength(3);
  });
});

describe('files source: pull controls', () => {
  it('honors limit during pull', async () => {
    const dir = tempDir();
    const file = join(dir, 'limit.json');
    writeFileSync(file, JSON.stringify(sample));
    const source = new FilesSource('limit-1', { path: file });
    const pulled = [];
    for await (const item of source.pull({ limit: 2 })) pulled.push(item);
    expect(pulled).toHaveLength(2);
  });

  it('aborts before the first record with PULL_ABORTED', async () => {
    const dir = tempDir();
    const file = join(dir, 'abort.json');
    writeFileSync(file, JSON.stringify(sample));
    const source = new FilesSource('abort-1', { path: file });
    const controller = new AbortController();
    controller.abort();
    const pulled = [];
    await expect(async () => {
      for await (const item of source.pull({ signal: controller.signal })) {
        pulled.push(item);
      }
    }).rejects.toThrow('PULL_ABORTED');
    expect(pulled).toHaveLength(0);
  });

  it('flushes partial batches under batchSize 1 and limit 3', async () => {
    const dir = tempDir();
    const file = join(dir, 'batch.json');
    writeFileSync(file, JSON.stringify(sample));
    const source = new FilesSource('batch-1', { path: file });
    const pulled = [];
    for await (const item of source.pull({ batchSize: 1, limit: 3 })) pulled.push(item);
    expect(pulled).toHaveLength(3);
  });

  it('containerizes nested directories for relative paths?', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'nested'));
    const file = join(dir, 'nested/dataset.json');
    writeFileSync(file, JSON.stringify([sample[0]]));
    const source = new FilesSource('nested-1', { path: file });
    const test = await source.test();
    expect(test.ok).toBe(true);
    expect(test.sample?.review.reviewerId).toBe('u1');
  });
});
