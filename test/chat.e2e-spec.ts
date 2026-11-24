import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { AuthService } from './../src/auth/auth.service.js';
import { MAX_PINNED } from './../src/chat/chat.service.js';
import { Conversation } from './../src/chat/conversation.entity.js';
import { Message } from './../src/chat/message.entity.js';
import {
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  LlmProvider,
} from './../src/llm/llm.types.js';
import { User } from './../src/users/user.entity.js';

class FakeLlm extends LlmProvider {
  requests: ChatRequest[] = [];
  chunks = ['Hel', 'lo!'];
  result: Partial<ChatResult> = {};

  async *streamChat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    this.requests.push(req);
    for (const text of this.chunks) yield { type: 'text', text };
    yield {
      type: 'done',
      result: {
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: this.chunks.join('') },
        ],
        stopReason: 'end_turn',
        toolCalls: [],
        model: 'fake-model',
        usage: { input_tokens: 10, output_tokens: 2 },
        ...this.result,
      },
    };
  }
}

function parseSse(body: string) {
  return body
    .trim()
    .split('\n\n')
    .map((chunk) => {
      const event = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = /^data: (.+)$/m.exec(chunk)?.[1];
      return { event, data: data ? JSON.parse(data) : undefined };
    });
}

describe('Chat (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const llm = new FakeLlm();
  const users: User[] = [];
  const sessions: string[] = [];

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
    for (const name of ['Alice', 'Bob']) {
      const user = await db.getRepository(User).save({
        email: `chat-${randomUUID()}@example.com`,
        name,
      });
      users.push(user);
      sessions.push(`jarvis_session=${await auth.issueSession(user.id)}`);
    }
  });

  afterAll(async () => {
    await db.getRepository(User).delete(users.map((u) => u.id));
    await app.close();
  });

  beforeEach(() => {
    llm.requests = [];
    llm.chunks = ['Hel', 'lo!'];
    llm.result = {};
  });

  const http = () => request(app.getHttpServer());
  const newConversation = async (session = sessions[0]) =>
    (await http().post('/api/conversations').set('Cookie', session).expect(201))
      .body.id as string;

  it('requires a session', () => http().get('/api/conversations').expect(401));

  it('streams the reply over SSE and persists both messages', async () => {
    const id = await newConversation();

    const res = await http()
      .post(`/api/conversations/${id}/messages`)
      .set('Cookie', sessions[0])
      .send({ text: '  Plan my week  ' })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'delta',
      'delta',
      'done',
    ]);
    expect(events[1].data).toEqual({ text: 'Hel' });
    expect(events[3].data).toMatchObject({ stopReason: 'end_turn' });

    // The model saw the user message and a system prompt with the user's name.
    expect(llm.requests[0].messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Plan my week' }] },
    ]);
    expect(llm.requests[0].system).toContain('Name: Alice');

    const messages = await http()
      .get(`/api/conversations/${id}/messages`)
      .set('Cookie', sessions[0])
      .expect(200);
    expect(messages.body.map((m: Message) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
    // Thinking blocks are stored so they can be replayed unchanged.
    expect(messages.body[1].content[0]).toMatchObject({ type: 'thinking' });

    const list = await http()
      .get('/api/conversations')
      .set('Cookie', sessions[0]);
    expect(list.body.find((c: { id: string }) => c.id === id).title).toBe(
      'Plan my week',
    );
  });

  it('sends the full history on the next turn', async () => {
    const id = await newConversation();
    for (const text of ['first', 'second']) {
      await http()
        .post(`/api/conversations/${id}/messages`)
        .set('Cookie', sessions[0])
        .send({ text })
        .expect(200);
    }
    expect(llm.requests[1].messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('does not save a refused reply', async () => {
    const id = await newConversation();
    llm.result = { stopReason: 'refusal', content: [] };

    const res = await http()
      .post(`/api/conversations/${id}/messages`)
      .set('Cookie', sessions[0])
      .send({ text: 'hi' })
      .expect(200);
    expect(parseSse(res.text).at(-1)).toEqual({
      event: 'done',
      data: { assistantMessageId: null, stopReason: 'refusal' },
    });
    expect(
      await db.getRepository(Message).countBy({ conversationId: id }),
    ).toBe(1);
  });

  it('reports a provider failure as an SSE error event', async () => {
    const id = await newConversation();
    const spy = vi
      .spyOn(llm, 'streamChat')
      .mockImplementation(async function* () {
        yield* [];
        throw new Error('upstream down');
      });
    try {
      const res = await http()
        .post(`/api/conversations/${id}/messages`)
        .set('Cookie', sessions[0])
        .send({ text: 'hi' })
        .expect(200);
      expect(parseSse(res.text).at(-1)?.event).toBe('error');
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects empty text with 400', async () => {
    const id = await newConversation();
    await http()
      .post(`/api/conversations/${id}/messages`)
      .set('Cookie', sessions[0])
      .send({ text: '   ' })
      .expect(400);
  });

  it("hides another user's conversation behind 404", async () => {
    const id = await newConversation(sessions[0]);
    const bob = sessions[1];
    await http()
      .get(`/api/conversations/${id}/messages`)
      .set('Cookie', bob)
      .expect(404);
    await http()
      .post(`/api/conversations/${id}/messages`)
      .set('Cookie', bob)
      .send({ text: 'hi' })
      .expect(404);
    await http()
      .delete(`/api/conversations/${id}`)
      .set('Cookie', bob)
      .expect(404);
    expect(llm.requests).toHaveLength(0);

    const bobs = await http().get('/api/conversations').set('Cookie', bob);
    expect(bobs.body.some((c: { id: string }) => c.id === id)).toBe(false);
  });

  it('tracks when a conversation was read without reordering it', async () => {
    const own = (
      await http().post('/api/conversations').set('Cookie', sessions[0])
    ).body;
    // Chats the user starts are read from the start.
    expect(own.readAt).toEqual(expect.any(String));

    const briefing = await db.getRepository(Conversation).save({
      userId: (
        await db.getRepository(Conversation).findOneByOrFail({ id: own.id })
      ).userId,
      kind: 'morning',
      title: 'Morning briefing',
    });
    const before = await db
      .getRepository(Conversation)
      .findOneByOrFail({ id: briefing.id });
    expect(before.readAt).toBeNull();

    await http()
      .post(`/api/conversations/${briefing.id}/read`)
      .set('Cookie', sessions[1])
      .expect(404);
    await http()
      .post(`/api/conversations/${briefing.id}/read`)
      .set('Cookie', sessions[0])
      .expect(204);
    const after = await db
      .getRepository(Conversation)
      .findOneByOrFail({ id: briefing.id });
    expect(after.readAt).toBeInstanceOf(Date);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

    // Reading again keeps the first time.
    await http()
      .post(`/api/conversations/${briefing.id}/read`)
      .set('Cookie', sessions[0])
      .expect(204);
    expect(
      (
        await db
          .getRepository(Conversation)
          .findOneByOrFail({ id: briefing.id })
      ).readAt!.getTime(),
    ).toBe(after.readAt!.getTime());
  });

  it('renames a conversation without reordering it', async () => {
    const id = await newConversation();
    const before = await db.getRepository(Conversation).findOneByOrFail({ id });

    const res = await http()
      .patch(`/api/conversations/${id}`)
      .set('Cookie', sessions[0])
      .send({ title: '  Launch plan  ' })
      .expect(200);
    expect(res.body).toMatchObject({ title: 'Launch plan', customTitle: true });

    const after = await db.getRepository(Conversation).findOneByOrFail({ id });
    expect(after.title).toBe('Launch plan');
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

    // The first message no longer names the chat once the user did.
    await http()
      .post(`/api/conversations/${id}/messages`)
      .set('Cookie', sessions[0])
      .send({ text: 'hello there' });
    expect(
      (await db.getRepository(Conversation).findOneByOrFail({ id })).title,
    ).toBe('Launch plan');

    await http()
      .patch(`/api/conversations/${id}`)
      .set('Cookie', sessions[0])
      .send({ title: '   ' })
      .expect(400);
    await http()
      .patch(`/api/conversations/${id}`)
      .set('Cookie', sessions[1])
      .send({ title: 'mine now' })
      .expect(404);
  });

  it('pins conversations to the top without touching their activity', async () => {
    const cookie = sessions[1];
    const create = async () =>
      (await http().post('/api/conversations').set('Cookie', cookie)).body
        .id as string;
    const older = await create();
    const newer = await create();
    const listIds = async () =>
      (await http().get('/api/conversations').set('Cookie', cookie)).body.map(
        (c: { id: string }) => c.id,
      ) as string[];
    const before = await listIds();
    expect(before.indexOf(newer)).toBeLessThan(before.indexOf(older));

    const pinned = await http()
      .patch(`/api/conversations/${older}`)
      .set('Cookie', cookie)
      .send({ pinned: true })
      .expect(200);
    expect(pinned.body.pinnedAt).toEqual(expect.any(String));
    expect((await listIds())[0]).toBe(older);

    // Pinning again keeps the original time.
    const again = await http()
      .patch(`/api/conversations/${older}`)
      .set('Cookie', cookie)
      .send({ pinned: true })
      .expect(200);
    expect(again.body.pinnedAt).toBe(pinned.body.pinnedAt);

    const unpinned = await http()
      .patch(`/api/conversations/${older}`)
      .set('Cookie', cookie)
      .send({ pinned: false })
      .expect(200);
    expect(unpinned.body.pinnedAt).toBeNull();
    const after = await listIds();
    expect(after.indexOf(newer)).toBeLessThan(after.indexOf(older));

    await http()
      .patch(`/api/conversations/${older}`)
      .set('Cookie', cookie)
      .send({})
      .expect(400);
    await http()
      .patch(`/api/conversations/${older}`)
      .set('Cookie', sessions[0])
      .send({ pinned: true })
      .expect(404);
  });

  it('limits how many conversations can be pinned', async () => {
    const cookie = sessions[1];
    const ids: string[] = [];
    for (let i = 0; i <= MAX_PINNED; i++)
      ids.push(
        (await http().post('/api/conversations').set('Cookie', cookie)).body.id,
      );
    for (const id of ids.slice(0, MAX_PINNED))
      await http()
        .patch(`/api/conversations/${id}`)
        .set('Cookie', cookie)
        .send({ pinned: true })
        .expect(200);
    await http()
      .patch(`/api/conversations/${ids[MAX_PINNED]}`)
      .set('Cookie', cookie)
      .send({ pinned: true })
      .expect(400);
    for (const id of ids)
      await http()
        .delete(`/api/conversations/${id}`)
        .set('Cookie', cookie)
        .expect(204);
  });

  it('deletes a conversation with its messages', async () => {
    const id = await newConversation();
    await http()
      .post(`/api/conversations/${id}/messages`)
      .set('Cookie', sessions[0])
      .send({ text: 'hi' });
    await http()
      .delete(`/api/conversations/${id}`)
      .set('Cookie', sessions[0])
      .expect(204);
    expect(
      await db.getRepository(Message).countBy({ conversationId: id }),
    ).toBe(0);
  });
});
