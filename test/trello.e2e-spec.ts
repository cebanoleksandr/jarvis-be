import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { AuthService } from './../src/auth/auth.service.js';
import { TrelloAccount } from './../src/trello/trello-account.entity.js';
import { User } from './../src/users/user.entity.js';

// ConfigModule reads the environment when AppModule is imported, so the test
// key must be in place before the imports run (it wins over .env).
const savedKey = vi.hoisted(() => {
  const saved = process.env.TRELLO_API_KEY;
  process.env.TRELLO_API_KEY = 'test-key';
  return saved;
});

const GOOD = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const BOARD = '1'.repeat(24);
const LIST = '2'.repeat(24);
const DONE_LIST = '3'.repeat(24);
const CARD = 'c'.repeat(24);

/** Stand-in for api.trello.com; everything else goes to the real fetch. */
const trello = {
  revoked: [] as string[],
  calls: [] as { method: string; path: string; auth: string | null }[],
  /** Tokens Trello accepts. */
  valid: new Set([GOOD, OTHER]),
  /** The card's done tick, changed by PUT /cards/:id. */
  dueComplete: false,
};

function fakeTrello(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? 'GET';
  const auth = new Headers(init?.headers).get('Authorization');
  trello.calls.push({ method, path: url.pathname, auth });
  const token = /oauth_token="([^"]+)"/.exec(auth ?? '')?.[1] ?? '';
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  if (!trello.valid.has(token)) return json({ message: 'invalid token' }, 401);
  const p = url.pathname.replace(/^\/1/, '');
  if (p === '/members/me')
    return json({
      id: 'm'.repeat(24),
      username: token === GOOD ? 'ann' : 'other',
      fullName: 'Ann',
    });
  if (p.startsWith('/tokens/') && method === 'DELETE') {
    trello.revoked.push(p.slice('/tokens/'.length));
    return json({});
  }
  if (p === '/members/me/boards')
    return json([
      {
        id: BOARD,
        name: 'Home',
        lists: [
          { id: LIST, name: 'To do' },
          { id: DONE_LIST, name: '✅ Done' },
        ],
      },
    ]);
  const overdue = {
    id: CARD,
    name: 'Overdue card',
    due: '2020-01-01T10:00:00.000Z',
    dueComplete: trello.dueComplete,
    idList: LIST,
    idBoard: BOARD,
    url: 'https://trello.com/c/x',
    labels: [],
    dateLastActivity: new Date().toISOString(),
  };
  if (p === `/boards/${BOARD}/cards/open`)
    return json([
      overdue,
      // Finished by moving it, without ticking the due date.
      {
        ...overdue,
        id: 'd'.repeat(24),
        name: 'Moved to Done',
        dueComplete: false,
        idList: DONE_LIST,
      },
    ]);
  if (p === `/cards/${CARD}` && method === 'GET')
    return json({
      ...overdue,
      board: { name: 'Home' },
      list: { name: 'To do' },
    });
  if (p === `/cards/${CARD}` && method === 'PUT') {
    const body = JSON.parse(init?.body as string) as {
      dueComplete?: boolean;
    };
    if (body.dueComplete !== undefined) trello.dueComplete = body.dueComplete;
    return json({ ...overdue, dueComplete: trello.dueComplete });
  }
  return json({ message: 'not found' }, 404);
}

