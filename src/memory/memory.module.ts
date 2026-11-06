import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Goal } from './goal.entity.js';
import { GoalsController } from './goals.controller.js';
import { GoalsService } from './goals.service.js';
import { MemoriesController } from './memories.controller.js';
import { MemoriesService } from './memories.service.js';
import { Memory } from './memory.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([Goal, Memory])],
  controllers: [GoalsController, MemoriesController],
  providers: [GoalsService, MemoriesService],
  exports: [GoalsService, MemoriesService],
})
export class MemoryModule {}
