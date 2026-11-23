import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { AuthService } from './../src/auth/auth.service.js';
import {
  type ChatRequest,
  type ChatStreamEvent,
  LlmProvider,
} from './../src/llm/llm.types.js';
import { User } from './../src/users/user.entity.js';

class RecordingLlm extends LlmProvider {
  requests: ChatRequest[] = [];
  async *streamChat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    this.requests.push(req);
    yield {
      type: 'done',
      result: {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        toolCalls: [],
        model: 'fake',
        usage: {},
      },
    };
  }
}

describe('Profile, goals and memories (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const llm = new RecordingLlm();
  const userIds: string[] = [];
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LlmProvider)
      .useValue(llm)
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(DataSource);

    const auth = app.get(AuthService);
    const session = async (name: string) => {
      const user = await db
        .getRepository(User)
        .save({ email: `mem-${randomUUID()}@example.com`, name });
      userIds.push(user.id);
      return `jarvis_session=${await auth.issueSession(user.id)}`;
    };
    alice = await session('Alice');
    bob = await session('Bob');
  });

  afterAll(async () => {
    await db.getRepository(User).delete(userIds);
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('profile', () => {
    it('returns defaults before anything is saved', async () => {
      const res = await http()
        .get('/api/profile')
        .set('Cookie', alice)
        .expect(200);
      expect(res.body).toMatchObject({
        name: 'Alice',
        timezone: 'UTC',
        about: '',
        preferences: {},
      });
    });

    it('updates profile fields and user timezone', async () => {
      const res = await http()
        .patch('/api/profile')
        .set('Cookie', alice)
        .send({
          timezone: 'Europe/Kyiv',
          about: 'Developer',
          preferences: { workHours: '9-18' },
        })
        .expect(200);
      expect(res.body).toMatchObject({
        name: 'Alice',
        timezone: 'Europe/Kyiv',
        about: 'Developer',
        preferences: { workHours: '9-18' },
      });

      // Partial update keeps the other fields.
      const again = await http()
        .patch('/api/profile')
        .set('Cookie', alice)
        .send({ about: 'Backend developer' })
        .expect(200);
      expect(again.body).toMatchObject({
        timezone: 'Europe/Kyiv',
        preferences: { workHours: '9-18' },
      });
    });

    it('stores the UI language', async () => {
      const res = await http()
        .patch('/api/profile')
        .set('Cookie', alice)
        .send({ language: 'pl' })
        .expect(200);
      expect(res.body.language).toBe('pl');
      await http()
        .patch('/api/profile')
        .set('Cookie', alice)
        .send({ language: 'de' })
        .expect(400);
    });

    it('rejects an unknown timezone and unknown fields', async () => {
      await http()
        .patch('/api/profile')
        .set('Cookie', alice)
        .send({ timezone: 'Mars/Olympus' })
        .expect(400);
      await http()
        .patch('/api/profile')
        .set('Cookie', alice)
        .send({ email: 'evil@example.com' })
        .expect(400);
    });
  });

  describe('goals', () => {
    it('builds goal -> project -> task and refuses a fourth level', async () => {
      const create = (body: object) =>
        http().post('/api/goals').set('Cookie', alice).send(body);

      const goal = (
        await create({
          title: 'Run a marathon',
          deadline: '2027-04-01',
        }).expect(201)
      ).body;
      const project = (
        await create({ title: 'Training plan', parentId: goal.id }).expect(201)
      ).body;
      const task = (
        await create({ title: 'Buy shoes', parentId: project.id }).expect(201)
      ).body;
      expect(task).toMatchObject({ status: 'active', parentId: project.id });

      await create({ title: 'Too deep', parentId: task.id }).expect(400);

      const done = await http()
        .patch(`/api/goals/${task.id}`)
        .set('Cookie', alice)
        .send({ status: 'done' })
        .expect(200);
      expect(done.body.status).toBe('done');

      // Cycle: the goal cannot move under its own task.
      await http()
        .patch(`/api/goals/${goal.id}`)
        .set('Cookie', alice)
        .send({ parentId: task.id })
        .expect(400);
    });

    it('validates input', async () => {
      const bad = [
        { title: '' },
        { title: 'x', deadline: '01.04.2027' },
        { title: 'x', status: 'someday' },
        { title: 'x', userId: randomUUID() },
      ];
      for (const body of bad) {
        await http()
          .post('/api/goals')
          .set('Cookie', alice)
          .send(body)
          .expect(400);
      }
    });

    it('deleting a goal removes its subtree', async () => {
      const root = (
        await http()
          .post('/api/goals')
          .set('Cookie', alice)
          .send({ title: 'Temp' })
      ).body;
      await http()
        .post('/api/goals')
        .set('Cookie', alice)
        .send({ title: 'Child', parentId: root.id });
      await http()
        .delete(`/api/goals/${root.id}`)
        .set('Cookie', alice)
        .expect(204);

      const list = (await http().get('/api/goals').set('Cookie', alice))
        .body as { title: string }[];
      expect(list.map((g) => g.title)).not.toContain('Child');
    });

    it("isolates users: no reading, editing, deleting or nesting under someone else's goal", async () => {
      const own = (
        await http()
          .post('/api/goals')
          .set('Cookie', alice)
          .send({ title: 'Private' })
      ).body;

      const bobsList = (await http().get('/api/goals').set('Cookie', bob))
        .body as { id: string }[];
      expect(bobsList.some((g) => g.id === own.id)).toBe(false);
      await http()
        .patch(`/api/goals/${own.id}`)
        .set('Cookie', bob)
        .send({ title: 'pwned' })
        .expect(404);
      await http()
        .delete(`/api/goals/${own.id}`)
        .set('Cookie', bob)
        .expect(404);
      await http()
        .post('/api/goals')
        .set('Cookie', bob)
        .send({ title: 'x', parentId: own.id })
        .expect(400);
    });
  });

  describe('memories', () => {
    it('creates, edits, lists and deletes, scoped to the user', async () => {
      const m = (
        await http()
          .post('/api/memories')
          .set('Cookie', alice)
          .send({ text: 'Likes tea' })
          .expect(201)
      ).body;
      await http()
        .patch(`/api/memories/${m.id}`)
        .set('Cookie', alice)
        .send({ text: 'Prefers green tea' })
        .expect(200);

      await http()
        .patch(`/api/memories/${m.id}`)
        .set('Cookie', bob)
        .send({ text: 'x' })
        .expect(404);
      await http()
        .delete(`/api/memories/${m.id}`)
        .set('Cookie', bob)
        .expect(404);
      expect(
        (await http().get('/api/memories').set('Cookie', bob)).body,
      ).toEqual([]);

      const list = (await http().get('/api/memories').set('Cookie', alice))
        .body;
      expect(list).toEqual([
        expect.objectContaining({ text: 'Prefers green tea' }),
      ]);

      const tmp = (
        await http()
          .post('/api/memories')
          .set('Cookie', alice)
          .send({ text: 'Temp' })
      ).body;
      await http()
        .delete(`/api/memories/${tmp.id}`)
        .set('Cookie', alice)
        .expect(204);
    });

    it("deletes all of a user's memories at once", async () => {
      for (const text of ['One', 'Two'])
        await http()
          .post('/api/memories')
          .set('Cookie', bob)
          .send({ text })
          .expect(201);
      const aliceBefore = (
        await http().get('/api/memories').set('Cookie', alice)
      ).body.length;

      await http().delete('/api/memories').set('Cookie', bob).expect(204);

      expect(
        (await http().get('/api/memories').set('Cookie', bob)).body,
      ).toEqual([]);
      expect(
        (await http().get('/api/memories').set('Cookie', alice)).body,
      ).toHaveLength(aliceBefore);
    });

    it('stores a category, defaulting to other', async () => {
      const rule = (
        await http()
          .post('/api/memories')
          .set('Cookie', bob)
          .send({ text: 'No meetings on Fridays', category: 'directive' })
          .expect(201)
      ).body;
      expect(rule).toEqual(
        expect.objectContaining({
          category: 'directive',
          updatedAt: expect.any(String),
        }),
      );
      const plain = (
        await http()
          .post('/api/memories')
          .set('Cookie', bob)
          .send({ text: 'Has a dog' })
          .expect(201)
      ).body;
      expect(plain.category).toBe('other');

      const moved = (
        await http()
          .patch(`/api/memories/${plain.id}`)
          .set('Cookie', bob)
          .send({ category: 'people' })
          .expect(200)
      ).body;
      expect(moved).toEqual(
        expect.objectContaining({ text: 'Has a dog', category: 'people' }),
      );

      await http()
        .post('/api/memories')
        .set('Cookie', bob)
        .send({ text: 'x', category: 'secret' })
        .expect(400);
      await http()
        .patch(`/api/memories/${plain.id}`)
        .set('Cookie', bob)
        .send({})
        .expect(400);

      for (const m of [rule, plain])
        await http()
          .delete(`/api/memories/${m.id}`)
          .set('Cookie', bob)
          .expect(204);
    });
  });

  it('feeds profile, goals and memories into the system prompt', async () => {
    const conv = (await http().post('/api/conversations').set('Cookie', alice))
      .body;
    await http()
      .post(`/api/conversations/${conv.id}/messages`)
      .set('Cookie', alice)
      .send({ text: 'What should I focus on?' })
      .expect(200);

    const system = llm.requests.at(-1)!.system;
    expect(system).toContain('About: Backend developer');
    expect(system).toContain('- workHours: 9-18');
    expect(system).toContain('- [active, due 2027-04-01] Run a marathon');
    expect(system).toContain('    - [done] Buy shoes');
    expect(system).toContain('- Prefers green tea');
    expect(system).toContain('Timezone: Europe/Kyiv');

    // Bob's prompt has none of Alice's data.
    const bobConv = (await http().post('/api/conversations').set('Cookie', bob))
      .body;
    await http()
      .post(`/api/conversations/${bobConv.id}/messages`)
      .set('Cookie', bob)
      .send({ text: 'hi' })
      .expect(200);
    const bobSystem = llm.requests.at(-1)!.system;
    expect(bobSystem).not.toContain('marathon');
    expect(bobSystem).not.toContain('green tea');
    expect(bobSystem).toContain('<goals>\n(none yet)\n</goals>');
  });
});
