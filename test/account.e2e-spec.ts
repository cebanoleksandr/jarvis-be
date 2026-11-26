import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { z } from 'zod';
import { defineTool, ToolError } from './../src/agent/tool.js';
import { AuthService } from './../src/auth/auth.service.js';
import { Conversation } from './../src/chat/conversation.entity.js';
import { Message } from './../src/chat/message.entity.js';
import { TokenCipher } from './../src/common/crypto/token-cipher.js';
import { localClock } from './../src/common/time.js';
import { GoogleAccount } from './../src/google/google-account.entity.js';
import {
  SCOPE_CALENDAR_EVENTS,
  SCOPE_TASKS,
} from './../src/google/google-client.service.js';
import { GoogleDataService } from './../src/google/google-data.service.js';
import { GoogleOAuthService } from './../src/google/google-oauth.service.js';
import { GoogleToolsService } from './../src/google/google-tools.service.js';
import { Goal } from './../src/memory/goal.entity.js';
import { Memory } from './../src/memory/memory.entity.js';
import { User } from './../src/users/user.entity.js';

/** Stand-in for Google: records calls, returns canned data or a preset error. */
class FakeGoogleData {
  calls: unknown[][] = [];
  error: Error | null = null;

  async events(...args: unknown[]) {
    this.calls.push(['events', ...args]);
    if (this.error) throw this.error;
    return { timezone: args[1], events: [], truncated: false };
  }

  async tasks(...args: unknown[]) {
    this.calls.push(['tasks', ...args]);
    if (this.error) throw this.error;
    return { tasks: [{ id: 't1', title: 'Pay rent' }], truncated: false };
  }
}

/** Stand-in for the real update_task, which would call Google. */
const taskUpdates: unknown[][] = [];
const fakeUpdateTask = defineTool({
  name: 'update_task',
  description: 'test',
  mutating: true,
  input: z
    .object({
      taskId: z.string().regex(/^[\w-]{1,200}$/),
      status: z.enum(['needsAction', 'completed']).optional(),
    })
    .strict(),
  summarize: () => ({ title: 'Change task', details: {} }),
  async execute(ctx, v) {
    taskUpdates.push([ctx.userId, ctx.timezone, v]);
    if (v.taskId === 'gone')
      throw new ToolError('Not found in Google: the task was deleted.');
    return { id: v.taskId, status: v.status };
  },
});

