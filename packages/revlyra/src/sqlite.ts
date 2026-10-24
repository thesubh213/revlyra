import type * as Sqlite from 'node:sqlite';

type BuiltinProcess = NodeJS.Process & {
  getBuiltinModule?: (id: string) => unknown;
};

export function sqliteModule(): typeof Sqlite {
  const getBuiltin = (process as BuiltinProcess).getBuiltinModule;
  if (typeof getBuiltin !== 'function') {
    throw new Error('node:sqlite requires Node.js 22.13 or newer.');
  }
  const module = getBuiltin.call(process, 'node:sqlite');
  if (!module) throw new Error('node:sqlite is not available in this runtime.');
  return module as typeof Sqlite;
}
