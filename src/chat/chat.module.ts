import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentModule } from '../agent/agent.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { Conversation } from './conversation.entity.js';
import { Message } from './message.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([Conversation, Message]), AgentModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
