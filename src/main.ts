import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { Env } from './config/env.validation.js';
import { serveWeb } from './web.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const webDir = config.get('WEB_DIST', { infer: true });
  if (webDir && serveWeb(app, webDir)) {
    new Logger('Web').log(`Serving the frontend from ${webDir}`);
  }
  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
