import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity.js';

/** A user's Trello connection: one per user, the token encrypted at rest. */
@Entity('trello_accounts')
export class TrelloAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Unique via the one-to-one relation below. */
  @Column({ type: 'uuid' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  /** Trello member id of the account that granted access. */
  @Column({ type: 'varchar', length: 64 })
  memberId: string;

  @Column({ type: 'varchar', length: 255 })
  username: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  fullName: string | null;

  /** AES-256-GCM, see TokenCipher. The token never expires on its own. */
  @Column({ type: 'text' })
  tokenEnc: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
