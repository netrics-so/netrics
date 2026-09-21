import { z } from "zod";

import { processRoleSchema } from "@netrics/contracts";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    HOST: z.string().min(1).default("0.0.0.0"),
    DATABASE_URL: z
      .url()
      .default("postgres://netrics:netrics@localhost:5433/netrics"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    NETRICS_ROLE: processRoleSchema.default("api"),
    APP_VERSION: z.string().min(1).default("0.0.0-dev"),
    GIT_SHA: z.string().min(1).default("dev"),
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
    role: env.NETRICS_ROLE,
    version: env.APP_VERSION,
    commit: env.GIT_SHA,
  }));

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");
    throw new ConfigError(
      `Invalid environment configuration. Fix the following variables:\n${details}`,
    );
  }
  return result.data;
}
