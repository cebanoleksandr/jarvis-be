import { z } from 'zod';

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'must be 32 bytes, base64-encoded (openssl rand -base64 32)',
  });

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  DB_LOGGING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  FRONTEND_URL: z.url().default('http://localhost:5173'),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_CALLBACK_URL: z.url(),

  /** AES-256-GCM key for OAuth tokens at rest. */
  TOKEN_ENC_KEY: base64Key32,
  /** HMAC secret for session JWTs. */
  JWT_SECRET: z.string().min(32),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid environment variables:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
