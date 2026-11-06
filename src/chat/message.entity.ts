import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import type { ContentBlock } from '../llm/llm.types.js';
import { Conversation } from './conversation.entity.js';

export type MessageRole = 'user' | 'assistant';

@Entity('messages')
@Index(['conversationId', 'seq'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Insertion order. tool_use / tool_result pairs must be replayed in exact
   * order, which timestamps cannot guarantee.
   */
  @Column({ type: 'bigint', generated: 'increment', select: false })
  seq: string;

  @Column({ type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Relation<Conversation>;

  @Column({ type: 'varchar', length: 16 })
  role: MessageRole;

  /** Content blocks exactly as they are replayed to the model. */
  @Column({ type: 'jsonb' })
  content: ContentBlock[];

  /** Assistant only: `end_turn`, `max_tokens`, `aborted`, ... */
  @Column({ type: 'varchar', length: 32, nullable: true })
  stopReason: string | null;

  /** Assistant only: model that produced the reply. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  model: string | null;

  /** Assistant only: token usage, for limits and cost tracking. */
  @Column({ type: 'jsonb', nullable: true })
  usage: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
