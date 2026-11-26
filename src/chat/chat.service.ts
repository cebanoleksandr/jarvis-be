import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { type AgentEvent, AgentService } from '../agent/agent.service.js';
import { Conversation } from './conversation.entity.js';
import { Message } from './message.entity.js';

/** Keeps the pinned block of the sidebar short. */
export const MAX_PINNED = 10;

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 200;
const SEARCH_MAX_RESULTS = 30;
/** Matching messages scanned, newest first; plenty for 30 conversations. */
const SEARCH_MAX_MESSAGES = 300;

export interface SearchHit {
  conversation: Conversation;
  /** The newest matching message, or null when only the title matched. */
  match: {
    messageId: string;
    role: 'user' | 'assistant';
    snippet: string;
    createdAt: Date;
  } | null;
  /** Matching messages in this conversation (within the scanned ones). */
  matches: number;
}

/** `%` and `_` from the user are literal, not wildcards. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * About 160 characters around the first occurrence of `q`, on one line, cut
 * at word boundaries. Markdown markers are dropped so the excerpt reads as text.
 */
export function snippetAround(text: string, q: string, width = 160): string {
  const flat = text
    .replace(/```[a-z]*\n?/gi, ' ')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const at = flat.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());
  if (at < 0 || flat.length <= width) return flat.slice(0, width);
  let start = Math.max(0, at - Math.floor((width - q.length) / 3));
  let end = Math.min(flat.length, start + width);
  start = Math.max(0, end - width);
  if (start > 0) {
    const space = flat.indexOf(' ', start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end);
    if (space > at + q.length) end = space;
  }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

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
      // Pinned first (most recently pinned on top), then by activity.
      order: {
        pinnedAt: { direction: 'DESC', nulls: 'LAST' },
        updatedAt: 'DESC',
      },
      take: 100,
    });
  }

  /**
   * Conversations whose messages or title contain `q` (case-insensitive),
   * newest match first. Synthetic prompts (briefing requests) are skipped:
   * the user never wrote them.
   */
  async search(userId: string, q: string): Promise<SearchHit[]> {
    const pattern = likePattern(q);
    const rows: {
      messageId: string;
      conversationId: string;
      role: 'user' | 'assistant';
      text: string;
      createdAt: Date;
    }[] = await this.messages.query(
      `SELECT m.id AS "messageId", m."conversationId", m.role,
              b.value->>'text' AS text, m."createdAt"
         FROM messages m
         JOIN conversations c ON c.id = m."conversationId"
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(m.content) = 'array' THEN m.content ELSE '[]'::jsonb END
         ) AS b(value)
        WHERE c."userId" = $1
          AND NOT m.synthetic
          AND b.value->>'type' = 'text'
          AND b.value->>'text' ILIKE $2 ESCAPE '\\'
        ORDER BY m.seq DESC
        LIMIT ${SEARCH_MAX_MESSAGES}`,
      [userId, pattern],
    );

    // The newest match per conversation; rows are already newest first.
    const byConversation = new Map<
      string,
      { first: (typeof rows)[number]; count: number; messageIds: Set<string> }
    >();
    for (const r of rows) {
      const hit = byConversation.get(r.conversationId);
      if (!hit) {
        byConversation.set(r.conversationId, {
          first: r,
          count: 1,
          messageIds: new Set([r.messageId]),
        });
      } else if (!hit.messageIds.has(r.messageId)) {
        hit.messageIds.add(r.messageId);
        hit.count++;
      }
    }

    const titled = await this.conversations
      .createQueryBuilder('c')
      .where('c."userId" = :userId', { userId })
      .andWhere(`c.title ILIKE :pattern ESCAPE '\\'`, { pattern })
      .orderBy('c."updatedAt"', 'DESC')
      .take(SEARCH_MAX_RESULTS)
      .getMany();
    const ids = [...byConversation.keys()].filter(
      (id) => !titled.some((c) => c.id === id),
    );
    const conversations = [
      ...titled,
      ...(ids.length
        ? await this.conversations.findBy({ id: In(ids), userId })
        : []),
    ];

    const hits: SearchHit[] = conversations.map((conversation) => {
      const hit = byConversation.get(conversation.id);
      return {
        conversation,
        match: hit
          ? {
              messageId: hit.first.messageId,
              role: hit.first.role,
              snippet: snippetAround(hit.first.text, q),
              createdAt: new Date(hit.first.createdAt),
            }
          : null,
        matches: hit?.count ?? 0,
      };
    });
    const when = (h: SearchHit) =>
      (h.match?.createdAt ?? h.conversation.updatedAt).getTime();
    return hits.sort((a, b) => when(b) - when(a)).slice(0, SEARCH_MAX_RESULTS);
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

  /**
   * Renames and/or pins a conversation. Neither counts as activity, so
   * updatedAt (the list order among unpinned chats) stays as it was.
   */
  async update(
    userId: string,
    id: string,
    patch: { title?: string; pinned?: boolean },
  ): Promise<Conversation> {
    const conversation = await this.getOwnedConversation(userId, id);
    const changes: Partial<Conversation> = {};
    if (patch.title !== undefined) {
      changes.title = patch.title;
      changes.customTitle = true;
    }
    if (
      patch.pinned !== undefined &&
      patch.pinned !== !!conversation.pinnedAt
    ) {
      if (
        patch.pinned &&
        (await this.conversations.count({
          where: { userId, pinnedAt: Not(IsNull()) },
        })) >= MAX_PINNED
      ) {
        throw new BadRequestException(`At most ${MAX_PINNED} pinned chats`);
      }
      changes.pinnedAt = patch.pinned ? new Date() : null;
    }
    if (Object.keys(changes).length) {
      await this.conversations
        .createQueryBuilder()
        .update()
        .set({ ...changes, updatedAt: () => '"updatedAt"' })
        .where('id = :id', { id })
        .execute();
    }
    return Object.assign(conversation, changes);
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
