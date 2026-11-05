import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

export interface SessionUser {
  id: string;
}

export type AuthedRequest = Request & { user?: SessionUser };

/** The only legitimate source of userId: the verified session. */
export const CurrentUserId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => {
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user) throw new UnauthorizedException();
    return user.id;
  },
);
