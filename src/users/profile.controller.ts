import { Body, Controller, Get, Patch } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { isValidTimeZone, parseBody } from '../common/validation.js';
import { LANGUAGES } from './languages.js';
import { UsersService } from './users.service.js';

const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(200).nullable(),
    timezone: z.string().refine(isValidTimeZone, 'Unknown IANA time zone'),
    language: z.enum(LANGUAGES).nullable(),
    about: z.string().max(4000),
    preferences: z
      .record(z.string().trim().min(1).max(100), z.string().max(500))
      .refine((p) => Object.keys(p).length <= 50, 'At most 50 preferences'),
  })
  .partial()
  .strict();

@Controller('profile')
export class ProfileController {
  constructor(private readonly users: UsersService) {}

  @Get()
  get(@CurrentUserId() userId: string) {
    return this.users.getProfile(userId);
  }

  @Patch()
  update(@CurrentUserId() userId: string, @Body() body: unknown) {
    return this.users.updateProfile(
      userId,
      parseBody(updateProfileSchema, body),
    );
  }
}