describe('Google data, connection and account (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const data = new FakeGoogleData();
  const revoked: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GoogleDataService)
      .useValue(data)
      .overrideProvider(GoogleToolsService)
      .useValue({ tools: [fakeUpdateTask] })
      .overrideProvider(GoogleOAuthService)
      .useValue({
        revoke: async (token: string) => {
          revoked.push(token);
        },
      })
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(DataSource);
  });

  afterAll(async () => {
    await db.getRepository(User).delete(userIds);
    await app.close();
  });

  beforeEach(() => {
    data.calls = [];
    data.error = null;
    revoked.length = 0;
  });

  const http = () => request(app.getHttpServer());

  /** A user with a session cookie and, optionally, a connected Google account. */
  async function makeUser(opts: { google?: boolean; timezone?: string } = {}) {
    const user = await db.getRepository(User).save({
      email: `acc-${randomUUID()}@example.com`,
      name: 'Test',
      timezone: opts.timezone ?? 'UTC',
    });
    userIds.push(user.id);
    if (opts.google) {
      await db.getRepository(GoogleAccount).save({
        userId: user.id,
        googleSub: randomUUID(),
        refreshTokenEnc: app.get(TokenCipher).encrypt(`refresh-${user.id}`),
        scopes: [SCOPE_CALENDAR_EVENTS, SCOPE_TASKS],
      });
    }
    const cookie = `jarvis_session=${await app.get(AuthService).issueSession(user.id)}`;
    return { user, cookie };
  }

  describe('GET /calendar/events', () => {
    it("defaults to today in the user's timezone", async () => {
      const { user, cookie } = await makeUser({
        timezone: 'Pacific/Kiritimati',
      });
      await http()
        .get('/api/calendar/events')
        .set('Cookie', cookie)
        .expect(200);

      const today = localClock(new Date(), 'Pacific/Kiritimati').date;
      expect(data.calls).toEqual([
        ['events', user.id, 'Pacific/Kiritimati', { from: today, to: today }],
      ]);
    });

    it('accepts a range and rejects bad ones', async () => {
      const { cookie } = await makeUser();
      await http()
        .get('/api/calendar/events?from=2026-11-01&to=2026-11-07')
        .set('Cookie', cookie)
        .expect(200);
      expect(data.calls[0][3]).toEqual({
        from: '2026-11-01',
        to: '2026-11-07',
      });

      for (const q of [
        'from=2026-11-01&to=2026-12-15', // longer than 31 days
        'from=2026-11-07&to=2026-11-01', // reversed
        'from=tomorrow',
        'from=2026-11-01&calendarId=other', // unknown parameter
      ]) {
        await http()
          .get(`/api/calendar/events?${q}`)
          .set('Cookie', cookie)
          .expect(400);
      }
    });

    it('maps Google failures to 409 (reconnect) and 502', async () => {
      const { cookie } = await makeUser();
      data.error = new ToolError('No Google account is connected.', {
        reauthRequired: true,
      });
      const res = await http()
        .get('/api/calendar/events')
        .set('Cookie', cookie)
        .expect(409);
      expect(res.body.code).toBe('google_reauth_required');

      data.error = new ToolError('Google denied the request');
      await http()
        .get('/api/calendar/events')
        .set('Cookie', cookie)
        .expect(502);
    });

    it('requires a session', async () => {
      await http().get('/api/calendar/events').expect(401);
    });
  });

  describe('GET /tasks', () => {
    it('lists open tasks by default and completed ones on request', async () => {
      const { user, cookie } = await makeUser();
      const res = await http()
        .get('/api/tasks')
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body.tasks[0].title).toBe('Pay rent');

      await http()
        .get('/api/tasks?includeCompleted=true')
        .set('Cookie', cookie)
        .expect(200);
      expect(data.calls).toEqual([
        ['tasks', user.id, false],
        ['tasks', user.id, true],
      ]);

      await http()
        .get('/api/tasks?includeCompleted=yes')
        .set('Cookie', cookie)
        .expect(400);
    });
  });

  describe('PATCH /tasks/:id', () => {
    it('completes and reopens a task through update_task', async () => {
      const { user, cookie } = await makeUser();
      await http()
        .patch('/api/tasks/t1')
        .set('Cookie', cookie)
        .send({ done: true })
        .expect(200, { id: 't1', done: true });
      await http()
        .patch('/api/tasks/t1')
        .set('Cookie', cookie)
        .send({ done: false })
        .expect(200, { id: 't1', done: false });
      expect(taskUpdates.slice(-2)).toEqual([
        [user.id, user.timezone, { taskId: 't1', status: 'completed' }],
        [user.id, user.timezone, { taskId: 't1', status: 'needsAction' }],
      ]);

      await http()
        .patch('/api/tasks/gone')
        .set('Cookie', cookie)
        .send({ done: true })
        .expect(502);
      await http()
        .patch('/api/tasks/t1')
        .set('Cookie', cookie)
        .send({ done: 1 })
        .expect(400);
      await http().patch('/api/tasks/t1').send({ done: true }).expect(401);
    });
  });

  describe('/google/connection', () => {
    it('reports granted services', async () => {
      const { cookie } = await makeUser({ google: true });
      const res = await http()
        .get('/api/google/connection')
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body).toMatchObject({
        connected: true,
        services: { calendar: true, tasks: true },
      });

      const other = await makeUser();
      const none = await http()
        .get('/api/google/connection')
        .set('Cookie', other.cookie)
        .expect(200);
      expect(none.body).toEqual({
        connected: false,
        services: { calendar: false, tasks: false },
        connectedAt: null,
      });
    });

    it('disconnect revokes the token at Google and forgets it', async () => {
      const { user, cookie } = await makeUser({ google: true });
      await http()
        .delete('/api/google/connection')
        .set('Cookie', cookie)
        .expect(204);

      expect(revoked).toEqual([`refresh-${user.id}`]);
      expect(
        await db.getRepository(GoogleAccount).findOneBy({ userId: user.id }),
      ).toBeNull();
      // The session survives: the user is still signed in.
      await http().get('/api/auth/me').set('Cookie', cookie).expect(200);
      // A second disconnect is a no-op.
      await http()
        .delete('/api/google/connection')
        .set('Cookie', cookie)
        .expect(204);
    });
  });

  describe('/account', () => {
    async function seed(userId: string) {
      await db
        .getRepository(Goal)
        .save({ userId, title: 'Run a marathon', notes: '', status: 'active' });
      await db.getRepository(Memory).save({ userId, text: 'Likes mornings' });
      const conv = await db
        .getRepository(Conversation)
        .save({ userId, title: 'Hello', kind: 'chat' });
      await db.getRepository(Message).save({
        conversationId: conv.id,
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      });
    }

    it('exports only the caller’s data, without tokens', async () => {
      const alice = await makeUser({ google: true });
      const bob = await makeUser();
      await seed(alice.user.id);
      await seed(bob.user.id);

      const res = await http()
        .get('/api/account/export')
        .set('Cookie', alice.cookie)
        .expect(200);
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="jarvis-export-\d{4}-\d{2}-\d{2}\.json"$/,
      );
      expect(res.body.user).toMatchObject({ id: alice.user.id });
      expect(res.body.goals).toHaveLength(1);
      expect(res.body.memories).toHaveLength(1);
      expect(res.body.conversations).toHaveLength(1);
      expect(res.body.conversations[0].messages[0].content).toEqual([
        { type: 'text', text: 'hi' },
      ]);
      expect(res.body.google.connected).toBe(true);

      const text = JSON.stringify(res.body);
      expect(text).not.toContain(bob.user.id);
      expect(text).not.toContain('refresh');
      expect(text).not.toContain('TokenEnc');
    });

    it('deletes the account only when the email matches', async () => {
      const alice = await makeUser({ google: true });
      const bob = await makeUser();
      await seed(alice.user.id);
      await seed(bob.user.id);

      await http()
        .delete('/api/account')
        .set('Cookie', alice.cookie)
        .send({ email: 'someone@else.com' })
        .expect(400);
      await http()
        .delete('/api/account')
        .set('Cookie', alice.cookie)
        .expect(400);

      const res = await http()
        .delete('/api/account')
        .set('Cookie', alice.cookie)
        .send({ email: alice.user.email.toUpperCase() })
        .expect(204);
      expect(String(res.headers['set-cookie'])).toMatch(/jarvis_session=;/);
      expect(revoked).toEqual([`refresh-${alice.user.id}`]);

      const id = alice.user.id;
      expect(await db.getRepository(User).findOneBy({ id })).toBeNull();
      expect(await db.getRepository(Goal).countBy({ userId: id })).toBe(0);
      expect(await db.getRepository(Conversation).countBy({ userId: id })).toBe(
        0,
      );
      expect(
        await db.getRepository(GoogleAccount).countBy({ userId: id }),
      ).toBe(0);

      // Bob is untouched.
      expect(
        await db.getRepository(Goal).countBy({ userId: bob.user.id }),
      ).toBe(1);
      expect(
        await db.getRepository(Conversation).countBy({ userId: bob.user.id }),
      ).toBe(1);
    });
  });
});
