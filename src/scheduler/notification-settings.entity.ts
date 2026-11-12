import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity.js';
import type { ScheduleSettings } from './schedule.js';

/** Created on first change; users without a row use DEFAULT_SETTINGS. */
@Entity('notification_settings')
export class NotificationSettings implements ScheduleSettings {
  @PrimaryColumn({ type: 'uuid' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  @Column({ type: 'boolean', default: true })
  morningEnabled: boolean;

  /** `HH:mm` in the user's time zone. */
  @Column({ type: 'varchar', length: 5, default: '08:00' })
  morningTime: string;

  @Column({ type: 'boolean', default: true })
  eveningEnabled: boolean;

  @Column({ type: 'varchar', length: 5, default: '21:00' })
  eveningTime: string;

  @Column({ type: 'boolean', default: true })
  weeklyEnabled: boolean;

  /** 0 = Sunday ... 6 = Saturday. */
  @Column({ type: 'smallint', default: 0 })
  weeklyDay: number;

  @Column({ type: 'varchar', length: 5, default: '18:00' })
  weeklyTime: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
