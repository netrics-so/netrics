import { createDatabase } from "@netrics/database";

import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./env.js";

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

if (config.role !== "api") {
  console.error(
    `Process role "${config.role}" is not implemented yet; milestone 00 ships the "api" role only.`,
  );
  process.exit(1);
}

const db = createDatabase(config.databaseUrl);
const app = await buildApp(config, { db });

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