describe('Trello connection (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const realFetch = globalThis.fetch;
  const userIds: string[] = [];
  let alice: string;
  let aliceId: string;
  let bob: string;

  beforeAll(async () => {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).startsWith(
        'https://api.trello.com/',
      )
        ? fakeTrello(input, init)
        : realFetch(input, init)) as typeof fetch;

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(DataSource);

    const auth = app.get(AuthService);
    const session = async () => {
      const user = await db.getRepository(User).save({
        email: `trello-${randomUUID()}@example.com`,
        name: 'T',
        timezone: 'Europe/Kyiv',
      });
      userIds.push(user.id);
      return {
        cookie: `jarvis_session=${await auth.issueSession(user.id)}`,
        id: user.id,
      };
    };
    ({ cookie: alice, id: aliceId } = await session());
    ({ cookie: bob } = await session());
  });

  afterAll(async () => {
    await db.getRepository(User).delete(userIds);
    await app.close();
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.TRELLO_API_KEY;
    else process.env.TRELLO_API_KEY = savedKey;
  });

  beforeEach(() => {
    trello.revoked.length = 0;
    trello.calls.length = 0;
    trello.valid = new Set([GOOD, OTHER]);
  });

  const http = () => request(app.getHttpServer());
  const start = async (cookie = alice) => {
    const res = await http()
      .post('/api/trello/connection/start')
      .set('Cookie', cookie)
      .expect(200);
    const url = new URL(res.body.url);
    const back = new URL(url.searchParams.get('return_url')!);
    return { url, back, state: back.searchParams.get('state')! };
  };
  const connect = (token: string, state: string, cookie = alice) =>
    http()
      .post('/api/trello/connection')
      .set('Cookie', cookie)
      .send({ token, state });

  it('starts at trello.com with a return URL bound to the user', async () => {
    const status = await http()
      .get('/api/trello/connection')
      .set('Cookie', alice)
      .expect(200);
    expect(status.body).toMatchObject({ available: true, connected: false });

    const { url, back, state } = await start();
    expect(url.origin + url.pathname).toBe('https://trello.com/1/authorize');
    expect(url.searchParams.get('key')).toBe('test-key');
    expect(url.searchParams.get('scope')).toBe('read,write');
    expect(back.pathname).toBe('/trello/callback');
    expect(state).toMatch(/^\d+\.[\w-]+$/);
  });

  it('refuses a state from another user or a tampered one', async () => {
    const { state } = await start(bob);
    await connect(GOOD, state).expect(400);
    await connect(
      GOOD,
      state.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
    ).expect(400);
    await connect(GOOD, `${Date.now() - 1000}.x`).expect(400);
    await connect('short', state, bob).expect(400);
    expect(
      await db.getRepository(TrelloAccount).countBy({ userId: aliceId }),
    ).toBe(0);
  });

  it('refuses a token Trello does not accept', async () => {
    const { state } = await start();
    trello.valid = new Set();
    await connect(GOOD, state).expect(400);
  });

  it('connects, stores the token encrypted, reads cards and disconnects', async () => {
    const { state } = await start();
    const res = await connect(GOOD, state).expect(200);
    expect(res.body).toMatchObject({ connected: true, username: 'ann' });
    const row = await db
      .getRepository(TrelloAccount)
      .findOneByOrFail({ userId: aliceId });
    expect(row.tokenEnc).not.toContain(GOOD);
    // The key and token travel in the header, never in the URL.
    expect(trello.calls.every((c) => c.auth?.includes('test-key'))).toBe(true);

    const due = await http()
      .get('/api/trello/cards/due')
      .set('Cookie', alice)
      .expect(200);
    expect(due.body.cards).toEqual([
      expect.objectContaining({
        name: 'Overdue card',
        due: '2020-01-01T12:00',
        board: { id: BOARD, name: 'Home' },
        list: { id: LIST, name: 'To do' },
      }),
    ]);

    // Reconnecting with another account revokes the old token.
    const again = await start();
    await connect(OTHER, again.state).expect(200);
    expect(trello.revoked).toEqual([GOOD]);

    await http()
      .delete('/api/trello/connection')
      .set('Cookie', alice)
      .expect(204);
    expect(trello.revoked).toEqual([GOOD, OTHER]);
    expect(
      await db.getRepository(TrelloAccount).countBy({ userId: aliceId }),
    ).toBe(0);
  });

  it('ticks a due card done and back from the Today page', async () => {
    const { state } = await start();
    await connect(GOOD, state).expect(200);
    const due = (query = '') =>
      http()
        .get(`/api/trello/cards/due${query}`)
        .set('Cookie', alice)
        .expect(200)
        .then((r) => r.body.cards as { name: string; dueComplete: boolean }[]);

    const done = await http()
      .patch(`/api/trello/cards/${CARD}`)
      .set('Cookie', alice)
      .send({ done: true })
      .expect(200);
    expect(done.body).toEqual({ id: CARD, done: true });
    expect(trello.calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: `/1/cards/${CARD}`,
    });
    // Gone from the open cards, still listed as finished today on request.
    expect(await due()).toEqual([]);
    expect(await due('?includeDoneToday=true')).toEqual([
      expect.objectContaining({ name: 'Overdue card', dueComplete: true }),
    ]);

    await http()
      .patch(`/api/trello/cards/${CARD}`)
      .set('Cookie', alice)
      .send({ done: false })
      .expect(200, { id: CARD, done: false });
    expect((await due()).map((c) => c.name)).toEqual(['Overdue card']);

    for (const [id, body] of [
      ['not-an-id', { done: true }],
      [CARD, { done: 'yes' }],
      [CARD, { done: true, name: 'x' }],
    ] as const) {
      await http()
        .patch(`/api/trello/cards/${id}`)
        .set('Cookie', alice)
        .send(body)
        .expect(400);
    }
    await http()
      .patch(`/api/trello/cards/${CARD}`)
      .send({ done: true })
      .expect(401);
    await http()
      .delete('/api/trello/connection')
      .set('Cookie', alice)
      .expect(204);
  });

  it('asks to reconnect when Trello revoked the token', async () => {
    const { state } = await start();
    await connect(GOOD, state).expect(200);
    trello.valid = new Set();
    const res = await http()
      .get('/api/trello/cards/due')
      .set('Cookie', alice)
      .expect(409);
    expect(res.body.code).toBe('trello_reauth_required');
    await http()
      .delete('/api/trello/connection')
      .set('Cookie', alice)
      .expect(204);
  });

  it('exports the connection without the token and revokes it on account deletion', async () => {
    const { state } = await start(bob);
    await connect(GOOD, state, bob).expect(200);
    const exported = await http()
      .get('/api/account/export')
      .set('Cookie', bob)
      .expect(200);
    expect(exported.text).not.toContain(GOOD);
    expect(exported.body.trello).toMatchObject({
      connected: true,
      username: 'ann',
    });

    const email = exported.body.user.email;
    await http()
      .delete('/api/account')
      .set('Cookie', bob)
      .send({ email })
      .expect(204);
    expect(trello.revoked).toContain(GOOD);
  });
});
