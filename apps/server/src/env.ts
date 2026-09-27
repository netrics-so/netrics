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

function base64Key(name: string) {
  return z
    .base64()
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: `${name} must decode to exactly 32 bytes`,
    });
}

// Retired keys (comma-separated, same format) that may still protect stored
// credentials during a rotation; see README "Rotating the encryption key".
const previousKeys = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
  )
  .pipe(z.array(base64Key("APP_ENCRYPTION_KEYS_PREVIOUS entries")));

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
    // Scheduler-role connection (claiming jobs, planning due syncs, worker
    // heartbeats). Used by NETRICS_ROLE=worker and =scheduler. Dev default
    // matches the migration-created dev role; required in production.
    DATABASE_SCHEDULER_URL: z.url().optional(),
    // Role used by apps/server:migrate. Falls back to DATABASE_URL; set it to
    // the owner/migration role (RLS applies to netrics_app).
    DATABASE_MIGRATION_URL: z.url().optional(),
    // Scheduler: how often to plan due syncs.
    SCHEDULER_POLL_MS: z.coerce.number().int().min(50).default(5000),
    // Worker: idle sleep between claim attempts and max parallel jobs.
    WORKER_POLL_MS: z.coerce.number().int().min(10).default(1000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    // better-auth session signing secret (>= 32 chars).
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    // Instance master key for credential envelopes (base64, 32 bytes decoded).
    APP_ENCRYPTION_KEY: base64Key("APP_ENCRYPTION_KEY").optional(),
    APP_ENCRYPTION_KEYS_PREVIOUS: previousKeys,
    // Public base URL of the auth endpoints as browsers reach them. Required
    // (https) for the api role in production; localhost default otherwise.
    BETTER_AUTH_URL: z.url().optional(),
    // Browser origin allowed to call the API with credentials (CORS +
    // better-auth trustedOrigins). Same production rule as BETTER_AUTH_URL.
    WEB_ORIGIN: z.url().optional(),
    // Outbound email for verification and password reset, e.g.
    // smtps://user:pass@smtp.example.com:465. Without it, production refuses
    // to send auth emails instead of logging their secret links.
    SMTP_URL: z
      .url()
      .refine((value) => /^smtps?:\/\//.test(value), {
        message: "SMTP_URL must start with smtp:// or smtps://",
      })
      .optional(),
    // Who may create accounts. "closed": only the first account, created with
    // the one-time setup token (see src/setup.ts). "open": anyone (hosted
    // service, local development). Default: closed in production.
    NETRICS_SIGNUP: z.enum(["open", "closed"]).optional(),
    // Optional fixed setup token (>= 24 chars) instead of a generated one
    // that is printed to the log, e.g. set by an install script.
    NETRICS_SETUP_TOKEN: z.string().min(24).optional(),
    // Sender address for auth emails; required with SMTP_URL.
    MAIL_FROM: z.string().min(3).optional(),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    NETRICS_ROLE: processRoleSchema.default("api"),
    // Local-debugging escape hatch for the privileged-role startup guard.
    // Refused in production.
    NETRICS_ALLOW_PRIVILEGED_DB: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    APP_VERSION: z.string().min(1).default("0.0.0-dev"),
    GIT_SHA: z.string().min(1).default("dev"),
  })
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === "production";
    if (production && env.NETRICS_ROLE === "api") {
      for (const key of ["BETTER_AUTH_URL", "WEB_ORIGIN"] as const) {
        const value = env[key];
        if (!value || new URL(value).protocol !== "https:") {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} must be set to an https:// URL when NODE_ENV=production`,
          });
        }
      }
    }
    if (production && env.BETTER_AUTH_SECRET === DEV_BETTER_AUTH_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_SECRET"],
        message: "BETTER_AUTH_SECRET is the public development value",
      });
    }
    if (production && env.APP_ENCRYPTION_KEY === DEV_APP_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_ENCRYPTION_KEY"],
        message: "APP_ENCRYPTION_KEY is the public development value",
      });
    }
    if (env.SMTP_URL && !env.MAIL_FROM) {
      ctx.addIssue({
        code: "custom",
        path: ["MAIL_FROM"],
        message: "MAIL_FROM is required when SMTP_URL is set",
      });
    }
    if (production && env.NETRICS_ALLOW_PRIVILEGED_DB) {
      ctx.addIssue({
        code: "custom",
        path: ["NETRICS_ALLOW_PRIVILEGED_DB"],
        message:
          "NETRICS_ALLOW_PRIVILEGED_DB is not allowed when NODE_ENV=production",
      });
    }
    if (
      env.NODE_ENV === "production" &&
      env.NETRICS_ROLE === "api" &&
      !env.BETTER_AUTH_SECRET
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_SECRET"],
        message:
          "BETTER_AUTH_SECRET (>= 32 chars) is required when NODE_ENV=production",
      });
    }
    // The scheduler only plans and claims; it never decrypts credentials.
    if (
      env.NODE_ENV === "production" &&
      env.NETRICS_ROLE !== "scheduler" &&
      !env.APP_ENCRYPTION_KEY
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_ENCRYPTION_KEY"],
        message:
          "APP_ENCRYPTION_KEY (base64, 32 bytes) is required when NODE_ENV=production",
      });
    }
    if (
      env.NODE_ENV === "production" &&
      env.NETRICS_ROLE !== "api" &&
      !env.DATABASE_SCHEDULER_URL
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_SCHEDULER_URL"],
        message:
          "DATABASE_SCHEDULER_URL is required for worker/scheduler roles when NODE_ENV=production",
      });
    }
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    databaseSchedulerUrl:
      env.DATABASE_SCHEDULER_URL ??
      "postgres://netrics_scheduler:netrics_scheduler@localhost:5433/netrics",
    databaseMigrationUrl: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
    schedulerPollMs: env.SCHEDULER_POLL_MS,
    workerPollMs: env.WORKER_POLL_MS,
    workerConcurrency: env.WORKER_CONCURRENCY,
    betterAuthSecret: env.BETTER_AUTH_SECRET ?? DEV_BETTER_AUTH_SECRET,
    appEncryptionKey: env.APP_ENCRYPTION_KEY ?? DEV_APP_ENCRYPTION_KEY,
    appEncryptionKeysPrevious: env.APP_ENCRYPTION_KEYS_PREVIOUS,
    signup:
      env.NETRICS_SIGNUP ?? (env.NODE_ENV === "production" ? "closed" : "open"),
    setupToken: env.NETRICS_SETUP_TOKEN ?? null,
    betterAuthUrl: env.BETTER_AUTH_URL ?? "http://localhost:3001",
    webOrigin: env.WEB_ORIGIN ?? "http://localhost:3000",
    smtp:
      env.SMTP_URL && env.MAIL_FROM
        ? { url: env.SMTP_URL, from: env.MAIL_FROM }
        : null,
    logLevel: env.LOG_LEVEL,
    role: env.NETRICS_ROLE,
    allowPrivilegedDb: env.NETRICS_ALLOW_PRIVILEGED_DB,
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

