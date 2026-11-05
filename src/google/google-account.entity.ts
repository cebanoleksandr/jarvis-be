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

@Entity('google_accounts')
export class GoogleAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Unique via the one-to-one relation below. */
  @Column({ type: 'uuid' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  /** Stable Google account id (`sub` claim); email can change. */
  @Column({ type: 'varchar', length: 255, unique: true })
  googleSub: string;

  /** AES-256-GCM, see TokenCipher. */
  @Column({ type: 'text' })
  refreshTokenEnc: string;

  @Column({ type: 'text', nullable: true })
  accessTokenEnc: string | null;

  /** Access token expiry. */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** Scopes the user actually granted (may be fewer than requested). */
  @Column({ type: 'text', array: true, default: '{}' })
  scopes: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
