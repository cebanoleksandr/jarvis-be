import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Goal, type GoalStatus, MAX_GOAL_DEPTH } from './goal.entity.js';

export const MAX_GOALS_PER_USER = 500;

export interface GoalInput {
  title: string;
  notes?: string;
  status?: GoalStatus;
  deadline?: string | null;
  parentId?: string | null;
}

@Injectable()
export class GoalsService {
  constructor(
    @InjectRepository(Goal) private readonly goals: Repository<Goal>,
  ) {}

  /** Flat list ordered for display; clients build the tree from parentId. */
  list(userId: string): Promise<Goal[]> {
    return this.goals.find({
      where: { userId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  async create(userId: string, input: GoalInput): Promise<Goal> {
    const all = await this.list(userId);
    if (all.length >= MAX_GOALS_PER_USER) {
      throw new BadRequestException(`At most ${MAX_GOALS_PER_USER} goals`);
    }
    const parentId = input.parentId ?? null;
    if (parentId) assertPlacement(all, null, parentId);
    return this.goals.save(this.goals.create({ ...input, userId, parentId }));
  }

  async update(
    userId: string,
    id: string,
    patch: Partial<GoalInput>,
  ): Promise<Goal> {
    const all = await this.list(userId);
    const goal = all.find((g) => g.id === id);
    if (!goal) throw new NotFoundException('Goal not found');
    if (patch.parentId !== undefined && patch.parentId !== null) {
      assertPlacement(all, id, patch.parentId);
    }
    Object.assign(goal, patch);
    return this.goals.save(goal);
  }

  /** Children are removed by ON DELETE CASCADE. */
  async remove(userId: string, id: string): Promise<void> {
    const result = await this.goals.delete({ id, userId });
    if (!result.affected) throw new NotFoundException('Goal not found');
  }
}

/**
 * Checks that `goalId` (null for a new goal) can live under `parentId`:
 * the parent belongs to the same user, no cycle, depth stays within limit.
 * `all` is the user's full goal list, so foreign ids are simply not found.
 */
export function assertPlacement(
  all: Goal[],
  goalId: string | null,
  parentId: string,
) {
  const byId = new Map(all.map((g) => [g.id, g]));
  if (!byId.has(parentId))
    throw new BadRequestException('Parent goal not found');

  let parentDepth = 0;
  for (
    let cur: string | null = parentId;
    cur;
    cur = byId.get(cur)?.parentId ?? null
  ) {
    if (cur === goalId) {
      throw new BadRequestException('A goal cannot be nested under itself');
    }
    parentDepth++;
  }

  const subtreeHeight = goalId ? heightOf(all, goalId) : 1;
  if (parentDepth + subtreeHeight > MAX_GOAL_DEPTH) {
    throw new BadRequestException(
      `Goals nest at most ${MAX_GOAL_DEPTH} levels (goal → project → task)`,
    );
  }
}

function heightOf(all: Goal[], id: string): number {
  const children = all.filter((g) => g.parentId === id);
  return 1 + Math.max(0, ...children.map((c) => heightOf(all, c.id)));
}
