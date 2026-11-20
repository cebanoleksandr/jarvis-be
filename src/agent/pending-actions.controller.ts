import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { fromGoogle } from '../google/google-errors.js';
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

  /** All confirmation cards of a conversation, open and decided. */
  @Get('conversations/:id/pending-actions')
  async list(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return (await this.agent.listActions(userId, id)).map(toActionDto);
  }

  /**
   * Reverts an executed action (deletes the created event or task).
   * 409 unless it is executed and its tool supports undo; Google errors as
   * 409 `google_reauth_required` or 502.
   */
  @Post('pending-actions/:id/undo')
  @HttpCode(200)
  async undo(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return toActionDto(await fromGoogle(() => this.agent.undo(userId, id)));
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
