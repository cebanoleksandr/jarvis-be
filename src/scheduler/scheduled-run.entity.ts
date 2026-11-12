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
import { User } from '../users/user.entity.js';
import type { BriefingKind } from './schedule.js';

export type ScheduledRunStatus = 'running' | 'done' | 'failed';

/**
 * One scheduled briefing for one user on one local date. The unique index is
 * the claim: whoever inserts the row runs the briefing, so it is sent once
 * even with several API instances or overlapping ticks.
 */
@Entity('scheduled_runs')
@Index(['userId', 'kind', 'localDate'], { unique: true })
export class ScheduledRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  @Column({ type: 'varchar', length: 16 })
  kind: BriefingKind;

  /** The user's local date the briefing is for, `YYYY-MM-DD`. */
  @Column({ type: 'date' })
  localDate: string;

  @Column({ type: 'varchar', length: 16 })
  status: ScheduledRunStatus;

  @Column({ type: 'uuid', nullable: true })
  conversationId: string | null;

  @ManyToOne(() => Conversation, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'conversationId' })
  conversation: Relation<Conversation> | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
