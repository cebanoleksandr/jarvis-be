import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity.js';

@Entity('profiles')
export class Profile {
  @PrimaryColumn({ type: 'uuid' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  /** Free-form "about me" written by the user. */
  @Column({ type: 'text', default: '' })
  about: string;

  /** Flat key -> value preferences, e.g. { "workHours": "9-18" }. */
  @Column({ type: 'jsonb', default: {} })
  preferences: Record<string, string>;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
