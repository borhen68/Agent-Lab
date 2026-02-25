import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(10),
  REDIS_URL: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  DEFAULT_LLM_PROVIDER: z.enum(['anthropic', 'gemini', 'openai']).default('anthropic'),
  ANTHROPIC_MODEL: z.string().default('claude-3-5-sonnet-20241022'),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  TAVILY_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_SECRET: z.string().min(32),
  ENABLE_LEARNING: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  CONFIDENCE_GATE_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  CONFIDENCE_GATE_MIN_TOTAL: z.coerce.number().default(26),
  CONFIDENCE_GATE_MIN_MARGIN: z.coerce.number().default(2),
  CONFIDENCE_GATE_MIN_ACCURACY: z.coerce.number().default(6.5),
  MAX_AGENTS: z.coerce.number().default(3),
  AGENT_TIMEOUT_MS: z.coerce.number().default(120000),
});

export type Config = z.infer<typeof envSchema>;

export const config: Config = envSchema.parse(process.env);

export function validateConfig(): void {
  try {
    envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Invalid environment configuration:');
      error.errors.forEach(err => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
      process.exit(1);
    }
    throw error;
  }
}
