import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgresql://")),
  PUBLIC_ORIGIN: z
    .string()
    .url()
    .transform((value) => value.replace(/\/$/, "")),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8000),
  SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  AGENT_TOKEN_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  AUTH_THROTTLE_KEY: z.string().min(32),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = z.infer<typeof configSchema>;

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  cached ??= configSchema.parse(process.env);
  return cached;
}

export function setConfigForTest(config: AppConfig | undefined): void {
  cached = config;
}
