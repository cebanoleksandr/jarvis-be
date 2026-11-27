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
  /**
   * Built frontend to serve from the API's origin (set by the Dockerfile).
   * Skipped when unset or when the folder has no index.html.
   */
  WEB_DIST: z.string().min(1).optional(),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_CALLBACK_URL: z.url(),

  /**
   * Trello API key (trello.com/power-ups/admin). Without it the Trello
   * connection is hidden; with it, FRONTEND_URL must be an allowed origin.
   */
  TRELLO_API_KEY: z.string().min(1).optional(),

  /** AES-256-GCM key for OAuth tokens at rest. */
  TOKEN_ENC_KEY: base64Key32,
  /** HMAC secret for session JWTs. */
  JWT_SECRET: z.string().min(32),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),

  /** Which API answers chat requests. Each needs its own key below. */
  LLM_PROVIDER: z.enum(['anthropic', 'openrouter']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  /** Defaults to claude-opus-5-5 (anthropic) or openrouter/free (openrouter). */
  LLM_MODEL: z.string().min(1).optional(),
  LLM_EFFORT: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .default('medium'),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(64000),

  /** Redis for the briefing queue (BullMQ). */
  REDIS_URL: z.url().default('redis://localhost:6381'),

  /** Morning briefings, evening check-ins and weekly reviews. Never runs under NODE_ENV=test. */
  SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5-5',
  openrouter: 'openrouter/free',
} as const;

const checkedSchema = envSchema
  .superRefine((env, ctx) => {
    const key =
      env.LLM_PROVIDER === 'openrouter'
        ? 'OPENROUTER_API_KEY'
        : 'ANTHROPIC_API_KEY';
    if (!env[key]) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `required when LLM_PROVIDER=${env.LLM_PROVIDER}`,
      });
    }
  })
  .transform((env) => ({
    ...env,
    LLM_MODEL: env.LLM_MODEL ?? DEFAULT_MODELS[env.LLM_PROVIDER],
  }));

export type Env = z.infer<typeof checkedSchema>;

/**
 * On Render the public URL is known (RENDER_EXTERNAL_URL), and the frontend
 * is served from the same origin, so both URLs default to it.
 */
function withHostDefaults(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const origin = config.RENDER_EXTERNAL_URL;
  if (typeof origin !== 'string' || !origin) return config;
  return {
    ...config,
    FRONTEND_URL: config.FRONTEND_URL || origin,
    GOOGLE_CALLBACK_URL:
      config.GOOGLE_CALLBACK_URL || `${origin}/api/auth/google/callback`,
  };
}

export function validateEnv(config: Record<string, unknown>): Env {
  const result = checkedSchema.safeParse(withHostDefaults(config));
  if (!result.success) {
    throw new Error(
      `Invalid environment variables:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
