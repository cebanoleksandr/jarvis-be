import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Profile } from './profile.entity.js';
import { User } from './user.entity.js';

export interface ProfileView {
  name: string | null;
  email: string;
  timezone: string;
  about: string;
  preferences: Record<string, string>;
}

export interface ProfileUpdate {
  name?: string | null;
  timezone?: string;
  about?: string;
  preferences?: Record<string, string>;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
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
    return this.users.manager.transaction(async (m) => {
      const user = await m.findOneBy(User, { id: userId });
      if (!user) throw new NotFoundException('User not found');
      if (patch.name !== undefined) user.name = patch.name;
      if (patch.timezone !== undefined) user.timezone = patch.timezone;
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
  }
}

function toView(user: User, profile: Profile | null): ProfileView {
  return {
    name: user.name,
    email: user.email,
    timezone: user.timezone,
    about: profile?.about ?? '',
    preferences: profile?.preferences ?? {},
  };
}
