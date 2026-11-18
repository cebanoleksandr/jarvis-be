import {
  BadGatewayException,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { ToolError } from '../agent/tool.js';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { localClock } from '../common/time.js';
import { parseBody } from '../common/validation.js';
import { UsersService } from '../users/users.service.js';
import { GoogleConnectionService } from './google-connection.service.js';
import { GoogleDataService } from './google-data.service.js';
import { eventsRangeSchema } from './tools/calendar.tools.js';

const tasksQuerySchema = z
  .object({
    includeCompleted: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict();

/**
 * Read-only Google data for the UI plus the connection itself. Changes to
 * Calendar and Tasks go through the agent and its confirmation cards.
 */
@Controller()
export class GoogleController {
  constructor(
    private readonly data: GoogleDataService,
    private readonly connection: GoogleConnectionService,
    private readonly users: UsersService,
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

/**
 * 409 `google_reauth_required` when the user must sign in with Google again
 * (not connected, scope not granted, token revoked); 502 for other Google failures.
 */
async function fromGoogle<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    if (err.reauthRequired) {
      throw new ConflictException({
        message: err.message,
        code: 'google_reauth_required',
      });
    }
    throw new BadGatewayException({ message: err.message });
  }
}
