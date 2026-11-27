import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

/**
 * Serves the built frontend from the API's own origin when `dir` holds one
 * (the Docker image puts it there). One origin means the session cookie is
 * first-party without a custom domain. Hashed assets are cached for a year;
 * every other GET outside /api gets index.html (client-side routes).
 */
export function serveWeb(app: NestExpressApplication, dir: string): boolean {
  const root = resolve(dir);
  const index = join(root, 'index.html');
  if (!existsSync(index)) return false;

  app.useStaticAssets(root, {
    index: false,
    setHeaders: (res, path) => {
      res.setHeader(
        'Cache-Control',
        path.includes(`${join(root, 'assets')}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      );
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isPage =
      (req.method === 'GET' || req.method === 'HEAD') &&
      req.path !== '/api' &&
      !req.path.startsWith('/api/');
    if (!isPage) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
  return true;
}
