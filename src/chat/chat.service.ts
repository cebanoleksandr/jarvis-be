import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { type AgentEvent, AgentService } from '../agent/agent.service.js';
import { Conversation } from './conversation.entity.js';
import { Message } from './message.entity.js';

@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    private readonly agent: AgentService,
  ) {}

  createConversation(userId: string): Promise<Conversation> {
    return this.conversations.save(
      this.conversations.create({ userId, readAt: new Date() }),
    );
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

  async listMessages(
    userId: string,
    conversationId: string,
  ): Promise<Message[]> {
    await this.getOwnedConversation(userId, conversationId);
    return this.messages.find({
      where: { conversationId },
      order: { seq: 'ASC' },
    });
  }

  /** Marks the conversation as seen; keeps the first time it was read. */
  async markRead(userId: string, id: string): Promise<void> {
    const conversation = await this.getOwnedConversation(userId, id);
    if (conversation.readAt) return;
    // Raw update: opening a chat must not bump updatedAt and reorder the list.
    await this.conversations
      .createQueryBuilder()
      .update()
      .set({ readAt: () => 'now()', updatedAt: () => '"updatedAt"' })
      .where('id = :id', { id })
      .execute();
  }

  async deleteConversation(userId: string, id: string): Promise<void> {
    const conversation = await this.getOwnedConversation(userId, id);
    await this.conversations.remove(conversation);
  }

  sendMessage(
    userId: string,
    conversationId: string,
    text: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    return this.agent.sendUserMessage(userId, conversationId, text, signal);
  }
}
