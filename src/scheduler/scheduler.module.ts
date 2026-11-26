import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentModule } from '../agent/agent.module.js';
import { Conversation } from '../chat/conversation.entity.js';
import { User } from '../users/user.entity.js';
import { UsersModule } from '../users/users.module.js';
import { BriefingQueue } from './briefing-queue.service.js';
import { NotificationSettings } from './notification-settings.entity.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { ScheduledRun } from './scheduled-run.entity.js';
import { SchedulerService } from './scheduler.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Conversation,
      NotificationSettings,
      ScheduledRun,
    ]),
    AgentModule,
    UsersModule,
  ],
  controllers: [NotificationsController],
  providers: [SchedulerService, BriefingQueue, NotificationsService],
})
export class SchedulerModule {}
