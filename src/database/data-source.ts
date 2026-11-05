// Entry point for the TypeORM CLI (migrations). Runs from compiled dist/.
import { existsSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.validation.js';
import { buildTypeOrmOptions } from './typeorm.options.js';

// Variables already set in the environment take precedence over .env.
if (existsSync('.env')) process.loadEnvFile('.env');

export default new DataSource(buildTypeOrmOptions(validateEnv(process.env)));
