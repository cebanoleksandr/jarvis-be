import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { z } from 'zod';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { PendingAction } from './../src/agent/pending-action.entity.js';
import { defineTool } from './../src/agent/tool.js';
import { AuthService } from './../src/auth/auth.service.js';
import { Conversation } from './../src/chat/conversation.entity.js';
import { GoogleToolsService } from './../src/google/google-tools.service.js';
import { TrelloToolsService } from './../src/trello/trello-tools.service.js';
import {
  type ChatRequest,
  type ChatStreamEvent,
  type ContentBlock,
  LlmProvider,
} from './../src/llm/llm.types.js';
import { ScheduledRun } from './../src/scheduler/scheduled-run.entity.js';
import { SchedulerService } from './../src/scheduler/scheduler.service.js';
import { User } from './../src/users/user.entity.js';

const testTools = [
  defineTool({
    name: 'get_events',
    description: 'Read-only',
    mutating: false,
    input: z.object({}).strict(),
    async execute() {
      return { events: [{ title: 'Standup' }] };
    },
  }),
  defineTool({
    name: 'make_note',
    description: 'Mutating',
    mutating: true,
    input: z.object({ title: z.string() }).strict(),
    summarize: ({ title }) => ({
      title: 'Make note',
      details: { Title: title },
    }),
    async execute() {
      throw new Error('must not run without confirmation');
    },
  }),
];

type Step = { content: ContentBlock[]; stopReason: string } | Error;
const text = (t: string): Step => ({
  content: [{ type: 'text', text: t }],
  stopReason: 'end_turn',
});
const call = (name: string, input: unknown = {}): Step => ({
  content: [{ type: 'tool_use', id: `tu_${randomUUID()}`, name, input }],
  stopReason: 'tool_use',
});

/** Answers per user (found by the name in the system prompt), so parallel runs do not mix. */
class ScriptedLlm extends LlmProvider {
  scripts = new Map<string, Step[]>();
  requests: ChatRequest[] = [];

  async *streamChat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const name = /Name: (\S+)/.exec(req.system)?.[1] ?? '';
    const step = this.scripts.get(name)?.shift();
    if (!step) throw new Error(`Script exhausted for ${name}`);
    if (step instanceof Error) throw step;
    yield {
      type: 'done',
      result: {
        ...step,
        toolCalls: step.content
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({
            id: b.id as string,
            name: b.name as string,
            input: b.input,
          })),
        model: 'scripted',
        usage: {},
      },
    };
  }
}

