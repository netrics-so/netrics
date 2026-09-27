import {
  PrivilegedDatabaseRoleError,
  assertUnprivilegedRole,
  createDatabase,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./env.js";
import { startScheduler } from "./scheduler.js";
import { prepareInstallationSetup } from "./setup.js";
import { startWorker } from "./worker.js";

function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadConfigOrExit();

/**
 * Tenant isolation relies on row-level security, which PostgreSQL skips for
 * superusers and BYPASSRLS roles. Refuse to serve with such a connection.
 */
async function assertDatabaseRolesOrExit(urls: string[]): Promise<void> {
  if (config.allowPrivilegedDb) {
    console.warn(
      "NETRICS_ALLOW_PRIVILEGED_DB=true: skipping the privileged database role check",
    );
    return;
  }
  for (const url of urls) {
    try {
      await assertUnprivilegedRole(url);
    } catch (error) {
      if (error instanceof PrivilegedDatabaseRoleError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
  }
}

await assertDatabaseRolesOrExit(
  config.role === "api"
    ? [config.databaseUrl]
    : config.role === "worker"
      ? [config.databaseUrl, config.databaseSchedulerUrl]
      : [config.databaseSchedulerUrl],
);

if (config.role === "worker") {
  await startWorker(config);
} else if (config.role === "scheduler") {
  await startScheduler(config);
} else {
  const db = createDatabase(config.databaseUrl);
  const app = await buildApp(config, { db });
  await prepareInstallationSetup(config, db, app.log);

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      {
        role: config.role,
        version: config.version,
        commit: config.commit,
      },
      "api started",
    );
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}
