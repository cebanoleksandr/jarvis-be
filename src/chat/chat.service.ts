import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmProvider } from '../llm/llm.types.js';
import { GoalsService } from '../memory/goals.service.js';
import { MemoriesService } from '../memory/memories.service.js';
import { UsersService } from '../users/users.service.js';
import { Conversation } from './conversation.entity.js';
import { Message } from './message.entity.js';
import { buildSystemPrompt } from './system-prompt.js';

const TITLE_MAX = 60;

export type ChatEvent =
  | { event: 'message_start'; data: { userMessageId: string } }
  | { event: 'delta'; data: { text: string } }
  | {
      event: 'done';
      data: { assistantMessageId: string | null; stopReason: string | null };
    };

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    private readonly users: UsersService,
    private readonly goals: GoalsService,
    private readonly memories: MemoriesService,
    private readonly llm: LlmProvider,
  ) {}

  createConversation(userId: string): Promise<Conversation> {
    return this.conversations.save(this.conversations.create({ userId }));
  }

  listConversations(userId: string): Promise<Conversation[]> {
    return this.conversations.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
      take: 100,
    });
  }

  /** Every conversation access goes through here: 404 unless owned by userId. */
  async getOwnedConversation(
    userId: string,
    id: string,
  ): Promise<Conversation> {
    const conversation = await this.conversations.findOneBy({ id, userId });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  async listMessages(userId: string, conversationId: string) {
    await this.getOwnedConversation(userId, conversationId);
    return this.history(conversationId);
  }

  async deleteConversation(userId: string, id: string): Promise<void> {
    const conversation = await this.getOwnedConversation(userId, id);
    await this.conversations.remove(conversation);
  }

  /**
   * Saves the user message, streams the model reply and saves it. If the
   * client disconnects, the partial text it already saw is kept.
   */
  async *sendMessage(
    userId: string,
    conversation: Conversation,
    text: string,
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const [profile, goals, memories] = await Promise.all([
      this.users.getProfile(userId),
      this.goals.list(userId),
      this.memories.list(userId),
    ]);

    const userMessage = await this.messages.save(
      this.messages.create({
        conversationId: conversation.id,
        role: 'user',
        content: [{ type: 'text', text }],
      }),
    );
    conversation.title ??= text.slice(0, TITLE_MAX);
    conversation.updatedAt = new Date();
    await this.conversations.save(conversation);
    yield { event: 'message_start', data: { userMessageId: userMessage.id } };

    const history = await this.history(conversation.id);
    let partial = '';
    try {
      for await (const ev of this.llm.streamChat({
        system: buildSystemPrompt({ profile, goals, memories }),
        messages: history.map(({ role, content }) => ({ role, content })),
        signal,
      })) {
        if (ev.type === 'text') {
          partial += ev.text;
          yield { event: 'delta', data: { text: ev.text } };
          continue;
        }

        const { result } = ev;
        // A refusal that survived the fallback chain: discard the partial.
        if (result.stopReason === 'refusal' || result.content.length === 0) {
          yield {
            event: 'done',
            data: { assistantMessageId: null, stopReason: result.stopReason },
          };
          return;
        }
        const saved = await this.messages.save(
          this.messages.create({
            conversationId: conversation.id,
            role: 'assistant',
            content: result.content,
            stopReason: result.stopReason,
            model: result.model,
            usage: result.usage,
          }),
        );
        yield {
          event: 'done',
          data: { assistantMessageId: saved.id, stopReason: result.stopReason },
        };
      }
    } catch (err) {
      if (signal.aborted && partial) {
        await this.messages.save(
          this.messages.create({
            conversationId: conversation.id,
            role: 'assistant',
            content: [{ type: 'text', text: partial }],
            stopReason: 'aborted',
          }),
        );
        this.logger.log(
          `Client aborted; saved partial reply (${conversation.id})`,
        );
        return;
      }
      throw err;
    }
  }

  private history(conversationId: string): Promise<Message[]> {
    return this.messages.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
    });
  }
}
