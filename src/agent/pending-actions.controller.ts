import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { streamSse } from '../common/sse.js';
import { parseBody } from '../common/validation.js';
import { AgentService, type Decision, toActionDto } from './agent.service.js';

const confirmSchema = z
  .object({
    /** Edited arguments; validated against the tool's schema. */
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

@Controller()
export class PendingActionsController {
  private readonly logger = new Logger(PendingActionsController.name);

  constructor(private readonly agent: AgentService) {}

  /** Open confirmation cards for a conversation (e.g. after a page reload). */
  @Get('conversations/:id/pending-actions')
  async list(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return (await this.agent.listPending(userId, id)).map(toActionDto);
  }

  /** Runs the action (optionally with edited args) and streams the continued reply. */
  @Post('pending-actions/:id/confirm')
  async confirm(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    const { args } = parseBody(confirmSchema, body ?? {});
    await this.decide(userId, id, { type: 'confirm', args }, res);
  }

  /** Declines the action and streams the continued reply. */
  @Post('pending-actions/:id/cancel')
  async cancel(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    await this.decide(userId, id, { type: 'cancel' }, res);
  }

  private async decide(
    userId: string,
    id: string,
    decision: Decision,
    res: Response,
  ) {
    const prepared = await this.agent.prepareDecision(userId, id, decision);
    await streamSse(
      res,
      (signal) => this.agent.resolve(userId, prepared, decision, signal),
      this.logger,
    );
  }
}
