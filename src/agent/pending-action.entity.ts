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
import { Conversation } from '../chat/conversation.entity.js';
import { Message } from '../chat/message.entity.js';
import { User } from '../users/user.entity.js';
import type { ActionSummary } from './tool.js';

/**
 * pending -> executing -> executed | failed   (user confirmed)
 * pending -> cancelled                        (user declined)
 * pending -> dismissed                        (user wrote a new message instead)
 * executed -> undone                          (user pressed Undo afterwards)
 */
export type PendingActionStatus =
  | 'pending'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'cancelled'
  | 'dismissed'
  | 'undone';

/**
 * One tool call from an assistant turn that was paused for confirmation.
 * Read-only calls from the same turn are stored too (already executed), so
 * that all results go back to the model together once the turn resumes.
 */
@Entity('pending_actions')
@Index(['userId', 'status'])
@Index(['messageId'])
export class PendingAction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  @Column({ type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Relation<Conversation>;

  /** The assistant message that contains the tool_use block. */
  @Column({ type: 'uuid' })
  messageId: string;

  @ManyToOne(() => Message, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'messageId' })
  message: Relation<Message>;

  @Column({ type: 'varchar', length: 100 })
  toolUseId: string;

  @Column({ type: 'varchar', length: 100 })
  tool: string;

  @Column({ type: 'boolean' })
  mutating: boolean;

  /** Arguments that run (after a user edit, the edited ones). */
  @Column({ type: 'jsonb' })
  args: Record<string, unknown>;

  /** What the model proposed, when the user changed it. */
  @Column({ type: 'jsonb', nullable: true })
  originalArgs: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  summary: ActionSummary | null;

  @Column({ type: 'varchar', length: 16 })
  status: PendingActionStatus;

  @Column({ type: 'jsonb', nullable: true })
  result: unknown;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;
}
