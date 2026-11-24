import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  Conversation,
  type ConversationKind,
} from '../chat/conversation.entity.js';
import { Message } from '../chat/message.entity.js';
import {
  type ChatResult,
  type ContentBlock,
  LlmProvider,
  type ToolCall,
  textBlock,
  toolResultBlock,
  toolUseIds,
} from '../llm/llm.types.js';
import { GoalsService } from '../memory/goals.service.js';
import { MemoriesService } from '../memory/memories.service.js';
import { User } from '../users/user.entity.js';
import { UsersService } from '../users/users.service.js';
import { PendingAction } from './pending-action.entity.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { ToolContext } from './tool.js';
import {
  type PreparedCall,
  renderToolResult,
  ToolRegistry,
  type ToolOutcome,
} from './tool-registry.service.js';

/** Model calls per user turn, so a confused model cannot loop forever. */
const MAX_STEPS = 8;
const TITLE_MAX = 60;

export type PendingActionDto = ReturnType<typeof toActionDto>;

export type AgentEvent =
  | { event: 'message_start'; data: { userMessageId: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'tool_call'; data: { id: string; name: string; input: unknown } }
  | {
      event: 'tool_result';
      data: { id: string; name: string; isError: boolean };
    }
  | { event: 'action_required'; data: PendingActionDto }
  | { event: 'action_resolved'; data: PendingActionDto }
  | {
      event: 'done';
      data: { assistantMessageId: string | null; stopReason: string | null };
    };

export type Decision =
  { type: 'confirm'; args?: Record<string, unknown> } | { type: 'cancel' };

export interface PreparedDecision {
  action: PendingAction;
  editedArgs?: Record<string, unknown>;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(PendingAction)
    private readonly actions: Repository<PendingAction>,
    private readonly users: UsersService,
    private readonly goals: GoalsService,
    private readonly memories: MemoriesService,
    private readonly llm: LlmProvider,
    private readonly registry: ToolRegistry,
  ) {}

  /**
   * Appends the user's message and runs the agent. If the previous assistant
   * turn is still waiting for confirmation, its open actions are dismissed
   * and their results are sent ahead of the new text.
   */
  async *sendUserMessage(
    userId: string,
    conversationId: string,
    text: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const userMessage = await this.dataSource.transaction(async (m) => {
      const conversation = await this.lockConversation(
        m,
        userId,
        conversationId,
      );
      const last = await this.lastMessage(m, conversationId);
      const toolResults = last ? await this.closeOpenToolCalls(m, last) : [];

      conversation.title ??= text.slice(0, TITLE_MAX);
      conversation.updatedAt = new Date();
      await m.save(conversation);
      await m.update(User, userId, { lastActiveAt: new Date() });
      return m.save(
        m.create(Message, {
          conversationId,
          role: 'user',
          content: [...toolResults, textBlock(text)],
        }),
      );
    });
    yield { event: 'message_start', data: { userMessageId: userMessage.id } };
    yield* this.run(userId, conversationId, signal);
  }

  /**
   * Opens a conversation that starts with a prompt written by the app (a
   * scheduled briefing) instead of the user. Run it with `runToCompletion`.
   */
  startAutomatedConversation(
    userId: string,
    opts: { kind: ConversationKind; title: string; prompt: string },
  ): Promise<Conversation> {
    return this.dataSource.transaction(async (m) => {
      const conversation = await m.save(
        m.create(Conversation, {
          userId,
          kind: opts.kind,
          title: opts.title.slice(0, 200),
        }),
      );
      await m.save(
        m.create(Message, {
          conversationId: conversation.id,
          role: 'user',
          content: [textBlock(opts.prompt)],
          synthetic: true,
        }),
      );
      return conversation;
    });
  }

  /**
   * Runs the agent with nobody listening (background jobs). Mutating calls
   * still pause as pending actions and wait for the user in that conversation.
   */
  async runToCompletion(
    userId: string,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<{ assistantMessageId: string | null; stopReason: string | null }> {
    let done = {
      assistantMessageId: null as string | null,
      stopReason: null as string | null,
    };
    for await (const ev of this.run(userId, conversationId, signal)) {
      if (ev.event === 'done') done = ev.data;
    }
    return done;
  }

  /**
   * Every confirmation card of a conversation, open or decided, so the chat
   * can show resolved cards (with Undo) after a reload too.
   */
  listActions(
    userId: string,
    conversationId: string,
  ): Promise<PendingAction[]> {
    return this.actions.find({
      where: { userId, conversationId, mutating: true },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Reverts an executed action through its tool's `undo` (e.g. deletes the
   * created event). It is the user's own click, so no further confirmation.
   * Google failures surface as ToolError.
   */
  async undo(userId: string, actionId: string): Promise<PendingAction> {
    const action = await this.actions.findOneBy({
      id: actionId,
      userId,
      mutating: true,
    });
    if (!action) throw new NotFoundException('Action not found');
    if (action.status !== 'executed') {
      throw new ConflictException(`Action is ${action.status}, not executed`);
    }
    const tool = this.registry.get(action.tool);
    if (!tool?.undo) {
      throw new ConflictException('This action cannot be undone');
    }
    await tool.undo(await this.toolContext(userId), action.result);
    // A parallel Undo hits an already deleted item, which counts as done.
    await this.actions.update(
      { id: action.id, status: 'executed' },
      { status: 'undone' },
    );
    return this.actions.findOneByOrFail({ id: action.id });
  }

  /** All checks that can fail with a plain HTTP error, before streaming starts. */
  async prepareDecision(
    userId: string,
    actionId: string,
    decision: Decision,
  ): Promise<PreparedDecision> {
    const action = await this.actions.findOneBy({
      id: actionId,
      userId,
      mutating: true,
    });
    if (!action) throw new NotFoundException('Action not found');
    if (action.status !== 'pending') {
      throw new ConflictException(`Action is already ${action.status}`);
    }
    if (decision.type === 'confirm' && decision.args) {
      const prepared = this.registry.prepare(action.tool, decision.args);
      if (prepared.kind === 'invalid')
        throw new BadRequestException(prepared.error);
      return { action, editedArgs: prepared.input };
    }
    return { action };
  }

  /**
   * Applies the user's decision. Once every open call of the paused turn is
   * resolved, sends all results to the model and continues the turn.
   */
  async *resolve(
    userId: string,
    { action, editedArgs }: PreparedDecision,
    decision: Decision,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    // Claim atomically so a double click cannot run the action twice.
    const claimed = await this.actions
      .createQueryBuilder()
      .update()
      .set(
        decision.type === 'confirm'
          ? { status: 'executing' }
          : { status: 'cancelled', resolvedAt: new Date() },
      )
      .where('id = :id AND "userId" = :userId AND status = :status', {
        id: action.id,
        userId,
        status: 'pending',
      })
      .execute();
    if (!claimed.affected)
      throw new ConflictException('Action is already resolved');
    await this.dataSource.manager.update(User, userId, {
      lastActiveAt: new Date(),
    });

    if (decision.type === 'confirm') {
      const tool = this.registry.get(action.tool);
      const args = editedArgs ?? action.args;
      const outcome: ToolOutcome = tool
        ? await this.registry.execute(
            tool,
            await this.toolContext(userId),
            args,
          )
        : { ok: false, error: `Tool ${action.tool} is no longer available.` };
      Object.assign(action, {
        status: outcome.ok ? 'executed' : 'failed',
        result: outcome.ok ? outcome.result : null,
        error: outcome.ok ? null : outcome.error,
        args,
        originalArgs: editedArgs ? action.args : null,
        resolvedAt: new Date(),
      } satisfies Partial<PendingAction>);
      await this.actions.save(action);
    }
    const resolved = await this.actions.findOneByOrFail({ id: action.id });
    yield { event: 'action_resolved', data: toActionDto(resolved) };

    const resumed = await this.dataSource.transaction(async (m) => {
      await this.lockConversation(m, userId, action.conversationId);
      const last = await this.lastMessage(m, action.conversationId);
      // Someone else already continued this turn.
      if (!last || last.id !== action.messageId) return false;
      const turnActions = await m.findBy(PendingAction, { messageId: last.id });
      if (
        turnActions.some(
          (a) => a.status === 'pending' || a.status === 'executing',
        )
      ) {
        return false;
      }
      await m.save(
        m.create(Message, {
          conversationId: action.conversationId,
          role: 'user',
          content: buildToolResults(toolUseIds(last.content), turnActions),
        }),
      );
      return true;
    });

    if (!resumed) {
      yield {
        event: 'done',
        data: { assistantMessageId: null, stopReason: 'awaiting_confirmation' },
      };
      return;
    }
    yield* this.run(userId, action.conversationId, signal);
  }

  /** model -> tools -> model ... until a final answer, a pause or the step limit. */
  private async *run(
    userId: string,
    conversationId: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const [profile, goals, memories] = await Promise.all([
      this.users.getProfile(userId),
      this.goals.list(userId),
      this.memories.list(userId),
    ]);
    const system = buildSystemPrompt({ profile, goals, memories });
    const ctx: ToolContext = { userId, timezone: profile.timezone };

    for (let step = 0; step < MAX_STEPS; step++) {
      const history = await this.history(conversationId);
      let partial = '';
      let result: ChatResult | undefined;
      try {
        for await (const ev of this.llm.streamChat({
          system,
          messages: history.map(({ role, content }) => ({ role, content })),
          tools: this.registry.specs(),
          signal,
        })) {
          if (ev.type === 'text') {
            partial += ev.text;
            yield { event: 'delta', data: { text: ev.text } };
          } else {
            result = ev.result;
          }
        }
      } catch (err) {
        if (signal.aborted && partial) {
          // Keep what the user already saw.
          await this.saveAssistant(conversationId, {
            content: [textBlock(partial)],
            stopReason: 'aborted',
          });
        }
        throw err;
      }
      if (!result) throw new Error('Model stream ended without a result');

      // A refusal that survived the fallback chain: discard the partial.
      if (result.stopReason === 'refusal') {
        yield {
          event: 'done',
          data: { assistantMessageId: null, stopReason: 'refusal' },
        };
        return;
      }

      const wantsTools =
        result.stopReason === 'tool_use' && result.toolCalls.length > 0;
      if (!wantsTools) {
        // Never store a tool_use without its result (e.g. cut off by max_tokens).
        const content = result.content.filter((b) => b.type !== 'tool_use');
        const saved = content.length
          ? await this.saveAssistant(conversationId, { ...result, content })
          : null;
        yield {
          event: 'done',
          data: {
            assistantMessageId: saved?.id ?? null,
            stopReason: result.stopReason,
          },
        };
        return;
      }

      const calls = result.toolCalls.map((call) => ({
        call,
        prepared: this.registry.prepare(call.name, call.input),
      }));
      for (const { call } of calls) {
        yield {
          event: 'tool_call',
          data: { id: call.id, name: call.name, input: call.input },
        };
      }

      // Read-only calls run now; mutating ones wait for the user (null).
      // A mutating call on an existing item first loads it for the card; if
      // that fails (e.g. it was deleted) the model gets the error instead.
      const before = new Map<number, unknown>();
      const outcomes = await Promise.all(
        calls.map(async ({ prepared }, i): Promise<ToolOutcome | null> => {
          if (prepared.kind === 'invalid')
            return { ok: false, error: prepared.error };
          if (prepared.tool.mutating) {
            const found = await this.registry.lookup(
              prepared.tool,
              ctx,
              prepared.input,
            );
            if (!found.ok) return found;
            before.set(i, found.result);
            return null;
          }
          return this.registry.execute(prepared.tool, ctx, prepared.input);
        }),
      );
      signal.throwIfAborted();

      const toolResultEvents = calls.flatMap(({ call }, i): AgentEvent[] => {
        const outcome = outcomes[i];
        return outcome
          ? [
              {
                event: 'tool_result',
                data: { id: call.id, name: call.name, isError: !outcome.ok },
              },
            ]
          : [];
      });

      if (outcomes.every((o) => o !== null)) {
        await this.dataSource.transaction(async (m) => {
          await this.saveAssistant(conversationId, result, m);
          await m.save(
            m.create(Message, {
              conversationId,
              role: 'user',
              content: calls.map(({ call }, i) =>
                outcomeToBlock(call.id, outcomes[i]!),
              ),
            }),
          );
        });
        yield* toolResultEvents;
        continue;
      }

      // Pause the turn until the user decides on every mutating call.
      const { assistant, pending } = await this.dataSource.transaction(
        async (m) => {
          const assistant = await this.saveAssistant(conversationId, result, m);
          const rows = await m.save(
            calls.map(({ call, prepared }, i) =>
              m.create(
                PendingAction,
                toActionRow(
                  userId,
                  conversationId,
                  assistant.id,
                  call,
                  prepared,
                  outcomes[i],
                  before.get(i),
                ),
              ),
            ),
          );
          return {
            assistant,
            pending: rows.filter((r) => r.status === 'pending'),
          };
        },
      );
      yield* toolResultEvents;
      for (const action of pending) {
        yield { event: 'action_required', data: toActionDto(action) };
      }
      yield {
        event: 'done',
        data: {
          assistantMessageId: assistant.id,
          stopReason: 'awaiting_confirmation',
        },
      };
      return;
    }

    this.logger.warn(`Step limit reached in conversation ${conversationId}`);
    yield {
      event: 'done',
      data: { assistantMessageId: null, stopReason: 'max_steps' },
    };
  }

  /**
   * If `last` is an assistant turn with tool calls (a paused turn), dismisses
   * its open actions and returns the tool_result blocks that must precede
   * the next user content.
   */
  private async closeOpenToolCalls(
    m: EntityManager,
    last: Message,
  ): Promise<ContentBlock[]> {
    if (last.role !== 'assistant') return [];
    const ids = toolUseIds(last.content);
    if (!ids.length) return [];
    await m.update(
      PendingAction,
      { messageId: last.id, status: 'pending' },
      { status: 'dismissed', resolvedAt: new Date() },
    );
    return buildToolResults(
      ids,
      await m.findBy(PendingAction, { messageId: last.id }),
    );
  }

  private async toolContext(userId: string): Promise<ToolContext> {
    const profile = await this.users.getProfile(userId);
    return { userId, timezone: profile.timezone };
  }

  private async lockConversation(m: EntityManager, userId: string, id: string) {
    const conversation = await m.findOne(Conversation, {
      where: { id, userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  private lastMessage(m: EntityManager, conversationId: string) {
    return m.findOne(Message, {
      where: { conversationId },
      order: { seq: 'DESC' },
    });
  }

  private history(conversationId: string): Promise<Message[]> {
    return this.messages.find({
      where: { conversationId },
      order: { seq: 'ASC' },
    });
  }

  private saveAssistant(
    conversationId: string,
    r: Pick<ChatResult, 'content' | 'stopReason'> & Partial<ChatResult>,
    m: EntityManager = this.messages.manager,
  ): Promise<Message> {
    return m.save(
      m.create(Message, {
        conversationId,
        role: 'assistant',
        content: r.content,
        stopReason: r.stopReason,
        model: r.model ?? null,
        usage: r.usage ?? null,
      }),
    );
  }
}

function outcomeToBlock(toolUseId: string, outcome: ToolOutcome): ContentBlock {
  return outcome.ok
    ? toolResultBlock(toolUseId, renderToolResult(outcome.result))
    : toolResultBlock(toolUseId, outcome.error, true);
}

function toActionRow(
  userId: string,
  conversationId: string,
  messageId: string,
  call: ToolCall,
  prepared: PreparedCall,
  outcome: ToolOutcome | null,
  before?: unknown,
): Partial<PendingAction> {
  const ready = prepared.kind === 'ready' ? prepared : null;
  const rawArgs =
    call.input && typeof call.input === 'object' && !Array.isArray(call.input)
      ? (call.input as Record<string, unknown>)
      : { input: call.input };
  return {
    userId,
    conversationId,
    messageId,
    toolUseId: call.id,
    tool: call.name,
    mutating: ready?.tool.mutating ?? false,
    args: ready?.input ?? rawArgs,
    summary:
      outcome === null && ready?.tool.summarize
        ? {
            ...ready.tool.summarize(ready.input, before),
            ...(before === undefined ? {} : { before }),
          }
        : null,
    status: outcome === null ? 'pending' : outcome.ok ? 'executed' : 'failed',
    result: outcome?.ok ? (outcome.result as object) : null,
    error: outcome && !outcome.ok ? outcome.error : null,
    resolvedAt: outcome === null ? null : new Date(),
  };
}

/** tool_result blocks for a paused turn, in the order of its tool_use blocks. */
export function buildToolResults(
  toolUseIdList: string[],
  actions: PendingAction[],
): ContentBlock[] {
  return toolUseIdList.map((id) => {
    const a = actions.find((x) => x.toolUseId === id);
    switch (a?.status) {
      case 'executed':
        return toolResultBlock(
          id,
          renderToolResult(
            a.originalArgs
              ? {
                  note: 'The user edited the arguments before confirming; this is what ran.',
                  argsUsed: a.args,
                  result: a.result,
                }
              : a.result,
          ),
        );
      case 'failed':
        return toolResultBlock(id, a.error ?? 'The action failed.', true);
      case 'cancelled':
        return toolResultBlock(
          id,
          'The user declined this action. It was not performed.',
          true,
        );
      case 'dismissed':
        return toolResultBlock(
          id,
          'The user did not confirm this action and continued the conversation instead. It was not performed.',
          true,
        );
      default:
        return toolResultBlock(id, 'This tool call was not executed.', true);
    }
  });
}

export function toActionDto(a: PendingAction) {
  return {
    id: a.id,
    conversationId: a.conversationId,
    messageId: a.messageId,
    tool: a.tool,
    args: a.args,
    originalArgs: a.originalArgs,
    summary: a.summary,
    status: a.status,
    result: a.result,
    error: a.error,
    createdAt: a.createdAt,
    resolvedAt: a.resolvedAt,
  };
}
