import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Credentials } from 'google-auth-library';
import { DataSource } from 'typeorm';
import { TokenCipher } from '../common/crypto/token-cipher.js';
import type { Env } from '../config/env.validation.js';
import { GoogleAccount } from '../google/google-account.entity.js';
import {
  type GoogleProfile,
  GoogleOAuthService,
} from '../google/google-oauth.service.js';
import { UserEvents } from '../users/user-events.js';
import { User } from '../users/user.entity.js';
import { OAUTH_FLOW_TTL_SECONDS } from './auth.constants.js';

interface OAuthFlowPayload {
  typ: 'oauth';
  state: string;
  cv: string;
}

interface SessionPayload {
  typ: 'session';
  sub: string;
}

@Injectable()
export class AuthService {
  private readonly sessionTtlSeconds: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
    private readonly google: GoogleOAuthService,
    private readonly cipher: TokenCipher,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly userEvents: UserEvents,
  ) {
    this.sessionTtlSeconds =
      config.get('SESSION_TTL_DAYS', { infer: true }) * 24 * 60 * 60;
  }

  get sessionMaxAgeMs(): number {
    return this.sessionTtlSeconds * 1000;
  }

  /** Starts the OAuth flow: consent URL plus a signed cookie with state and PKCE verifier. */
  async startGoogleLogin(): Promise<{ url: string; flowToken: string }> {
    const state = randomBytes(24).toString('base64url');
    const { url, codeVerifier } = await this.google.buildAuthUrl(state);
    const flowToken = await this.jwt.signAsync(
      { typ: 'oauth', state, cv: codeVerifier } satisfies OAuthFlowPayload,
      { expiresIn: OAUTH_FLOW_TTL_SECONDS },
    );
    return { url, flowToken };
  }

  async completeGoogleLogin(params: {
    code: string;
    state: string;
    flowToken: string;
  }): Promise<User> {
    const flow = await this.verify<OAuthFlowPayload>(params.flowToken, 'oauth');
    if (!flow || !safeEqual(flow.state, params.state)) {
      throw new UnauthorizedException('Invalid OAuth state');
    }
    const { tokens, profile } = await this.google.exchangeCode(
      params.code,
      flow.cv,
    );
    const user = await this.upsertGoogleUser(profile, tokens);
    // A new user, or one back after a break: plan their briefings now.
    this.userEvents.scheduleChanged(user.id);
    return user;
  }

  issueSession(userId: string): Promise<string> {
    return this.jwt.signAsync(
      { typ: 'session', sub: userId } satisfies SessionPayload,
      { expiresIn: this.sessionTtlSeconds },
    );
  }

  /** Returns the userId for a valid session token, otherwise null. */
  async verifySession(token: string): Promise<string | null> {
    const payload = await this.verify<SessionPayload>(token, 'session');
    return payload?.sub ?? null;
  }

  private async verify<T extends { typ: string }>(
    token: string,
    typ: T['typ'],
  ): Promise<T | null> {
    try {
      const payload = await this.jwt.verifyAsync<T>(token, {
        algorithms: ['HS256'],
      });
      return payload.typ === typ ? payload : null;
    } catch {
      return null;
    }
  }

  private upsertGoogleUser(
    profile: GoogleProfile,
    tokens: Credentials,
  ): Promise<User> {
    return this.dataSource.transaction(async (m) => {
      let account = await m.findOneBy(GoogleAccount, {
        googleSub: profile.sub,
      });
      let user: User;

      if (account) {
        user = await m.findOneByOrFail(User, { id: account.userId });
      } else {
        user =
          (await m.findOneBy(User, { email: profile.email })) ??
          m.create(User, { email: profile.email });
      }
      user.email = profile.email;
      user.name = profile.name ?? user.name ?? null;
      // Google decides the photo: a removed one is cleared here too.
      user.avatarUrl = safeAvatarUrl(profile.picture);
      user = await m.save(user);

      account ??= m.create(GoogleAccount, {
        userId: user.id,
        googleSub: profile.sub,
      });
      if (tokens.refresh_token) {
        account.refreshTokenEnc = this.cipher.encrypt(tokens.refresh_token);
      } else if (!account.refreshTokenEnc) {
        throw new UnauthorizedException(
          'Google did not return a refresh token',
        );
      }
      account.accessTokenEnc = tokens.access_token
        ? this.cipher.encrypt(tokens.access_token)
        : null;
      account.expiresAt = tokens.expiry_date
        ? new Date(tokens.expiry_date)
        : null;
      account.scopes = tokens.scope?.split(' ').filter(Boolean) ?? [];
      await m.save(account);

      return user;
    });
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Only https URLs end up in an <img src>; anything else is dropped. */
export function safeAvatarUrl(url: string | null | undefined): string | null {
  if (!url || url.length > 2048) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
