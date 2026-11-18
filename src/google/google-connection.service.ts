import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TokenCipher } from '../common/crypto/token-cipher.js';
import { GoogleAccount } from './google-account.entity.js';
import { SCOPE_CALENDAR_EVENTS, SCOPE_TASKS } from './google-client.service.js';
import { GoogleOAuthService } from './google-oauth.service.js';

export interface GoogleConnection {
  connected: boolean;
  /** Which services the user actually granted. */
  services: { calendar: boolean; tasks: boolean };
  connectedAt: Date | null;
}

@Injectable()
export class GoogleConnectionService {
  private readonly logger = new Logger(GoogleConnectionService.name);

  constructor(
    @InjectRepository(GoogleAccount)
    private readonly accounts: Repository<GoogleAccount>,
    private readonly oauth: GoogleOAuthService,
    private readonly cipher: TokenCipher,
  ) {}

  async status(userId: string): Promise<GoogleConnection> {
    const account = await this.accounts.findOneBy({ userId });
    return {
      connected: Boolean(account),
      services: {
        calendar: account?.scopes.includes(SCOPE_CALENDAR_EVENTS) ?? false,
        tasks: account?.scopes.includes(SCOPE_TASKS) ?? false,
      },
      connectedAt: account?.createdAt ?? null,
    };
  }

  /**
   * Revokes access at Google and deletes the stored tokens. The user stays
   * signed in; signing in with Google again reconnects.
   */
  async disconnect(userId: string): Promise<void> {
    const account = await this.accounts.findOneBy({ userId });
    if (!account) return;
    try {
      await this.oauth.revoke(this.cipher.decrypt(account.refreshTokenEnc));
    } catch (err) {
      // Our copy of the tokens is deleted anyway; the user can still remove
      // the app at myaccount.google.com/permissions.
      this.logger.warn(`Google token revocation failed: ${String(err)}`);
    }
    await this.accounts.delete({ id: account.id });
  }
}
