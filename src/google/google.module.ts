import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GoogleAccount } from './google-account.entity.js';
import { GoogleClientService } from './google-client.service.js';
import { GoogleOAuthService } from './google-oauth.service.js';
import { GoogleToolsService } from './google-tools.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([GoogleAccount])],
  providers: [GoogleOAuthService, GoogleClientService, GoogleToolsService],
  exports: [GoogleOAuthService, GoogleToolsService],
})
export class GoogleModule {}
