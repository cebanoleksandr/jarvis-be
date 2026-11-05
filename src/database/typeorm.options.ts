import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';

const dirname = import.meta.dirname;

/**
 * Shared options for the Nest app and the TypeORM CLI. The app registers
 * entities via forFeature + autoLoadEntities; the CLI uses the dist/ globs.
 */
export function buildTypeOrmOptions(env: {
  DATABASE_URL: string;
  DB_LOGGING: boolean;
}): DataSourceOptions {
  return {
    type: 'postgres',
    // gen_random_uuid() is built into Postgres 13+, no uuid-ossp needed.
    uuidExtension: 'pgcrypto',
    url: env.DATABASE_URL,
    entities: [join(dirname, '..', '**', '*.entity.js')],
    migrations: [join(dirname, 'migrations', '*.js')],
    // Schema changes go through migrations only, never synchronize.
    synchronize: false,
    migrationsRun: true,
    logging: env.DB_LOGGING,
  };
}
