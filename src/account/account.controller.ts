import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { z } from 'zod';
import { baseCookieOptions, SESSION_COOKIE } from '../auth/auth.constants.js';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { parseBody } from '../common/validation.js';
import type { Env } from '../config/env.validation.js';
import { UsersService } from '../users/users.service.js';
import { AccountService } from './account.service.js';

const deleteSchema = z.object({ email: z.string().trim().min(1) }).strict();

@Controller('account')
export class AccountController {
  private readonly cookieBase: ReturnType<typeof baseCookieOptions>;

  constructor(
    config: ConfigService<Env, true>,
    private readonly account: AccountService,
    private readonly users: UsersService,
  ) {
    this.cookieBase = baseCookieOptions(
      config.get('NODE_ENV', { infer: true }) === 'production',
    );
  }

  /** Downloads all of the user's data as a JSON file. */
  @Get('export')
  async export(
    @CurrentUserId() userId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.account.export(userId);
    const day = data.exportedAt.toISOString().slice(0, 10);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="jarvis-export-${day}.json"`,
    );
    return data;
  }

  /**
   * Permanently deletes the account. The body must repeat the account email
   * (`{ "email": "..." }`) so a stray request cannot wipe everything.
   */
  @Delete()
  @HttpCode(204)
  async delete(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { email } = parseBody(deleteSchema, body);
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    if (email.toLowerCase() !== user.email) {
      throw new BadRequestException('Email does not match the account');
    }
    await this.account.delete(userId);
    res.clearCookie(SESSION_COOKIE, { ...this.cookieBase, path: '/' });
  }
}
