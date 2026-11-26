import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BriefingQueue } from './briefing-queue.service.js';
import { NotificationSettings } from './notification-settings.entity.js';
import { DEFAULT_SETTINGS, type ScheduleSettings } from './schedule.js';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(NotificationSettings)
    private readonly settings: Repository<NotificationSettings>,
    private readonly queue: BriefingQueue,
  ) {}

  async get(userId: string): Promise<ScheduleSettings> {
    return toView(await this.settings.findOneBy({ userId }));
  }

  async update(
    userId: string,
    patch: Partial<ScheduleSettings>,
  ): Promise<ScheduleSettings> {
    const row =
      (await this.settings.findOneBy({ userId })) ??
      this.settings.create({ userId, ...DEFAULT_SETTINGS });
    Object.assign(row, patch);
    const saved = toView(await this.settings.save(row));
    // New times take effect for the next run, today's included if still open.
    this.queue.replan(userId);
    return saved;
  }
}

function toView(row: NotificationSettings | null): ScheduleSettings {
  const s = row ?? DEFAULT_SETTINGS;
  return {
    morningEnabled: s.morningEnabled,
    morningTime: s.morningTime,
    eveningEnabled: s.eveningEnabled,
    eveningTime: s.eveningTime,
    weeklyEnabled: s.weeklyEnabled,
    weeklyDay: s.weeklyDay,
    weeklyTime: s.weeklyTime,
  };
}
