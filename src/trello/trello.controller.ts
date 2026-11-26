import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { parseBody } from '../common/validation.js';
import { fromGoogle as fromService } from '../google/google-errors.js';
import { UsersService } from '../users/users.service.js';
import { TrelloClientService } from './trello-client.service.js';
import { TrelloConnectionService } from './trello-connection.service.js';
import { fetchCards } from './tools/trello.tools.js';

const connectSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9]{32,128}$/),
    state: z.string().min(1).max(200),
  })
  .strict();

const dueQuerySchema = z
  .object({
    days: z.coerce.number().int().min(0).max(14).default(0),
  })
  .strict();

/**
 * The Trello connection and read-only card data for the UI. Changes to
 * Trello go through the agent and its confirmation cards.
 */
@Controller('trello')
export class TrelloController {
  constructor(
    private readonly connection: TrelloConnectionService,
    private readonly client: TrelloClientService,
    private readonly users: UsersService,
  ) {}

  @Get('connection')
  status(@CurrentUserId() userId: string) {
    return this.connection.status(userId);
  }

  /** Where to send the user to grant access. */
  @Post('connection/start')
  @HttpCode(200)
  start(@CurrentUserId() userId: string) {
    return { url: this.connection.authorizeUrl(userId) };
  }

  /** The token Trello handed back to the frontend, with the state from start. */
  @Post('connection')
  @HttpCode(200)
  connect(@CurrentUserId() userId: string, @Body() body: unknown) {
    const { token, state } = parseBody(connectSchema, body);
    return this.connection.connect(userId, token, state);
  }

  @Delete('connection')
  @HttpCode(204)
  disconnect(@CurrentUserId() userId: string) {
    return this.connection.disconnect(userId);
  }

  /** Open cards due by the end of today + `days` (overdue included). */
  @Get('cards/due')
  async due(@CurrentUserId() userId: string, @Query() query: unknown) {
    const { days } = parseBody(dueQuerySchema, query);
    const { timezone } = await this.users.getProfile(userId);
    return fromService(() =>
      fetchCards(this.client, userId, timezone, { dueWithinDays: days }),
    );
  }
}
