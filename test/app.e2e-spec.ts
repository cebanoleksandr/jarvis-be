import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { GoogleOAuthService } from './../src/google/google-oauth.service.js';
import { GoogleAccount } from './../src/google/google-account.entity.js';
import { User } from './../src/users/user.entity.js';
import { TokenCipher } from './../src/common/crypto/token-cipher.js';

// Requires a running Postgres (DATABASE_URL), e.g. `docker compose up -d postgres`.
describe('App (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  const cookiesOf = (res: request.Response): string[] => {
    const raw = res.headers['set-cookie'] as unknown;
    return Array.isArray(raw) ? (raw as string[]) : [];
  };
  const cookie = (res: request.Response, name: string) =>
    cookiesOf(res).find((c) => c.startsWith(`${name}=`));

  it('GET /api/health is public and reports db up', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok', db: 'up' });
  });

  describe('session guard', () => {
    it('rejects /api/auth/me without a session', () => {
      return request(app.getHttpServer()).get('/api/auth/me').expect(401);
    });

    it('rejects a forged session cookie', () => {
      return request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', 'jarvis_session=not-a-jwt')
        .expect(401);
    });

    it('does not accept the OAuth flow cookie as a session', async () => {
      const start = await request(app.getHttpServer()).get('/api/auth/google');
      const flow = cookie(start, 'jarvis_oauth')!.split(';')[0].split('=')[1];
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', `jarvis_session=${flow}`)
        .expect(401);
    });
  });

  describe('Google login', () => {
    it('redirects to Google with offline access, consent, PKCE and scopes', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/google')
        .expect(302);

      const url = new URL(res.headers.location);
      expect(url.host).toBe('accounts.google.com');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('scope')).toContain('calendar.events');
      expect(url.searchParams.get('scope')).toContain('auth/tasks');

      const flow = cookie(res, 'jarvis_oauth');
      expect(flow).toMatch(/HttpOnly/i);
      expect(flow).toMatch(/Path=\/api\/auth\/google/);
    });

    it('rejects a callback whose state does not match', async () => {
      const start = await request(app.getHttpServer()).get('/api/auth/google');
      const flow = cookie(start, 'jarvis_oauth')!.split(';')[0];

      const res = await request(app.getHttpServer())
        .get('/api/auth/google/callback?code=abc&state=wrong')
        .set('Cookie', flow)
        .expect(302);
      expect(res.headers.location).toMatch(
        /\/login\?error=google_auth_failed$/,
      );
      expect(cookie(res, 'jarvis_session')).toBeUndefined();
    });

    it('creates the user, stores encrypted tokens and opens a session', async () => {
      const sub = `test-${randomUUID()}`;
      const email = `${sub}@example.com`;
      const google = app.get(GoogleOAuthService);
      const exchange = vi.spyOn(google, 'exchangeCode').mockResolvedValue({
        tokens: {
          access_token: 'access-plain',
          refresh_token: 'refresh-plain',
          expiry_date: Date.now() + 3600_000,
          scope: 'openid https://www.googleapis.com/auth/tasks',
        },
        profile: {
          sub,
          email,
          name: 'Test User',
          picture: 'https://lh3.googleusercontent.com/a/photo',
        },
      });

      try {
        const start = await request(app.getHttpServer()).get(
          '/api/auth/google',
        );
        const state = new URL(start.headers.location).searchParams.get(
          'state',
        )!;
        const flow = cookie(start, 'jarvis_oauth')!.split(';')[0];

        const cb = await request(app.getHttpServer())
          .get(`/api/auth/google/callback?code=the-code&state=${state}`)
          .set('Cookie', flow)
          .expect(302);
        expect(cb.headers.location).toBe('http://localhost:5173');
        expect(exchange).toHaveBeenCalledWith('the-code', expect.any(String));

        const session = cookie(cb, 'jarvis_session');
        expect(session).toMatch(/HttpOnly/i);
        expect(session).toMatch(/SameSite=Lax/i);

        const me = await request(app.getHttpServer())
          .get('/api/auth/me')
          .set('Cookie', session!.split(';')[0])
          .expect(200);
        expect(me.body).toMatchObject({
          email,
          name: 'Test User',
          timezone: 'UTC',
          avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
        });

        const account = await db
          .getRepository(GoogleAccount)
          .findOneByOrFail({ googleSub: sub });
        expect(account.userId).toBe(me.body.id);
        expect(account.refreshTokenEnc).not.toContain('refresh-plain');
        expect(app.get(TokenCipher).decrypt(account.refreshTokenEnc)).toBe(
          'refresh-plain',
        );
        expect(account.scopes).toEqual([
          'openid',
          'https://www.googleapis.com/auth/tasks',
        ]);

        // Second login without a refresh token keeps the stored one.
        exchange.mockResolvedValueOnce({
          tokens: { access_token: 'access-2', scope: 'openid' },
          profile: { sub, email, name: 'Test User' },
        });
        const start2 = await request(app.getHttpServer()).get(
          '/api/auth/google',
        );
        const state2 = new URL(start2.headers.location).searchParams.get(
          'state',
        )!;
        await request(app.getHttpServer())
          .get(`/api/auth/google/callback?code=c2&state=${state2}`)
          .set('Cookie', cookie(start2, 'jarvis_oauth')!.split(';')[0])
          .expect(302);
        const again = await db
          .getRepository(GoogleAccount)
          .findOneByOrFail({ googleSub: sub });
        expect(app.get(TokenCipher).decrypt(again.refreshTokenEnc)).toBe(
          'refresh-plain',
        );
        expect(await db.getRepository(User).countBy({ email })).toBe(1);
      } finally {
        exchange.mockRestore();
        await db.getRepository(User).delete({ email });
      }
    });
  });

  it('POST /api/auth/logout clears the session cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .expect(204);
    expect(cookie(res, 'jarvis_session')).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});
