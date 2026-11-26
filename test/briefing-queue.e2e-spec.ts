import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { AuthService } from './../src/auth/auth.service.js';
import { Conversation } from './../src/chat/conversation.entity.js';
import { localClock } from './../src/common/time.js';
import { GoogleToolsService } from './../src/google/google-tools.service.js';
import {
  type ChatRequest,
  type ChatStreamEvent,
  LlmProvider,
} from './../src/llm/llm.types.js';
import {
  BriefingQueue,
  briefingJobId,
} from './../src/scheduler/briefing-queue.service.js';
import type { BriefingJob } from './../src/scheduler/scheduler.service.js';
import { SchedulerService } from './../src/scheduler/scheduler.service.js';
import { TrelloToolsService } from './../src/trello/trello-tools.service.js';
import { User } from './../src/users/user.entity.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6381';

/** The queue tests need a Redis (docker compose up -d redis). */
async function redisUp(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
const available = await redisUp();

class ReplyLlm extends LlmProvider {
  async *streamChat(_req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    yield {
      type: 'done',
      result: {
        content: [{ type: 'text', text: 'Good morning!' }],
        stopReason: 'end_turn',
        toolCalls: [],
        model: 'scripted',
        usage: {},
      },
    };
  }
}

describe.skipIf(!available)('Briefing queue on Redis (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let briefings: BriefingQueue;
  let scheduler: SchedulerService;
  let jobs: Queue;
  const prefix = `jarvis-test-${randomUUID().slice(0, 8)}`;
  const userIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LlmProvider)
      .useValue(new ReplyLlm())
      .overrideProvider(GoogleToolsService)
      .useValue({ tools: [] })
      .overrideProvider(TrelloToolsService)
      .useValue({ tools: [] })
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(DataSource);
    scheduler = app.get(SchedulerService);
    briefings = app.get(BriefingQueue);
    // Off under NODE_ENV=test; started here without the all-users check.
    await briefings.start(REDIS_URL, { prefix, reconcile: false });
    jobs = new Queue('briefings', {
      connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
      prefix,
    });
  });

  afterAll(async () => {
    await briefings.stop();
    await jobs.obliterate({ force: true });
    await jobs.close();
    await db.getRepository(User).delete(userIds);
    await app.close();
  });

  const newUser = async (timezone = 'Europe/Kyiv') => {
    const user = await db.getRepository(User).save({
      email: `queue-${randomUUID()}@example.com`,
      name: 'Q',
      timezone,
    });
    userIds.push(user.id);
    const cookie = `jarvis_session=${await app.get(AuthService).issueSession(user.id)}`;
    return { id: user.id, cookie };
  };
  const http = () => request(app.getHttpServer());
  const jobOf = async (
    kind: 'morning' | 'evening' | 'weekly',
    userId: string,
  ) => jobs.getJob(briefingJobId(kind, userId));

  it('plans one delayed job per briefing at its next local time', async () => {
    const u = await newUser();
    const now = new Date();
    await briefings.plan(u.id, now);
    const plans = await scheduler.plansFor(u.id, now);
    expect(plans.map((p) => p.kind)).toEqual(['morning', 'evening', 'weekly']);
    for (const p of plans) {
      const job = await jobOf(p.kind, u.id);
      expect(job?.data).toEqual({
        userId: u.id,
        kind: p.kind,
        localDate: p.localDate,
      } satisfies BriefingJob);
      expect(job!.timestamp + job!.delay).toBeGreaterThanOrEqual(
        p.at.getTime() - 1000,
      );
    }
    // Planning again keeps the same jobs.
    const before = (await jobOf('evening', u.id))!.timestamp;
    await briefings.plan(u.id, now);
    expect((await jobOf('evening', u.id))!.timestamp).toBe(before);
  });

  it('re-plans when settings or the time zone change', async () => {
    const u = await newUser();
    await briefings.plan(u.id);
    await http()
      .patch('/api/notifications')
      .set('Cookie', u.cookie)
      .send({ morningEnabled: false })
      .expect(200);
    await vi.waitFor(async () =>
      expect(await jobOf('morning', u.id)).toBeUndefined(),
    );
    expect(await jobOf('evening', u.id)).toBeDefined();

    const kyiv = (await jobOf('evening', u.id))!;
    await http()
      .patch('/api/profile')
      .set('Cookie', u.cookie)
      .send({ timezone: 'America/New_York' })
      .expect(200);
    await vi.waitFor(async () => {
      const ny = (await jobOf('evening', u.id))!;
      // 21:00 in New York is 7 hours after 21:00 in Kyiv.
      expect(ny.timestamp + ny.delay).not.toBe(kyiv.timestamp + kyiv.delay);
      const plan = (await scheduler.plansFor(u.id, new Date())).find(
        (p) => p.kind === 'evening',
      )!;
      expect(
        Math.abs(ny.timestamp + ny.delay - plan.at.getTime()),
      ).toBeLessThan(1000);
    });
  });

  it('runs a due briefing and plans the next day', async () => {
    const u = await newUser();
    // A morning time a few minutes ago in Kyiv, so the job is due now.
    const clock = localClock(new Date(), 'Europe/Kyiv');
    const minutes = clock.minutes - Math.min(5, clock.minutes);
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    await http()
      .patch('/api/notifications')
      .set('Cookie', u.cookie)
      .send({ morningTime: time, eveningEnabled: false, weeklyEnabled: false })
      .expect(200);

    await vi.waitFor(
      async () => {
        const [c] = await db
          .getRepository(Conversation)
          .findBy({ userId: u.id, kind: 'morning' });
        expect(c).toBeDefined();
        const next = await jobOf('morning', u.id);
        expect(next?.data).toMatchObject({ localDate: expect.any(String) });
        expect((next!.data as BriefingJob).localDate > clock.date).toBe(true);
      },
      { timeout: 10_000, interval: 200 },
    );
  });
});
