import {
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Env } from '../config/env.validation.js';
import { UsersService } from '../users/users.service.js';
import {
  baseCookieOptions,
  OAUTH_FLOW_COOKIE,
  OAUTH_FLOW_COOKIE_PATH,
  OAUTH_FLOW_TTL_SECONDS,
  SESSION_COOKIE,
} from './auth.constants.js';
import { AuthService } from './auth.service.js';
import { CurrentUserId } from './current-user.decorator.js';
import { Public } from './public.decorator.js';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly frontendUrl: string;
  private readonly cookieBase: ReturnType<typeof baseCookieOptions>;

  constructor(
    config: ConfigService<Env, true>,
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {
    this.frontendUrl = config.get('FRONTEND_URL', { infer: true });
    this.cookieBase = baseCookieOptions(
      config.get('NODE_ENV', { infer: true }) === 'production',
    );
  }

  @Public()
  @Get('google')
  async googleLogin(@Res() res: Response) {
    const { url, flowToken } = await this.auth.startGoogleLogin();
    res.cookie(OAUTH_FLOW_COOKIE, flowToken, {
      ...this.cookieBase,
      path: OAUTH_FLOW_COOKIE_PATH,
      maxAge: OAUTH_FLOW_TTL_SECONDS * 1000,
    });
    res.redirect(url);
  }

  @Public()
  @Get('google/callback')
  async googleCallback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const flowToken: unknown = req.cookies?.[OAUTH_FLOW_COOKIE];
    res.clearCookie(OAUTH_FLOW_COOKIE, {
      ...this.cookieBase,
      path: OAUTH_FLOW_COOKIE_PATH,
    });

    try {
      if (error) throw new Error(`Google returned error: ${error}`);
      if (!code || !state || typeof flowToken !== 'string') {
        throw new Error('Missing code, state or flow cookie');
      }
      const user = await this.auth.completeGoogleLogin({
        code,
        state,
        flowToken,
      });
      res.cookie(SESSION_COOKIE, await this.auth.issueSession(user.id), {
        ...this.cookieBase,
        path: '/',
        maxAge: this.auth.sessionMaxAgeMs,
      });
      res.redirect(this.frontendUrl);
    } catch (e) {
      this.logger.warn(`Google login failed: ${(e as Error).message}`);
      const target = new URL('/login', this.frontendUrl);
      target.searchParams.set('error', error ?? 'google_auth_failed');
      res.redirect(target.toString());
    }
  }

  @Get('me')
  async me(@CurrentUserId() userId: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException();
    const { id, email, name, timezone, avatarUrl } = user;
    return { id, email, name, timezone, avatarUrl };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { ...this.cookieBase, path: '/' });
  }
}
