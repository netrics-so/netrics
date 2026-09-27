import {
  findRolesWithDefaultPasswords,
  runMigrations,
} from "@netrics/database";

import { ConfigError, loadMigrationConfig } from "./env.js";

function loadConfigOrExit() {
  try {
    return loadMigrationConfig();
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
  await runMigrations(config.databaseMigrationUrl, {
    rolePasswords: config.rolePasswords,
  });
  console.log(
    `Migrations applied (version ${config.version}, commit ${config.commit})`,
  );
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
}

if (config.nodeEnv === "production") {
  // Installations created before role provisioning existed may still accept
  // the development passwords published in this repository.
  const exposed = await findRolesWithDefaultPasswords(
    config.databaseMigrationUrl,
  );
  if (exposed.length > 0) {
    console.error(
      `Database role(s) ${exposed.join(", ")} still accept the public ` +
        "development password. Set NETRICS_APP_DB_PASSWORD and " +
        "NETRICS_SCHEDULER_DB_PASSWORD so migrate can rotate them.",
    );
    process.exit(1);
  }
  const missing = Object.entries(config.rolePasswords)
    .filter(([, password]) => password === undefined)
    .map(([role]) => role);
  if (missing.length > 0) {
    console.warn(
      `No password provided for ${missing.join(", ")}; left unchanged. ` +
        "Roles created by migrations cannot log in until provisioned.",
    );
  }
}
