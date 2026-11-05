// Entry point for the TypeORM CLI (migrations). Runs from compiled dist/.
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.validation.js';
import { buildTypeOrmOptions } from './typeorm.options.js';

export default new DataSource(buildTypeOrmOptions(validateEnv(process.env)));
