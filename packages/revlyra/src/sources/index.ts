import { FilesSource, type FilesSourceConfig } from './files';
import { MongoSource, type MongoSourceConfig } from './mongo';
import { MysqlSource, type MysqlSourceConfig } from './mysql';
import { PostgresSource, type PostgresSourceConfig } from './postgres';
import { RestSource, type RestSourceConfig } from './rest';
import { SqliteSource, type SqliteSourceConfig } from './sqlite';
import type { ReviewSource } from './types';

export type SourceKind = 'files' | 'sqlite' | 'postgres' | 'mysql' | 'mongodb' | 'rest';

export type SourceConfig =
  | (FilesSourceConfig & { kind: 'files' })
  | (SqliteSourceConfig & { kind: 'sqlite' })
  | (PostgresSourceConfig & { kind: 'postgres' })
  | (MysqlSourceConfig & { kind: 'mysql' })
  | (MongoSourceConfig & { kind: 'mongodb' })
  | (RestSourceConfig & { kind: 'rest' });

export function createSource(id: string, config: SourceConfig): ReviewSource {
  switch (config.kind) {
    case 'files':
      return new FilesSource(id, config);
    case 'sqlite':
      return new SqliteSource(id, config);
    case 'postgres':
      return new PostgresSource(id, config);
    case 'mysql':
      return new MysqlSource(id, config);
    case 'mongodb':
      return new MongoSource(id, config);
    case 'rest':
      return new RestSource(id, config);
    default: {
      const exhaustive: never = config;
      throw new Error(`Unsupported source kind: ${String(exhaustive)}`);
    }
  }
}

export * from './files';
export * from './mapping';
export * from './mongo';
export * from './mysql';
export * from './postgres';
export * from './rest';
export { assertSafeHttpUrl } from './safe-url';
export * from './sqlite';
export * from './types';
