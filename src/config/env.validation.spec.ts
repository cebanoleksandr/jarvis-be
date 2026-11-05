import { validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  it('applies defaults', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    });
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      DB_LOGGING: false,
    });
  });

  it('rejects missing DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });
});
