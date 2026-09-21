import { runMigrations } from "@netrics/database";

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

try {
  await runMigrations(config.databaseUrl);
  console.log(
    `Migrations applied (version ${config.version}, commit ${config.commit})`,
  );
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
}
