import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Profile } from './profile.entity.js';
import { UserEvents } from './user-events.js';
import type { Language } from './languages.js';
import { User } from './user.entity.js';

export interface ProfileView {
  name: string | null;
  email: string;
  timezone: string;
  language: Language | null;
  about: string;
  preferences: Record<string, string>;
}

export interface ProfileUpdate {
  name?: string | null;
  timezone?: string;
  language?: Language | null;
  about?: string;
  preferences?: Record<string, string>;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly events: UserEvents,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.users.findOneBy({ id });
  }

  async getProfile(userId: string): Promise<ProfileView> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');
    const profile = await this.profiles.findOneBy({ userId });
    return toView(user, profile);
  }

  async updateProfile(
    userId: string,
    patch: ProfileUpdate,
  ): Promise<ProfileView> {
    let timezoneChanged = false;
    const view = await this.users.manager.transaction(async (m) => {
      const user = await m.findOneBy(User, { id: userId });
      if (!user) throw new NotFoundException('User not found');
      if (patch.name !== undefined) user.name = patch.name;
      if (patch.timezone !== undefined && patch.timezone !== user.timezone) {
        user.timezone = patch.timezone;
        timezoneChanged = true;
      }
      if (patch.language !== undefined) user.language = patch.language;
      await m.save(user);

      const profile =
        (await m.findOneBy(Profile, { userId })) ??
        m.create(Profile, { userId });
      if (patch.about !== undefined) profile.about = patch.about;
      if (patch.preferences !== undefined)
        profile.preferences = patch.preferences;
      await m.save(profile);

      return toView(user, profile);
    });
    // Briefings are planned in the user's local time.
    if (timezoneChanged) this.events.scheduleChanged(userId);
    return view;
  }
}

function toView(user: User, profile: Profile | null): ProfileView {
  return {
    name: user.name,
    email: user.email,
    timezone: user.timezone,
    language: user.language,
    about: profile?.about ?? '',
    preferences: profile?.preferences ?? {},
  };
}
