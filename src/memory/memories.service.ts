import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Memory } from './memory.entity.js';

export const MAX_MEMORIES_PER_USER = 200;

@Injectable()
export class MemoriesService {
  constructor(
    @InjectRepository(Memory) private readonly memories: Repository<Memory>,
  ) {}

  list(userId: string): Promise<Memory[]> {
    return this.memories.find({
      where: { userId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  async create(userId: string, text: string): Promise<Memory> {
    if ((await this.memories.countBy({ userId })) >= MAX_MEMORIES_PER_USER) {
      throw new BadRequestException(
        `At most ${MAX_MEMORIES_PER_USER} memories`,
      );
    }
    return this.memories.save(this.memories.create({ userId, text }));
  }

  async update(userId: string, id: string, text: string): Promise<Memory> {
    const memory = await this.memories.findOneBy({ id, userId });
    if (!memory) throw new NotFoundException('Memory not found');
    memory.text = text;
    return this.memories.save(memory);
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.memories.delete({ id, userId });
    if (!result.affected) throw new NotFoundException('Memory not found');
  }
}
