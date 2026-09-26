import { createDefaultRegistry } from "@netrics/connector-runtime";
import { createDatabase } from "@netrics/database";

import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./env.js";
import { startScheduler } from "./scheduler.js";
import { syncCatalog } from "./sync/catalog.js";
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

if (config.role === "worker") {
  await startWorker(config);
} else if (config.role === "scheduler") {
  await startScheduler(config);
} else {
  const db = createDatabase(config.databaseUrl);
  // Installation-level connector catalog, synced from the reviewed bundle.
  await syncCatalog(db, createDefaultRegistry());
  const app = await buildApp(config, { db });

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
