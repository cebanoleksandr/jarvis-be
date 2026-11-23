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

export const MEMORY_CATEGORIES = [
  'schedule',
  'preferences',
  'people',
  'directive',
  'technical',
  'other',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** A short fact about the user that the assistant should remember. */
@Entity('memories')
@Index(['userId', 'createdAt'])
export class Memory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  @Column({ type: 'varchar', length: 1000 })
  text: string;

  /** `directive` notes are standing rules the user set for planning. */
  @Column({ type: 'varchar', length: 16, default: 'other' })
  category: MemoryCategory;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
