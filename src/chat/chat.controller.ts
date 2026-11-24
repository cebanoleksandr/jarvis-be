import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { streamSse } from '../common/sse.js';
import { parseBody } from '../common/validation.js';
import { ChatService } from './chat.service.js';
import type { Conversation } from './conversation.entity.js';
import type { Message } from './message.entity.js';

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    pinned: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
});

const toConversationDto = ({
  id,
  title,
  customTitle,
  kind,
  pinnedAt,
  readAt,
  createdAt,
  updatedAt,
}: Conversation) => ({
  id,
  title,
  customTitle,
  kind,
  pinnedAt,
  readAt,
  createdAt,
  updatedAt,
});

const toMessageDto = ({
  id,
  role,
  content,
  synthetic,
  stopReason,
  createdAt,
}: Message) => ({
  id,
  role,
  content,
  synthetic,
  stopReason,
  createdAt,
});

@Controller('conversations')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(private readonly chat: ChatService) {}

  @Post()
  async create(@CurrentUserId() userId: string) {
    return toConversationDto(await this.chat.createConversation(userId));
  }

  @Get()
  async list(@CurrentUserId() userId: string) {
    return (await this.chat.listConversations(userId)).map(toConversationDto);
  }

  @Get(':id/messages')
  async messages(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return (await this.chat.listMessages(userId, id)).map(toMessageDto);
  }

  @Patch(':id')
  async update(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return toConversationDto(
      await this.chat.update(userId, id, parseBody(updateSchema, body)),
    );
  }

  @Post(':id/read')
  @HttpCode(204)
  async markRead(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.chat.markRead(userId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.chat.deleteConversation(userId, id);
  }

  /**
   * Streams the reply as Server-Sent Events over the POST response
   * (consume with fetch + ReadableStream; EventSource is GET-only).
   * Events: message_start, delta, tool_call, tool_result, action_required,
   * done (stopReason `awaiting_confirmation` when a card needs a decision), error.
   */
  @Post(':id/messages')
  async send(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    const { text } = parseBody(sendMessageSchema, body);
    // Ownership is checked before any headers go out, so errors stay plain JSON.
    await this.chat.getOwnedConversation(userId, id);
    await streamSse(
      res,
      (signal) => this.chat.sendMessage(userId, id, text, signal),
      this.logger,
    );
  }
}
