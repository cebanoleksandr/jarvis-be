import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CodeChallengeMethod,
  type Credentials,
  OAuth2Client,
} from 'google-auth-library';
import type { Env } from '../config/env.validation.js';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
];

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
}

@Injectable()
export class GoogleOAuthService {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(config: ConfigService<Env, true>) {
    this.clientId = config.get('GOOGLE_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('GOOGLE_CLIENT_SECRET', { infer: true });
    this.redirectUri = config.get('GOOGLE_CALLBACK_URL', { infer: true });
  }

  createClient(): OAuth2Client {
    return new OAuth2Client({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
    });
  }

  /** Consent URL with PKCE. The caller must keep `codeVerifier` for the callback. */
  async buildAuthUrl(state: string) {
    const client = this.createClient();
    const { codeVerifier, codeChallenge } =
      await client.generateCodeVerifierAsync();
    const url = client.generateAuthUrl({
      // offline + consent: otherwise Google returns the refresh token only once.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: GOOGLE_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    return { url, codeVerifier };
  }

  /**
   * Revokes the grant behind a token (refresh or access) at Google, so the
   * app disappears from the user's Google account permissions.
   */
  async revoke(token: string): Promise<void> {
    const res = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(5000),
    });
    // 400 invalid_token: already revoked or expired, which is the goal anyway.
    if (!res.ok && res.status !== 400) {
      throw new Error(`Google revoke failed with ${res.status}`);
    }
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<{ tokens: Credentials; profile: GoogleProfile }> {
    const client = this.createClient();
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.id_token) {
      throw new UnauthorizedException('Google did not return an ID token');
    }
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      throw new UnauthorizedException('Google account email is not verified');
    }
    return {
      tokens,
      profile: {
        sub: payload.sub,
        email: payload.email.toLowerCase(),
        name: payload.name ?? null,
      },
    };
  }
}
