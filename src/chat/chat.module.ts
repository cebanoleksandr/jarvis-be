import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LlmModule } from '../llm/llm.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { UsersModule } from '../users/users.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { Conversation } from './conversation.entity.js';
import { Message } from './message.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, Message]),
    LlmModule,
    MemoryModule,
    UsersModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
