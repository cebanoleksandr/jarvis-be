import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Stored lowercased. */
  @Column({ type: 'varchar', length: 320, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  name: string | null;

  /** IANA zone, e.g. Europe/Kyiv. All timestamps in the DB stay UTC. */
  @Column({ type: 'varchar', length: 64, default: 'UTC' })
  timezone: string;

  /** Last time the user sent a message or decided on an action. */
  @Column({ type: 'timestamptz', nullable: true })
  lastActiveAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
