import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { PendingAction } from '../agent/pending-action.entity.js';
import { Conversation } from '../chat/conversation.entity.js';
import { Message } from '../chat/message.entity.js';
import { GoogleConnectionService } from '../google/google-connection.service.js';
import { Goal } from '../memory/goal.entity.js';
import { Memory } from '../memory/memory.entity.js';
import { NotificationSettings } from '../scheduler/notification-settings.entity.js';
import { Profile } from '../users/profile.entity.js';
import { User } from '../users/user.entity.js';

/** Drops owner keys and relation objects so the export holds plain data only. */
function strip<T extends object>(row: T, ...keys: string[]) {
  const out = { ...row } as Record<string, unknown>;
  for (const k of ['userId', 'user', ...keys]) delete out[k];
  return out;
}

@Injectable()
export class AccountService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly google: GoogleConnectionService,
  ) {}

  /** Everything stored about the user, as plain JSON. OAuth tokens are never included. */
  async export(userId: string) {
    const user = await this.db.getRepository(User).findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');

    const [profile, goals, memories, conversations, actions, notifications] =
      await Promise.all([
        this.db.getRepository(Profile).findOneBy({ userId }),
        this.db.getRepository(Goal).find({
          where: { userId },
          order: { createdAt: 'ASC' },
        }),
        this.db.getRepository(Memory).find({
          where: { userId },
          order: { createdAt: 'ASC' },
        }),
        this.db.getRepository(Conversation).find({
          where: { userId },
          order: { createdAt: 'ASC' },
        }),
        this.db.getRepository(PendingAction).find({
          where: { userId },
          order: { createdAt: 'ASC' },
        }),
        this.db.getRepository(NotificationSettings).findOneBy({ userId }),
      ]);

    const messages = conversations.length
      ? await this.db.getRepository(Message).find({
          where: { conversationId: In(conversations.map((c) => c.id)) },
          order: { seq: 'ASC' },
        })
      : [];
    const byConversation = new Map<string, Message[]>();
    for (const m of messages) {
      const list = byConversation.get(m.conversationId) ?? [];
      list.push(m);
      byConversation.set(m.conversationId, list);
    }

    return {
      exportedAt: new Date(),
      user: strip(user, 'lastActiveAt'),
      profile: profile && strip(profile),
      google: await this.google.status(userId),
      notificationSettings: notifications && strip(notifications),
      goals: goals.map((g) => strip(g, 'parent')),
      memories: memories.map((m) => strip(m)),
      conversations: conversations.map((c) => ({
        ...strip(c),
        messages: (byConversation.get(c.id) ?? []).map((m) =>
          strip(m, 'conversationId', 'conversation', 'seq'),
        ),
      })),
      actions: actions.map((a) =>
        strip(a, 'conversation', 'message', 'toolUseId', 'mutating'),
      ),
    };
  }

  /**
   * Deletes the account and all its data (every table cascades from users),
   * after revoking Google access.
   */
  async delete(userId: string): Promise<void> {
    await this.google.disconnect(userId);
    await this.db.getRepository(User).delete({ id: userId });
  }
}
