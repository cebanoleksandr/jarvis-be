import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Conversation } from '../chat/conversation.entity.js';
import { Message } from '../chat/message.entity.js';
import { GoogleModule } from '../google/google.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { UsersModule } from '../users/users.module.js';
import { AgentService } from './agent.service.js';
import { PendingAction } from './pending-action.entity.js';
import { PendingActionsController } from './pending-actions.controller.js';
import { ToolRegistry } from './tool-registry.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, Message, PendingAction]),
    LlmModule,
    UsersModule,
    MemoryModule,
    GoogleModule,
  ],
  controllers: [PendingActionsController],
  providers: [AgentService, ToolRegistry],
  exports: [AgentService, ToolRegistry],
})
export class AgentModule {}
