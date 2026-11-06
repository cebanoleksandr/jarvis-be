import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { parseBody } from '../common/validation.js';
import { MemoriesService } from './memories.service.js';
import type { Memory } from './memory.entity.js';

const memorySchema = z
  .object({ text: z.string().trim().min(1).max(1000) })
  .strict();

const toDto = ({ id, text, createdAt }: Memory) => ({ id, text, createdAt });

@Controller('memories')
export class MemoriesController {
  constructor(private readonly memories: MemoriesService) {}

  @Get()
  async list(@CurrentUserId() userId: string) {
    return (await this.memories.list(userId)).map(toDto);
  }

  @Post()
  async create(@CurrentUserId() userId: string, @Body() body: unknown) {
    const { text } = parseBody(memorySchema, body);
    return toDto(await this.memories.create(userId, text));
  }

  @Patch(':id')
  async update(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const { text } = parseBody(memorySchema, body);
    return toDto(await this.memories.update(userId, id, text));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.memories.remove(userId, id);
  }
}
