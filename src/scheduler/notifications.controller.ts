import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { parseBody } from '../common/validation.js';
import { NotificationsService } from './notifications.service.js';
import { BRIEFING_KINDS, type BriefingKind, TIME_PATTERN } from './schedule.js';
import { SchedulerService } from './scheduler.service.js';

const time = z.string().regex(TIME_PATTERN, 'Expected HH:mm');

const updateSchema = z
  .object({
    morningEnabled: z.boolean(),
    morningTime: time,
    eveningEnabled: z.boolean(),
    eveningTime: time,
    weeklyEnabled: z.boolean(),
    /** 0 = Sunday ... 6 = Saturday. */
    weeklyDay: z.number().int().min(0).max(6),
    weeklyTime: time,
  })
  .partial()
  .strict();

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly scheduler: SchedulerService,
  ) {}

  /** Times are in the user's profile time zone. */
  @Get()
  get(@CurrentUserId() userId: string) {
    return this.notifications.get(userId);
  }

  @Patch()
  update(@CurrentUserId() userId: string, @Body() body: unknown) {
    return this.notifications.update(userId, parseBody(updateSchema, body));
  }

  /**
   * Starts a briefing now. Responds at once with the new conversation; the
   * reply appears in its messages when ready (the conversation disappears if
   * generation fails).
   */
  @Post(':kind/run')
  @HttpCode(202)
  async run(@CurrentUserId() userId: string, @Param('kind') kind: string) {
    if (!BRIEFING_KINDS.includes(kind as BriefingKind)) {
      throw new BadRequestException(
        `Unknown briefing: expected one of ${BRIEFING_KINDS.join(', ')}`,
      );
    }
    const conversation = await this.scheduler.runNow(
      userId,
      kind as BriefingKind,
    );
    return { conversationId: conversation.id };
  }
}
