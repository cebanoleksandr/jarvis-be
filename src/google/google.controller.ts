import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { localClock } from '../common/time.js';
import { parseBody } from '../common/validation.js';
import { UsersService } from '../users/users.service.js';
import { GoogleConnectionService } from './google-connection.service.js';
import { GoogleDataService } from './google-data.service.js';
import { fromGoogle } from './google-errors.js';
import { GoogleToolsService } from './google-tools.service.js';
import { eventsRangeSchema } from './tools/calendar.tools.js';

const tasksQuerySchema = z
  .object({
    includeCompleted: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict();

const doneSchema = z.object({ done: z.boolean() }).strict();

/**
 * Google data for the UI plus the connection itself. Changes to Calendar and
 * Tasks go through the agent and its confirmation cards, except ticking a
 * task done on the Today page: there the user's own click is the confirmation.
 */
@Controller()
export class GoogleController {
  constructor(
    private readonly data: GoogleDataService,
    private readonly connection: GoogleConnectionService,
    private readonly users: UsersService,
    private readonly tools: GoogleToolsService,
  ) {}

  /** `from` / `to` are days in the user's timezone; both default to today, `to` defaults to `from`. */
  @Get('calendar/events')
  async events(
    @CurrentUserId() userId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    const from = query.from ?? localClock(new Date(), user.timezone).date;
    const range = parseBody(eventsRangeSchema, {
      ...query,
      from,
      to: query.to ?? from,
    });
    return fromGoogle(() => this.data.events(userId, user.timezone, range));
  }

  @Get('tasks')
  tasks(@CurrentUserId() userId: string, @Query() query: unknown) {
    const { includeCompleted } = parseBody(tasksQuerySchema, query);
    return fromGoogle(() => this.data.tasks(userId, includeCompleted));
  }

  /** Completes a task in the default list, or opens it again. */
  @Patch('tasks/:id')
  async setTaskDone(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { done } = parseBody(doneSchema, body);
    const tool = this.tools.tools.find((t) => t.name === 'update_task');
    if (!tool) throw new NotFoundException('Google Tasks is not available');
    const input = parseBody(tool.input, {
      taskId: id,
      status: done ? 'completed' : 'needsAction',
    });
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    const task = (await fromGoogle(() =>
      tool.execute({ userId, timezone: user.timezone }, input),
    )) as { id: string; status: string };
    return { id: task.id, done: task.status === 'completed' };
  }

  @Get('google/connection')
  status(@CurrentUserId() userId: string) {
    return this.connection.status(userId);
  }

  @Delete('google/connection')
  @HttpCode(204)
  disconnect(@CurrentUserId() userId: string) {
    return this.connection.disconnect(userId);
  }
}
