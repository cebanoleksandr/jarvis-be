import {
  Body,
  Controller,
  Delete,
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
import { parseBody } from '../common/validation.js';
import { ChatService } from './chat.service.js';
import type { Conversation } from './conversation.entity.js';
import type { Message } from './message.entity.js';

const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
});

const toConversationDto = ({
  id,
  title,
  createdAt,
  updatedAt,
}: Conversation) => ({
  id,
  title,
  createdAt,
  updatedAt,
});

const toMessageDto = ({
  id,
  role,
  content,
  stopReason,
  createdAt,
}: Message) => ({
  id,
  role,
  content,
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
   * Events: message_start, delta, done, error.
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
    const conversation = await this.chat.getOwnedConversation(userId, id);

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      for await (const ev of this.chat.sendMessage(
        userId,
        conversation,
        text,
        abort.signal,
      )) {
        send(ev.event, ev.data);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        this.logger.error(`Chat stream failed: ${(err as Error).message}`);
        send('error', {
          message: 'The assistant failed to respond. Try again.',
        });
      }
    } finally {
      res.end();
    }
  }
}
