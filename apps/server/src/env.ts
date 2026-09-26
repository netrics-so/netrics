import { z } from "zod";

import { processRoleSchema } from "@netrics/contracts";

// Obviously insecure fixed fallback so local development and tests work with
// zero configuration; production MUST set BETTER_AUTH_SECRET (enforced below).
const DEV_BETTER_AUTH_SECRET = "netrics-dev-only-insecure-secret-000000";

// Obviously insecure fixed fallback (base64 of a fixed 32-byte ASCII string)
// so local development and tests work with zero configuration; production
// MUST set APP_ENCRYPTION_KEY (enforced below). Generate a real one with
// `openssl rand -base64 32`.
const DEV_APP_ENCRYPTION_KEY = "bmV0cmljcy1kZXYtb25seS1pbnNlY3VyZS1rZXkhITE=";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    HOST: z.string().min(1).default("0.0.0.0"),
    DATABASE_URL: z
      .url()
      .default("postgres://netrics_app:netrics_app@localhost:5433/netrics"),
    // Role used by apps/server:migrate. Falls back to DATABASE_URL; set it to
    // the owner/migration role (RLS applies to netrics_app).
    DATABASE_MIGRATION_URL: z.url().optional(),
    // better-auth session signing secret (>= 32 chars).
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    // Instance master key for credential envelopes (base64, 32 bytes decoded).
    APP_ENCRYPTION_KEY: z
      .base64()
      .refine((value) => Buffer.from(value, "base64").length === 32, {
        message: "APP_ENCRYPTION_KEY must decode to exactly 32 bytes",
      })
      .optional(),
    // Base URL of this API server as reachable by browsers.
    BETTER_AUTH_URL: z.url().default("http://localhost:3001"),
    // Browser origin allowed to call the API with credentials (CORS +
    // better-auth trustedOrigins).
    WEB_ORIGIN: z.url().default("http://localhost:3000"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    NETRICS_ROLE: processRoleSchema.default("api"),
    APP_VERSION: z.string().min(1).default("0.0.0-dev"),
    GIT_SHA: z.string().min(1).default("dev"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.BETTER_AUTH_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_SECRET"],
        message:
          "BETTER_AUTH_SECRET (>= 32 chars) is required when NODE_ENV=production",
      });
    }
    if (env.NODE_ENV === "production" && !env.APP_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_ENCRYPTION_KEY"],
        message:
          "APP_ENCRYPTION_KEY (base64, 32 bytes) is required when NODE_ENV=production",
      });
    }
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    databaseMigrationUrl: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
    betterAuthSecret: env.BETTER_AUTH_SECRET ?? DEV_BETTER_AUTH_SECRET,
    appEncryptionKey: env.APP_ENCRYPTION_KEY ?? DEV_APP_ENCRYPTION_KEY,
    betterAuthUrl: env.BETTER_AUTH_URL,
    webOrigin: env.WEB_ORIGIN,
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
