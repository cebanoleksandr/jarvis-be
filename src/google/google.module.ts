import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module.js';
import { GoogleAccount } from './google-account.entity.js';
import { GoogleClientService } from './google-client.service.js';
import { GoogleConnectionService } from './google-connection.service.js';
import { GoogleDataService } from './google-data.service.js';
import { GoogleController } from './google.controller.js';
import { GoogleOAuthService } from './google-oauth.service.js';
import { GoogleToolsService } from './google-tools.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([GoogleAccount]), UsersModule],
  controllers: [GoogleController],
  providers: [
    GoogleOAuthService,
    GoogleClientService,
    GoogleToolsService,
    GoogleDataService,
    GoogleConnectionService,
  ],
  exports: [GoogleOAuthService, GoogleToolsService, GoogleConnectionService],
})
export class GoogleModule {}
