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
import { defineTool, ToolError } from './../src/agent/tool.js';
import { AuthService } from './../src/auth/auth.service.js';
import { GoogleToolsService } from './../src/google/google-tools.service.js';
import {
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type ContentBlock,
  LlmProvider,
} from './../src/llm/llm.types.js';
import { User } from './../src/users/user.entity.js';

// ---------- test tools (stand-ins for Google) ----------
const executed: { tool: string; userId: string; input: unknown }[] = [];
const undone: { userId: string; result: unknown }[] = [];
/** Set to make the next undo fail like Google would. */
let undoError: Error | null = null;
const testTools = [
  defineTool({
    name: 'lookup',
    description: 'Read-only lookup',
    mutating: false,
    input: z.object({ q: z.string() }).strict(),
    async execute(ctx, { q }) {
      executed.push({ tool: 'lookup', userId: ctx.userId, input: { q } });
      return { answer: q.toUpperCase(), userId: ctx.userId };
    },
  }),
  defineTool({
    name: 'broken',
    description: 'Always fails',
    mutating: false,
    input: z.object({}).strict(),
    async execute() {
      throw new ToolError('Service is down');
    },
  }),
  defineTool({
    name: 'make_note',
    description: 'Mutating',
    mutating: true,
    input: z.object({ title: z.string().min(1) }).strict(),
    summarize: ({ title }) => ({
      title: 'Make note',
      details: { Title: title },
    }),
    async execute(ctx, input) {
      executed.push({ tool: 'make_note', userId: ctx.userId, input });
      return { created: input.title };
    },
    async undo(ctx, result) {
      if (undoError) throw undoError;
      undone.push({ userId: ctx.userId, result });
    },
  }),
  defineTool({
    name: 'send_ping',
    description: 'Mutating, cannot be undone',
    mutating: true,
    input: z.object({}).strict(),
    summarize: () => ({ title: 'Ping', details: {} }),
    async execute() {
      return { pinged: true };
    },
  }),
];

// ---------- scripted model ----------
type Step = { text?: string; content: ContentBlock[]; stopReason: string };
const toolUse = (id: string, name: string, input: unknown): ContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const callStep = (...blocks: ContentBlock[]): Step => ({
  content: [{ type: 'text', text: 'Let me check.' }, ...blocks],
  stopReason: 'tool_use',
  text: 'Let me check.',
});
const finalStep = (text = 'All done.'): Step => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  text,
});

class ScriptedLlm extends LlmProvider {
  script: Step[] = [];
  requests: ChatRequest[] = [];

  async *streamChat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    // Copy: the agent reuses arrays between steps.
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const step = this.script.shift();
    if (!step) throw new Error('Script exhausted');
    if (step.text) yield { type: 'text', text: step.text };
    const result: ChatResult = {
      content: step.content,
      stopReason: step.stopReason,
      toolCalls: step.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id as string,
          name: b.name as string,
          input: b.input,
        })),
      model: 'scripted',
      usage: {},
    };
    yield { type: 'done', result };
  }

  lastMessages() {
    return this.requests.at(-1)!.messages;
  }
}

function parseSse(body: string) {
  return body
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => ({
      event: /^event: (.+)$/m.exec(chunk)?.[1],
      data: JSON.parse(/^data: (.+)$/m.exec(chunk)?.[1] ?? 'null'),
    }));
}

