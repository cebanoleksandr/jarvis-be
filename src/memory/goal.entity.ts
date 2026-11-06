import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity.js';

export const GOAL_STATUSES = ['active', 'paused', 'done', 'dropped'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Goal -> project -> task, linked through parentId (max depth 3). */
export const MAX_GOAL_DEPTH = 3;

@Entity('goals')
@Index(['userId', 'status'])
export class Goal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  parentId: string | null;

  @ManyToOne(() => Goal, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parentId' })
  parent: Relation<Goal> | null;

  @Column({ type: 'varchar', length: 300 })
  title: string;

  @Column({ type: 'text', default: '' })
  notes: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: GoalStatus;

  /** Calendar day in the user's timezone (no time component). */
  @Column({ type: 'date', nullable: true })
  deadline: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
