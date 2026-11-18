import { Module } from '@nestjs/common';
import { GoogleModule } from '../google/google.module.js';
import { UsersModule } from '../users/users.module.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';

@Module({
  imports: [GoogleModule, UsersModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
