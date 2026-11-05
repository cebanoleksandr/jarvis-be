import { randomBytes } from 'node:crypto';
import { validateEnv } from './env.validation.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3000/api/auth/google/callback',
  TOKEN_ENC_KEY: randomBytes(32).toString('base64'),
  JWT_SECRET: 'x'.repeat(32),
};

describe('validateEnv', () => {
  it('applies defaults', () => {
    expect(validateEnv(valid)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      DB_LOGGING: false,
      SESSION_TTL_DAYS: 7,
    });
  });

  it('rejects missing DATABASE_URL', () => {
    const { DATABASE_URL: _, ...rest } = valid;
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    const env = { ...valid, TOKEN_ENC_KEY: randomBytes(16).toString('base64') };
    expect(() => validateEnv(env)).toThrow(/TOKEN_ENC_KEY/);
  });
});
