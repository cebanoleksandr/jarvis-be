import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Credentials, OAuth2Client } from 'google-auth-library';
import { Repository } from 'typeorm';
import { ToolError } from '../agent/tool.js';
import { TokenCipher } from '../common/crypto/token-cipher.js';
import { GoogleAccount } from './google-account.entity.js';
import { GoogleOAuthService } from './google-oauth.service.js';

export const SCOPE_CALENDAR_EVENTS =
  'https://www.googleapis.com/auth/calendar.events';
export const SCOPE_TASKS = 'https://www.googleapis.com/auth/tasks';

const SCOPE_LABELS: Record<string, string> = {
  [SCOPE_CALENDAR_EVENTS]: 'Google Calendar',
  [SCOPE_TASKS]: 'Google Tasks',
};

const REAUTH_HINT = 'Ask the user to sign in with Google again to reconnect.';

/**
 * Per-user authenticated Google client. The OAuth client refreshes the access
 * token itself; refreshed tokens are written back encrypted.
 */
@Injectable()
export class GoogleClientService {
  private readonly logger = new Logger(GoogleClientService.name);

  constructor(
    @InjectRepository(GoogleAccount)
    private readonly accounts: Repository<GoogleAccount>,
    private readonly oauth: GoogleOAuthService,
    private readonly cipher: TokenCipher,
  ) {}

  async forUser(userId: string, requiredScope: string): Promise<OAuth2Client> {
    const account = await this.accounts.findOneBy({ userId });
    if (!account) {
      throw new ToolError(`No Google account is connected. ${REAUTH_HINT}`, {
        reauthRequired: true,
      });
    }
    if (!account.scopes.includes(requiredScope)) {
      throw new ToolError(
        `The user has not granted access to ${SCOPE_LABELS[requiredScope] ?? requiredScope}. ${REAUTH_HINT}`,
        { reauthRequired: true },
      );
    }

    const client = this.oauth.createClient();
    client.setCredentials({
      refresh_token: this.cipher.decrypt(account.refreshTokenEnc),
      access_token: account.accessTokenEnc
        ? this.cipher.decrypt(account.accessTokenEnc)
        : undefined,
      expiry_date: account.expiresAt?.getTime(),
    });
    client.on('tokens', (tokens) => {
      this.persistTokens(account.id, tokens).catch((err: unknown) =>
        this.logger.error(
          `Failed to store refreshed Google token: ${String(err)}`,
        ),
      );
    });
    return client;
  }

  private async persistTokens(accountId: string, tokens: Credentials) {
    const patch: Partial<GoogleAccount> = {};
    if (tokens.access_token)
      patch.accessTokenEnc = this.cipher.encrypt(tokens.access_token);
    if (tokens.expiry_date) patch.expiresAt = new Date(tokens.expiry_date);
    if (tokens.refresh_token)
      patch.refreshTokenEnc = this.cipher.encrypt(tokens.refresh_token);
    if (Object.keys(patch).length) await this.accounts.update(accountId, patch);
  }
}

/** Runs a Google API call and turns failures into messages the model can act on. */
export async function callGoogle<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolError) throw err;
    const e = err as {
      status?: number;
      response?: { status?: number; data?: { error?: unknown } };
      message?: string;
    };
    const status = e.status ?? e.response?.status;
    const oauthError = e.response?.data?.error;
    if (oauthError === 'invalid_grant' || status === 401) {
      throw new ToolError(
        `Google access has expired or was revoked. ${REAUTH_HINT}`,
        { reauthRequired: true },
      );
    }
    if (status === 403) {
      throw new ToolError(
        `Google denied the request: ${e.message ?? 'forbidden'}`,
      );
    }
    if (status === 404) throw new ToolError('Not found in Google.');
    if (status === 400) {
      throw new ToolError(
        `Google rejected the request: ${e.message ?? 'bad request'}`,
      );
    }
    throw err;
  }
}
