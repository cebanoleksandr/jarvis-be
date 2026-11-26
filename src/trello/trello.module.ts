import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module.js';
import { TrelloAccount } from './trello-account.entity.js';
import { TrelloClientService } from './trello-client.service.js';
import { TrelloConnectionService } from './trello-connection.service.js';
import { TrelloController } from './trello.controller.js';
import { TrelloToolsService } from './trello-tools.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([TrelloAccount]), UsersModule],
  controllers: [TrelloController],
  providers: [TrelloClientService, TrelloConnectionService, TrelloToolsService],
  exports: [TrelloConnectionService, TrelloToolsService],
})
export class TrelloModule {}
