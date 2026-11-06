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
import { GOAL_STATUSES, type Goal } from './goal.entity.js';
import { GoalsService } from './goals.service.js';

const goalFields = {
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(4000),
  status: z.enum(GOAL_STATUSES),
  deadline: z.iso.date().nullable(),
  parentId: z.uuid().nullable(),
};
const createGoalSchema = z
  .object(goalFields)
  .partial()
  .required({ title: true })
  .strict();
const updateGoalSchema = z.object(goalFields).partial().strict();

const toDto = ({
  id,
  parentId,
  title,
  notes,
  status,
  deadline,
  createdAt,
  updatedAt,
}: Goal) => ({
  id,
  parentId,
  title,
  notes,
  status,
  deadline,
  createdAt,
  updatedAt,
});

@Controller('goals')
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  async list(@CurrentUserId() userId: string) {
    return (await this.goals.list(userId)).map(toDto);
  }

  @Post()
  async create(@CurrentUserId() userId: string, @Body() body: unknown) {
    return toDto(
      await this.goals.create(userId, parseBody(createGoalSchema, body)),
    );
  }

  @Patch(':id')
  async update(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return toDto(
      await this.goals.update(userId, id, parseBody(updateGoalSchema, body)),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.goals.remove(userId, id);
  }
}
