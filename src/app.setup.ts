import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import type { Env } from './config/env.validation.js';

/** Shared by main.ts and e2e tests so both run the same pipeline. */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({
    origin: config.get('FRONTEND_URL', { infer: true }),
    credentials: true,
  });
}
