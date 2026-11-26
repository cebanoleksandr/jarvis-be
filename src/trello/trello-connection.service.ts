import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ToolError } from '../agent/tool.js';
import { TokenCipher } from '../common/crypto/token-cipher.js';
import type { Env } from '../config/env.validation.js';
import { TrelloAccount } from './trello-account.entity.js';
import { TrelloClientService } from './trello-client.service.js';

/** How long the user has to approve access on trello.com. */
const STATE_TTL_MS = 15 * 60 * 1000;

export interface TrelloConnection {
  /** False when the server has no Trello API key: nothing to connect. */
  available: boolean;
  connected: boolean;
  username: string | null;
  fullName: string | null;
  connectedAt: Date | null;
}

@Injectable()
export class TrelloConnectionService {
  private readonly logger = new Logger(TrelloConnectionService.name);
  private readonly frontendUrl: string;
  private readonly stateSecret: string;

  constructor(
    config: ConfigService<Env, true>,
    @InjectRepository(TrelloAccount)
    private readonly accounts: Repository<TrelloAccount>,
    private readonly client: TrelloClientService,
    private readonly cipher: TokenCipher,
  ) {
    this.frontendUrl = config.get('FRONTEND_URL', { infer: true });
    this.stateSecret = config.get('JWT_SECRET', { infer: true });
  }

  async status(userId: string): Promise<TrelloConnection> {
    const account = this.client.available
      ? await this.accounts.findOneBy({ userId })
      : null;
    return {
      available: this.client.available,
      connected: Boolean(account),
      username: account?.username ?? null,
      fullName: account?.fullName ?? null,
      connectedAt: account?.createdAt ?? null,
    };
  }

  /**
   * Trello's authorize page. It sends the user back to the frontend with the
   * token in the URL fragment; `state` (bound to this user, short-lived) makes
   * sure a token pushed from elsewhere cannot be linked to the account.
   */
  authorizeUrl(userId: string, now = Date.now()): string {
    if (!this.client.apiKey) {
      throw new ServiceUnavailableException('Trello is not configured');
    }
    const returnUrl = new URL('/trello/callback', this.frontendUrl);
    returnUrl.searchParams.set('state', this.sign(userId, now + STATE_TTL_MS));
    const url = new URL('https://trello.com/1/authorize');
    url.search = new URLSearchParams({
      key: this.client.apiKey,
      name: 'Jarvis',
      scope: 'read,write',
      expiration: 'never',
      response_type: 'token',
      callback_method: 'fragment',
      return_url: returnUrl.toString(),
    }).toString();
    return url.toString();
  }

  /** Checks the token with Trello and stores it (encrypted) for the user. */
  async connect(
    userId: string,
    token: string,
    state: string,
    now = Date.now(),
  ): Promise<TrelloConnection> {
    if (!this.client.available) {
      throw new ServiceUnavailableException('Trello is not configured');
    }
    if (!this.verify(userId, state, now)) {
      throw new BadRequestException(
        'The Trello sign-in link expired or belongs to another session. Try connecting again.',
      );
    }
    let me: { id: string; username: string; fullName?: string };
    try {
      me = await this.client.withToken(token, 'GET', '/members/me', {
        query: { fields: 'id,username,fullName' },
      });
    } catch (err) {
      if (err instanceof ToolError) {
        throw new BadRequestException('Trello did not accept this token.');
      }
      throw err;
    }
    const previous = await this.accounts.findOneBy({ userId });
    await this.accounts.save({
      ...(previous ? { id: previous.id } : {}),
      userId,
      memberId: me.id,
      username: me.username,
      fullName: me.fullName || null,
      tokenEnc: this.cipher.encrypt(token),
    });
    if (previous) await this.revoke(this.cipher.decrypt(previous.tokenEnc));
    return this.status(userId);
  }

  /** Revokes the token at Trello and forgets it. */
  async disconnect(userId: string): Promise<void> {
    const account = await this.accounts.findOneBy({ userId });
    if (!account) return;
    await this.revoke(this.cipher.decrypt(account.tokenEnc));
    await this.accounts.delete({ id: account.id });
  }

  private async revoke(token: string) {
    if (!this.client.available) return;
    try {
      await this.client.withToken(token, 'DELETE', `/tokens/${token}`);
    } catch (err) {
      // Our copy goes anyway; the user can still revoke it in Trello settings.
      this.logger.warn(`Trello token revocation failed: ${String(err)}`);
    }
  }

  private sign(userId: string, expiresAt: number): string {
    const mac = createHmac('sha256', this.stateSecret)
      .update(`trello-connect:${userId}:${expiresAt}`)
      .digest('base64url');
    return `${expiresAt}.${mac}`;
  }

  private verify(userId: string, state: string, now: number): boolean {
    const [exp] = state.split('.');
    const expiresAt = Number(exp);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < now) return false;
    const expected = Buffer.from(this.sign(userId, expiresAt));
    const given = Buffer.from(state);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
