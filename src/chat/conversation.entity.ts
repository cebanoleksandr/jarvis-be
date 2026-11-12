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

export type ConversationKind = 'chat' | 'morning' | 'evening' | 'weekly';

@Entity('conversations')
@Index(['userId', 'updatedAt'])
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  @Column({ type: 'varchar', length: 200, nullable: true })
  title: string | null;

  /** `chat` for ordinary dialogs, otherwise the briefing that opened it. */
  @Column({ type: 'varchar', length: 16, default: 'chat' })
  kind: ConversationKind;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
