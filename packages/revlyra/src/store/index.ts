import type { RevlyraConfig } from '../config';
import type { Store } from './interface';
import { SqliteStore } from './sqlite';

export async function createStore(
  config: RevlyraConfig,
  options: { migrate?: boolean } = {},
): Promise<Store> {
  let store: Store;
  if (config.database.driver === 'postgres') {
    const { PostgresStore } = await import('./postgres');
    store = new PostgresStore(config.database.url!, config.database.poolSize);
  } else {
    store = new SqliteStore(config.database.path);
  }
  if (options.migrate !== false) await store.migrate();
  return store;
}

export * from './interface';
export { SqliteStore } from './sqlite';
export * from './types';
