import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';

const dirname = import.meta.dirname;

/** Shared options for the Nest app and the TypeORM CLI. */
export function buildTypeOrmOptions(env: {
  DATABASE_URL: string;
  DB_LOGGING: boolean;
}): DataSourceOptions {
  return {
    type: 'postgres',
    url: env.DATABASE_URL,
    entities: [join(dirname, '..', '**', '*.entity.js')],
    migrations: [join(dirname, 'migrations', '*.js')],
    // Schema changes go through migrations only, never synchronize.
    synchronize: false,
    migrationsRun: true,
    logging: env.DB_LOGGING,
  };
}