function formatIssues(error: z.ZodError): string {
  const details = error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  return `Invalid environment configuration. Fix the following variables:\n${details}`;
}

// Role passwords are secrets for long-lived login roles; require real length
// in production.
const rolePasswordSchema = z.string().min(1);

/**
 * Configuration for `migrate` only. It needs the owner connection and the
 * role passwords to provision — not the runtime secrets of api/worker.
 */
const migrationEnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_MIGRATION_URL: z.url().optional(),
    DATABASE_URL: z.url().optional(),
    NETRICS_APP_DB_PASSWORD: rolePasswordSchema.optional(),
    NETRICS_SCHEDULER_DB_PASSWORD: rolePasswordSchema.optional(),
    APP_VERSION: z.string().min(1).default("0.0.0-dev"),
    GIT_SHA: z.string().min(1).default("dev"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") {
      return;
    }
    for (const key of [
      "NETRICS_APP_DB_PASSWORD",
      "NETRICS_SCHEDULER_DB_PASSWORD",
    ] as const) {
      const value = env[key];
      if (value !== undefined && value.length < 24) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must be at least 24 characters when NODE_ENV=production`,
        });
      }
    }
  })
  .transform((env) => {
    const production = env.NODE_ENV === "production";
    return {
      nodeEnv: env.NODE_ENV,
      databaseMigrationUrl:
        env.DATABASE_MIGRATION_URL ??
        env.DATABASE_URL ??
        "postgres://netrics:netrics@localhost:5433/netrics",
      // Outside production, provision the well-known dev passwords so local
      // setups work with zero configuration.
      rolePasswords: {
        netrics_app:
          env.NETRICS_APP_DB_PASSWORD ??
          (production ? undefined : "netrics_app"),
        netrics_scheduler:
          env.NETRICS_SCHEDULER_DB_PASSWORD ??
          (production ? undefined : "netrics_scheduler"),
      },
      version: env.APP_VERSION,
      commit: env.GIT_SHA,
    };
  });

export type MigrationConfig = z.infer<typeof migrationEnvSchema>;

/** The credential keyring settings alone (operator CLI re-encryption). */
const keyringEnvSchema = z.object({
  APP_ENCRYPTION_KEY: base64Key("APP_ENCRYPTION_KEY"),
  APP_ENCRYPTION_KEYS_PREVIOUS: previousKeys,
});

export function loadKeyringConfig(
  env: Record<string, string | undefined> = process.env,
): { appEncryptionKey: string; appEncryptionKeysPrevious: string[] } {
  const result = keyringEnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error));
  }
  return {
    appEncryptionKey: result.data.APP_ENCRYPTION_KEY,
    appEncryptionKeysPrevious: result.data.APP_ENCRYPTION_KEYS_PREVIOUS,
  };
}

export function loadMigrationConfig(
  env: Record<string, string | undefined> = process.env,
): MigrationConfig {
  const result = migrationEnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error));
  }
  return result.data;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error));
  }
  return result.data;
}
