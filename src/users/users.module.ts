import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfileController } from './profile.controller.js';
import { Profile } from './profile.entity.js';
import { User } from './user.entity.js';
import { UserEvents } from './user-events.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([User, Profile])],
  controllers: [ProfileController],
  providers: [UsersService, UserEvents],
  exports: [UsersService, UserEvents],
})
export class UsersModule {}
