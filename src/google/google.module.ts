import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GoogleAccount } from './google-account.entity.js';
import { GoogleOAuthService } from './google-oauth.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([GoogleAccount])],
  providers: [GoogleOAuthService],
  exports: [GoogleOAuthService],
})
export class GoogleModule {}
