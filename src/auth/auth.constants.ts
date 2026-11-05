import type { CookieOptions } from 'express';

export const SESSION_COOKIE = 'jarvis_session';
export const OAUTH_FLOW_COOKIE = 'jarvis_oauth';
export const OAUTH_FLOW_COOKIE_PATH = '/api/auth/google';
export const OAUTH_FLOW_TTL_SECONDS = 10 * 60;

export function baseCookieOptions(production: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure: production,
    // Lax: sent on the top-level redirect back from Google, not on cross-site POSTs.
    sameSite: 'lax',
  };
}