describe('Scheduler (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let scheduler: SchedulerService;
  const llm = new ScriptedLlm();
  const userIds: string[] = [];

  // Thursday 2026-11-12, 08:10 in Kyiv (UTC+2).
  const MORNING = new Date('2026-11-12T06:10:00Z');

  const newUser = async (patch: Partial<User> = {}) => {
    const name = `u${randomUUID().slice(0, 8)}`;
    const user = await db.getRepository(User).save({
      email: `sched-${randomUUID()}@example.com`,
      name,
      timezone: 'Europe/Kyiv',
      ...patch,
    });
    userIds.push(user.id);
    const cookie = `jarvis_session=${await app.get(AuthService).issueSession(user.id)}`;
    return { id: user.id, name, cookie };
  };
  const http = () => request(app.getHttpServer());
  /**
   * What the queue does at `now`: every planned job whose time has come
   * fires. Returns how many briefings were claimed (sent or failed).
   */
  const fire = async (now: Date, ids: string[]) => {
    let claimed = 0;
    for (const userId of ids) {
      for (const p of await scheduler.plansFor(userId, now)) {
        if (p.at > now) continue;
        const outcome = await scheduler.runPlanned(
          { userId, kind: p.kind, localDate: p.localDate },
          now,
        );
        if (outcome !== 'skipped') claimed++;
      }
    }
    return claimed;
  };
  const runsOf = (userId: string) =>
    db.getRepository(ScheduledRun).findBy({ userId });
  const conversationsOf = async (cookie: string) =>
    (await http().get('/api/conversations').set('Cookie', cookie).expect(200))
      .body as { id: string; title: string; kind: string }[];
  const messagesOf = async (cookie: string, id: string) =>
    (
      await http()
        .get(`/api/conversations/${id}/messages`)
        .set('Cookie', cookie)
        .expect(200)
    ).body as { role: string; synthetic: boolean; content: ContentBlock[] }[];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LlmProvider)
      .useValue(llm)
      .overrideProvider(GoogleToolsService)
      .useValue({ tools: testTools })
      .overrideProvider(TrelloToolsService)
      .useValue({ tools: [] })
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(DataSource);
    scheduler = app.get(SchedulerService);
  });

  afterAll(async () => {
    await db.getRepository(User).delete(userIds);
    await app.close();
  });

  beforeEach(() => {
    llm.scripts.clear();
    llm.requests = [];
  });

  it('sends the morning briefing once, as a new conversation', async () => {
    const u = await newUser();
    llm.scripts.set(u.name, [call('get_events'), text('Good morning!')]);

    expect(await fire(MORNING, [u.id])).toBe(1);
    // Later ticks inside the same window do nothing.
    expect(await fire(new Date('2026-11-12T06:40:00Z'), [u.id])).toBe(0);

    const [conversation, ...rest] = await conversationsOf(u.cookie);
    expect(rest).toEqual([]);
    expect(conversation).toMatchObject({
      kind: 'morning',
      title: 'Morning briefing · 2026-11-12',
      readAt: null,
    });

    const messages = await messagesOf(u.cookie, conversation.id);
    expect(messages.map((m) => [m.role, m.synthetic])).toEqual([
      ['user', true],
      ['assistant', false],
      ['user', false], // tool result
      ['assistant', false],
    ]);
    expect(messages.at(-1)!.content).toEqual([
      { type: 'text', text: 'Good morning!' },
    ]);
    expect(llm.requests[0].messages[0].content[0].text).toMatch(
      /^\[Automated request .*Thursday 2026-11-12 08:10/,
    );

    expect(await runsOf(u.id)).toMatchObject([
      {
        kind: 'morning',
        localDate: '2026-11-12',
        status: 'done',
        conversationId: conversation.id,
      },
    ]);
  });

  it('writes the briefing in the language the user chose', async () => {
    const u = await newUser({ language: 'es' });
    llm.scripts.set(u.name, [text('Buenos días')]);
    expect(await fire(MORNING, [u.id])).toBe(1);
    const prompt = llm.requests.at(-1)!.messages[0].content[0].text;
    expect(prompt).toContain('Write in Spanish');
  });

  it('sends a briefing once when the same job fires twice', async () => {
    const u = await newUser();
    llm.scripts.set(u.name, [text('Hi')]);
    const job = {
      userId: u.id,
      kind: 'morning' as const,
      localDate: '2026-11-12',
    };
    const outcomes = await Promise.all([
      scheduler.runPlanned(job, MORNING),
      scheduler.runPlanned(job, MORNING),
    ]);
    expect(outcomes.toSorted()).toEqual(['sent', 'skipped']);
    expect(await conversationsOf(u.cookie)).toHaveLength(1);
  });

  it('plans the next run of each briefing in the user time zone', async () => {
    const u = await newUser({ timezone: 'America/New_York' });
    // Thursday 2026-11-12 01:10 in New York.
    const plans = await scheduler.plansFor(u.id, MORNING);
    expect(plans).toEqual([
      {
        kind: 'morning',
        localDate: '2026-11-12',
        at: new Date('2026-11-12T13:00:00Z'),
      },
      {
        kind: 'evening',
        localDate: '2026-11-12',
        at: new Date('2026-11-13T02:00:00Z'),
      },
      // Sunday 18:00 in New York.
      {
        kind: 'weekly',
        localDate: '2026-11-15',
        at: new Date('2026-11-15T23:00:00Z'),
      },
    ]);

    // Once today's morning is sent, the next one is tomorrow.
    llm.scripts.set(u.name, [text('Morning')]);
    const at = new Date('2026-11-12T13:30:00Z');
    expect(
      await scheduler.runPlanned(
        { userId: u.id, kind: 'morning', localDate: '2026-11-12' },
        at,
      ),
    ).toBe('sent');
    expect((await scheduler.plansFor(u.id, at))[0]).toEqual({
      kind: 'morning',
      localDate: '2026-11-13',
      at: new Date('2026-11-13T13:00:00Z'),
    });
  });

  it('skips a job planned under settings that changed since', async () => {
    const u = await newUser();
    await http()
      .patch('/api/notifications')
      .set('Cookie', u.cookie)
      .send({ morningTime: '10:00' })
      .expect(200);
    // The old 08:00 job fires: no longer due.
    expect(
      await scheduler.runPlanned(
        { userId: u.id, kind: 'morning', localDate: '2026-11-12' },
        MORNING,
      ),
    ).toBe('skipped');
    // A job for another day (time zone moved the date) is not due either.
    expect(
      await scheduler.runPlanned(
        { userId: u.id, kind: 'morning', localDate: '2026-11-11' },
        new Date('2026-11-12T08:10:00Z'),
      ),
    ).toBe('skipped');
    expect(await runsOf(u.id)).toEqual([]);
  });

  it('follows the user time zone and settings', async () => {
    const ny = await newUser({ timezone: 'America/New_York' });
    const off = await newUser();
    const late = await newUser();
    await http()
      .patch('/api/notifications')
      .set('Cookie', off.cookie)
      .send({ morningEnabled: false })
      .expect(200);
    const patched = await http()
      .patch('/api/notifications')
      .set('Cookie', late.cookie)
      .send({ morningTime: '09:30' })
      .expect(200);
    expect(patched.body).toMatchObject({
      morningTime: '09:30',
      eveningTime: '21:00',
      weeklyDay: 0,
    });

    // 08:10 in Kyiv is 01:10 in New York.
    expect(await fire(MORNING, [ny.id, off.id, late.id])).toBe(0);

    llm.scripts.set(late.name, [text('Later')]);
    expect(
      await fire(new Date('2026-11-12T07:30:00Z'), [off.id, late.id]),
    ).toBe(1);
    llm.scripts.set(ny.name, [text('NY')]);
    expect(await fire(new Date('2026-11-12T13:00:00Z'), [ny.id])).toBe(1);
  });

  it('skips users who have been inactive for two weeks', async () => {
    const stale = await newUser();
    await db
      .getRepository(User)
      .update(stale.id, { lastActiveAt: new Date('2026-10-20T00:00:00Z') });
    const recent = await newUser();
    await db
      .getRepository(User)
      .update(recent.id, { lastActiveAt: new Date('2026-11-05T00:00:00Z') });
    llm.scripts.set(recent.name, [text('Hi')]);

    expect(await fire(MORNING, [stale.id, recent.id])).toBe(1);
    expect(await runsOf(stale.id)).toEqual([]);
    // Nothing is planned for them until they come back.
    expect(await scheduler.plansFor(stale.id, MORNING)).toEqual([]);
    expect(await scheduler.activeUserIds(MORNING)).not.toContain(stale.id);
  });

  it('records a failure, removes the empty conversation and does not retry', async () => {
    const u = await newUser();
    llm.scripts.set(u.name, [new Error('model is down')]);

    expect(await fire(MORNING, [u.id])).toBe(1);
    expect(await conversationsOf(u.cookie)).toEqual([]);
    expect(await runsOf(u.id)).toMatchObject([
      { status: 'failed', error: 'model is down', conversationId: null },
    ]);
    expect(await fire(MORNING, [u.id])).toBe(0);
  });

  it('leaves mutating calls waiting for the user', async () => {
    const u = await newUser();
    llm.scripts.set(u.name, [call('make_note', { title: 'Plan' })]);

    expect(await fire(MORNING, [u.id])).toBe(1);
    const [conversation] = await conversationsOf(u.cookie);
    expect(
      await db
        .getRepository(PendingAction)
        .findBy({ conversationId: conversation.id }),
    ).toMatchObject([{ tool: 'make_note', status: 'pending' }]);
    expect(await runsOf(u.id)).toMatchObject([{ status: 'done' }]);
  });

  it('lets the user reply in a briefing and marks them active', async () => {
    const u = await newUser();
    llm.scripts.set(u.name, [
      text('How was your day?'),
      text('Glad to hear it.'),
    ]);
    // 21:05 in Kyiv.
    expect(await fire(new Date('2026-11-12T19:05:00Z'), [u.id])).toBe(1);
    const [conversation] = await conversationsOf(u.cookie);
    expect(conversation.kind).toBe('evening');

    await http()
      .post(`/api/conversations/${conversation.id}/messages`)
      .set('Cookie', u.cookie)
      .send({ text: 'Good' })
      .expect(200);
    const after = await conversationsOf(u.cookie);
    expect(after[0].title).toBe('Evening check-in · 2026-11-12');
    const user = await db.getRepository(User).findOneByOrFail({ id: u.id });
    expect(user.lastActiveAt).toBeInstanceOf(Date);
  });

  it('runs a briefing on demand', async () => {
    const u = await newUser();
    llm.scripts.set(u.name, [text('Your week')]);
    const res = await http()
      .post('/api/notifications/weekly/run')
      .set('Cookie', u.cookie)
      .expect(202);
    const id = res.body.conversationId as string;

    await vi.waitFor(async () => {
      const messages = await messagesOf(u.cookie, id);
      expect(messages.at(-1)).toMatchObject({ role: 'assistant' });
    });
    expect(
      await db.getRepository(Conversation).findOneByOrFail({ id }),
    ).toMatchObject({ kind: 'weekly', userId: u.id });
    // On-demand runs do not use up the scheduled one.
    expect(await runsOf(u.id)).toEqual([]);

    await http()
      .post('/api/notifications/nope/run')
      .set('Cookie', u.cookie)
      .expect(400);
  });

  it('validates settings and requires a session', async () => {
    const u = await newUser();
    await http().get('/api/notifications').expect(401);
    expect(
      (
        await http()
          .get('/api/notifications')
          .set('Cookie', u.cookie)
          .expect(200)
      ).body,
    ).toMatchObject({ morningEnabled: true, morningTime: '08:00' });
    for (const body of [
      { morningTime: '8:00' },
      { eveningTime: '24:00' },
      { weeklyDay: 7 },
      { userId: randomUUID() },
    ]) {
      await http()
        .patch('/api/notifications')
        .set('Cookie', u.cookie)
        .send(body)
        .expect(400);
    }
  });
});
