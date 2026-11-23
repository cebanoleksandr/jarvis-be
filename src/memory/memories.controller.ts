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
import { MEMORY_CATEGORIES, type Memory } from './memory.entity.js';

const memoryFields = {
  text: z.string().trim().min(1).max(1000),
  category: z.enum(MEMORY_CATEGORIES),
};
const createMemorySchema = z
  .object(memoryFields)
  .partial({ category: true })
  .strict();
const updateMemorySchema = z
  .object(memoryFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const toDto = ({ id, text, category, createdAt, updatedAt }: Memory) => ({
  id,
  text,
  category,
  createdAt,
  updatedAt,
});

@Controller('memories')
export class MemoriesController {
  constructor(private readonly memories: MemoriesService) {}

  @Get()
  async list(@CurrentUserId() userId: string) {
    return (await this.memories.list(userId)).map(toDto);
  }

  @Post()
  async create(@CurrentUserId() userId: string, @Body() body: unknown) {
    return toDto(
      await this.memories.create(userId, parseBody(createMemorySchema, body)),
    );
  }

  @Patch(':id')
  async update(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return toDto(
      await this.memories.update(
        userId,
        id,
        parseBody(updateMemorySchema, body),
      ),
    );
  }

  /** Forgets every note; goals and the profile stay. */
  @Delete()
  @HttpCode(204)
  async removeAll(@CurrentUserId() userId: string) {
    await this.memories.removeAll(userId);
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
