import { describe, expect, it } from 'vitest';
import {
  createSource,
  FilesSource,
  KNOWN_MEDIA_KEYS,
  MongoSource,
  MysqlSource,
  PostgresSource,
  RestSource,
  SqliteSource,
} from '../src/sources';
import { getPath } from '../src/sources/mapping';
import type { SourceKind } from '../src/sources/types';

describe('createSource factory', () => {
  it('instantiates the right class per kind', () => {
    expect(createSource('f', { kind: 'files', path: '/tmp/x.json' })).toBeInstanceOf(FilesSource);
    expect(
      createSource('s', { kind: 'sqlite', path: '/tmp/x.db', table: 'reviews' }),
    ).toBeInstanceOf(SqliteSource);
    expect(
      createSource('p', { kind: 'postgres', url: 'postgres://u:p@localhost/db', table: 'reviews' }),
    ).toBeInstanceOf(PostgresSource);
    expect(
      createSource('m', { kind: 'mysql', url: 'mysql://u:p@localhost/db', table: 'reviews' }),
    ).toBeInstanceOf(MysqlSource);
    expect(
      createSource('g', {
        kind: 'mongodb',
        url: 'mongodb://localhost:27017',
        database: 'd',
        collection: 'c',
      }),
    ).toBeInstanceOf(MongoSource);
    expect(createSource('r', { kind: 'rest', url: 'https://api.example.com/x' })).toBeInstanceOf(
      RestSource,
    );
  });

  it('throws on unsupported kinds (reachable from JS callers)', () => {
    expect(() =>
      createSource('x', { kind: 'spreadsheet' as SourceKind, path: '/tmp/x.csv' } as never),
    ).toThrow('Unsupported source kind');
  });

  it('KNOWN_MEDIA_KEYS lists all 9 media keys', () => {
    expect(KNOWN_MEDIA_KEYS).toEqual([
      'url',
      'sha256',
      'dhash',
      'phash',
      'width',
      'height',
      'mime',
      'exif',
      'capturedAt',
    ]);
  });
});

describe('getPath edge cases', () => {
  it('resolves bracket and dot access', () => {
    const data = { a: { b: [10, 20] }, list: [[{ deep: true }]] };
    expect(getPath(data, 'a.b[1]')).toBe(20);
    expect(getPath(data, 'list.0.0.deep')).toBe(true);
    expect(getPath(data, 'a.b[5]')).toBeUndefined();
    expect(getPath(data, '')).toBeUndefined();
    expect(getPath(data, 'a.b.c.deep')).toBeUndefined();
    expect(getPath(42, 'a')).toBeUndefined();
    expect(getPath([undefined], 'a[!]')).toBeUndefined();
  });

  it('handles malformed identifiers in brackets', () => {
    expect(getPath({ k: 'v' }, 'k[abc]')).toBeUndefined();
  });
});