describe('Agent loop and confirmations (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const llm = new ScriptedLlm();
  const userIds: string[] = [];
  let alice: string;
  let aliceId: string;
  let bob: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LlmProvider)
      .useValue(llm)
      .overrideProvider(GoogleToolsService)
      .useValue({ tools: testTools })
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(DataSource);

    const auth = app.get(AuthService);
    const session = async () => {
      const user = await db
        .getRepository(User)
        .save({ email: `agent-${randomUUID()}@example.com`, name: 'T' });
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
  });

  beforeEach(() => {
    llm.script = [];
    llm.requests = [];
    executed.length = 0;
    undone.length = 0;
    undoError = null;
  });

  afterEach(() => {
    expect(llm.script).toEqual([]); // every scripted step was consumed
  });

  const http = () => request(app.getHttpServer());
  const newConversation = async () =>
    (await http().post('/api/conversations').set('Cookie', alice).expect(201))
      .body.id as string;
  const say = async (id: string, text: string, cookie = alice) =>
    parseSse(
      (
        await http()
          .post(`/api/conversations/${id}/messages`)
          .set('Cookie', cookie)
          .send({ text })
          .expect(200)
      ).text,
    );
  const decide = (
    actionId: string,
    how: 'confirm' | 'cancel',
    body: object = {},
    cookie = alice,
  ) =>
    http()
      .post(`/api/pending-actions/${actionId}/${how}`)
      .set('Cookie', cookie)
      .send(body);

  it('runs read-only tools in a loop with userId from the session', async () => {
    const id = await newConversation();
    llm.script = [
      callStep(toolUse('t1', 'lookup', { q: 'hello' })),
      finalStep('HELLO it is.'),
    ];

    const events = await say(id, 'look it up');
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'delta',
      'tool_call',
      'tool_result',
      'delta',
      'done',
    ]);
    expect(events.at(-1)!.data.stopReason).toBe('end_turn');

    expect(llm.requests[0].tools!.map((t) => t.name)).toEqual([
      'broken',
      'lookup',
      'make_note',
      'send_ping',
    ]);
    const results = llm.lastMessages().at(-1)!;
    expect(results.role).toBe('user');
    expect(results.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
    });
    expect(JSON.parse(results.content[0].content as string)).toEqual({
      answer: 'HELLO',
      userId: aliceId,
    });
  });

  it('reports invalid input and tool errors back to the model', async () => {
    const id = await newConversation();
    llm.script = [
      callStep(
        toolUse('t1', 'lookup', { q: 'x', userId: 'someone-else' }),
        toolUse('t2', 'broken', {}),
        toolUse('t3', 'nope', {}),
      ),
      finalStep(),
    ];
    await say(id, 'go');

    expect(executed).toEqual([]);
    const [r1, r2, r3] = llm.lastMessages().at(-1)!.content;
    expect(r1).toMatchObject({
      is_error: true,
      content: expect.stringContaining('Invalid input for lookup'),
    });
    expect(r2).toMatchObject({ is_error: true, content: 'Service is down' });
    expect(r3).toMatchObject({ is_error: true, content: 'Unknown tool: nope' });
  });

  it('pauses on a mutating call and runs it only after confirmation', async () => {
    const id = await newConversation();
    llm.script = [callStep(toolUse('t1', 'make_note', { title: 'Buy milk' }))];

    const events = await say(id, 'remind me to buy milk');
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'delta',
      'tool_call',
      'action_required',
      'done',
    ]);
    expect(events.at(-1)!.data.stopReason).toBe('awaiting_confirmation');
    const action = events.find((e) => e.event === 'action_required')!.data;
    expect(action).toMatchObject({
      tool: 'make_note',
      status: 'pending',
      args: { title: 'Buy milk' },
      summary: { title: 'Make note', details: { Title: 'Buy milk' } },
    });
    expect(executed).toEqual([]);

    const pending = await http()
      .get(`/api/conversations/${id}/pending-actions`)
      .set('Cookie', alice);
    expect(pending.body.map((a: { id: string }) => a.id)).toEqual([action.id]);

    llm.script = [finalStep('Noted.')];
    const res = await decide(action.id, 'confirm').expect(200);
    const resumed = parseSse(res.text);
    expect(resumed.map((e) => e.event)).toEqual([
      'action_resolved',
      'delta',
      'done',
    ]);
    expect(resumed[0].data).toMatchObject({
      status: 'executed',
      result: { created: 'Buy milk' },
    });
    expect(executed).toEqual([
      { tool: 'make_note', userId: aliceId, input: { title: 'Buy milk' } },
    ]);

    const results = llm.lastMessages().at(-1)!;
    expect(results.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: '{"created":"Buy milk"}',
      },
    ]);

    // A second click does nothing.
    await decide(action.id, 'confirm').expect(409);
    expect(executed).toHaveLength(1);
  });

  it('runs edited arguments and tells the model', async () => {
    const id = await newConversation();
    llm.script = [callStep(toolUse('t1', 'make_note', { title: 'Buy milk' }))];
    const action = (await say(id, 'note')).find(
      (e) => e.event === 'action_required',
    )!.data;

    await decide(action.id, 'confirm', { args: { title: '' } }).expect(400);
    await decide(action.id, 'confirm', {
      args: { title: 'x', extra: 1 },
    }).expect(400);

    llm.script = [finalStep()];
    await decide(action.id, 'confirm', {
      args: { title: 'Buy oat milk' },
    }).expect(200);
    expect(executed[0].input).toEqual({ title: 'Buy oat milk' });

    const result = JSON.parse(
      llm.lastMessages().at(-1)!.content[0].content as string,
    );
    expect(result).toMatchObject({
      argsUsed: { title: 'Buy oat milk' },
      result: { created: 'Buy oat milk' },
    });
    const row = await db
      .getRepository(PendingAction)
      .findOneByOrFail({ id: action.id });
    expect(row.originalArgs).toEqual({ title: 'Buy milk' });
  });

  it('cancel tells the model the action was declined', async () => {
    const id = await newConversation();
    llm.script = [callStep(toolUse('t1', 'make_note', { title: 'Buy milk' }))];
    const action = (await say(id, 'note')).find(
      (e) => e.event === 'action_required',
    )!.data;

    llm.script = [finalStep('Okay, skipped.')];
    const resumed = parseSse(
      (await decide(action.id, 'cancel').expect(200)).text,
    );
    expect(resumed[0].data.status).toBe('cancelled');
    expect(executed).toEqual([]);
    expect(llm.lastMessages().at(-1)!.content[0]).toMatchObject({
      is_error: true,
      content: expect.stringContaining('declined'),
    });
  });

  it('a new user message dismisses open actions and sends their results first', async () => {
    const id = await newConversation();
    llm.script = [callStep(toolUse('t1', 'make_note', { title: 'Buy milk' }))];
    const action = (await say(id, 'note')).find(
      (e) => e.event === 'action_required',
    )!.data;

    llm.script = [finalStep()];
    await say(id, 'actually never mind');
    expect(executed).toEqual([]);
    expect(llm.lastMessages().at(-1)!.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        tool_use_id: 't1',
        is_error: true,
      }),
      { type: 'text', text: 'actually never mind' },
    ]);
    const row = await db
      .getRepository(PendingAction)
      .findOneByOrFail({ id: action.id });
    expect(row.status).toBe('dismissed');
    await decide(action.id, 'confirm').expect(409);
  });

  it('a mixed turn runs reads at once and resumes with all results in order', async () => {
    const id = await newConversation();
    llm.script = [
      callStep(
        toolUse('t1', 'lookup', { q: 'a' }),
        toolUse('t2', 'make_note', { title: 'one' }),
        toolUse('t3', 'make_note', { title: 'two' }),
      ),
    ];
    const events = await say(id, 'do things');
    const actions = events
      .filter((e) => e.event === 'action_required')
      .map((e) => e.data);
    expect(actions).toHaveLength(2);
    expect(executed.map((e) => e.tool)).toEqual(['lookup']);

    // First decision: still waiting for the second card.
    const first = parseSse(
      (await decide(actions[0].id, 'confirm').expect(200)).text,
    );
    expect(first.map((e) => e.event)).toEqual(['action_resolved', 'done']);
    expect(first[1].data.stopReason).toBe('awaiting_confirmation');
    expect(llm.requests).toHaveLength(1);

    llm.script = [finalStep()];
    await decide(actions[1].id, 'cancel').expect(200);
    const results = llm.lastMessages().at(-1)!.content;
    expect(results.map((r) => [r.tool_use_id, r.is_error ?? false])).toEqual([
      ['t1', false],
      ['t2', false],
      ['t3', true],
    ]);
  });

  it("isolates users' actions", async () => {
    const id = await newConversation();
    llm.script = [callStep(toolUse('t1', 'make_note', { title: 'secret' }))];
    const action = (await say(id, 'note')).find(
      (e) => e.event === 'action_required',
    )!.data;

    await decide(action.id, 'confirm', {}, bob).expect(404);
    await decide(action.id, 'cancel', {}, bob).expect(404);
    const list = await http()
      .get(`/api/conversations/${id}/pending-actions`)
      .set('Cookie', bob);
    expect(list.body).toEqual([]);
    expect(executed).toEqual([]);

    llm.script = [finalStep()];
    await decide(action.id, 'cancel').expect(200);
  });

  it('never stores or runs a tool call cut off by max_tokens', async () => {
    const id = await newConversation();
    llm.script = [
      {
        content: [
          { type: 'text', text: 'Partial' },
          toolUse('t1', 'make_note', { title: 'x' }),
        ],
        stopReason: 'max_tokens',
      },
    ];
    const events = await say(id, 'go');
    expect(events.at(-1)!.data.stopReason).toBe('max_tokens');
    expect(executed).toEqual([]);

    const messages = await http()
      .get(`/api/conversations/${id}/messages`)
      .set('Cookie', alice);
    expect(messages.body.at(-1).content).toEqual([
      { type: 'text', text: 'Partial' },
    ]);
  });

  it('stops after the step limit', async () => {
    const id = await newConversation();
    llm.script = Array.from({ length: 8 }, (_, i) =>
      callStep(toolUse(`t${i}`, 'lookup', { q: 'x' })),
    );
    const events = await say(id, 'loop');
    expect(events.at(-1)!.data).toEqual({
      assistantMessageId: null,
      stopReason: 'max_steps',
    });
  });

  describe('undo', () => {
    const undo = (actionId: string, cookie = alice) =>
      http()
        .post(`/api/pending-actions/${actionId}/undo`)
        .set('Cookie', cookie);

    /** Runs make_note through confirmation and returns the executed action. */
    async function executedNote(title = 'Buy milk') {
      const id = await newConversation();
      llm.script = [callStep(toolUse('n1', 'make_note', { title }))];
      const action = (await say(id, 'note it')).find(
        (e) => e.event === 'action_required',
      )!.data;
      llm.script = [finalStep('Noted.')];
      await decide(action.id, 'confirm').expect(200);
      return { conversationId: id, actionId: action.id as string };
    }

    it('lists decided actions too, then reverts an executed one once', async () => {
      const { conversationId, actionId } = await executedNote();

      const list = await http()
        .get(`/api/conversations/${conversationId}/pending-actions`)
        .set('Cookie', alice)
        .expect(200);
      expect(list.body).toMatchObject([{ id: actionId, status: 'executed' }]);

      const res = await undo(actionId).expect(200);
      expect(res.body).toMatchObject({ id: actionId, status: 'undone' });
      expect(undone).toEqual([
        { userId: aliceId, result: { created: 'Buy milk' } },
      ]);

      // Second click: nothing left to undo.
      await undo(actionId).expect(409);
      expect(undone).toHaveLength(1);
    });

    it('refuses pending, foreign and non-undoable actions', async () => {
      const id = await newConversation();
      llm.script = [callStep(toolUse('n1', 'make_note', { title: 'x' }))];
      const pending = (await say(id, 'note')).find(
        (e) => e.event === 'action_required',
      )!.data;
      await undo(pending.id).expect(409);
      llm.script = [finalStep()];
      await decide(pending.id, 'cancel').expect(200);
      await undo(pending.id).expect(409); // cancelled

      const { actionId } = await executedNote();
      await undo(actionId, bob).expect(404);

      const id2 = await newConversation();
      llm.script = [callStep(toolUse('p1', 'send_ping', {}))];
      const ping = (await say(id2, 'ping')).find(
        (e) => e.event === 'action_required',
      )!.data;
      llm.script = [finalStep()];
      await decide(ping.id, 'confirm').expect(200);
      const res = await undo(ping.id).expect(409);
      expect(res.body.message).toMatch(/cannot be undone/);
      expect(undone).toEqual([]);
    });

    it('keeps the action executed when Google fails', async () => {
      const { actionId } = await executedNote();

      undoError = new ToolError('Google access has expired or was revoked.', {
        reauthRequired: true,
      });
      const reauth = await undo(actionId).expect(409);
      expect(reauth.body.code).toBe('google_reauth_required');

      undoError = new ToolError('Google denied the request');
      await undo(actionId).expect(502);

      undoError = null;
      await undo(actionId).expect(200);
    });
  });
});
