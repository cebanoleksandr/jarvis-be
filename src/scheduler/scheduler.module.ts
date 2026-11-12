import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentModule } from '../agent/agent.module.js';
import { Conversation } from '../chat/conversation.entity.js';
import { User } from '../users/user.entity.js';
import { NotificationSettings } from './notification-settings.entity.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { ScheduledRun } from './scheduled-run.entity.js';
import { SchedulerService } from './scheduler.service.js';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      User,
      Conversation,
      NotificationSettings,
      ScheduledRun,
    ]),
    AgentModule,
  ],
  controllers: [NotificationsController],
  providers: [SchedulerService, NotificationsService],
})
export class SchedulerModule {}
