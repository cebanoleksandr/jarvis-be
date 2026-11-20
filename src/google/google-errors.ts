import { BadGatewayException, ConflictException } from '@nestjs/common';
import { ToolError } from '../agent/tool.js';

/**
 * 409 `google_reauth_required` when the user must sign in with Google again
 * (not connected, scope not granted, token revoked); 502 for other Google failures.
 */
export async function fromGoogle<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    if (err.reauthRequired) {
      throw new ConflictException({
        message: err.message,
        code: 'google_reauth_required',
      });
    }
    throw new BadGatewayException({ message: err.message });
  }
}
