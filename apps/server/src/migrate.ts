import {
  createDefaultRegistry,
  logRegisteredConnectors,
} from "./connectors.js";
import {
  createDatabase,
  findRolesWithDefaultPasswords,
  recordInstalledVersion,
  runMigrations,
} from "@netrics/database";

import { ConfigError, loadMigrationConfig } from "./env.js";
import { syncCatalog } from "./sync/catalog.js";

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
  // The connector catalog mirrors the bundle shipped in this image; it is
  // installation-level and read-only for the application roles (#36).
  const ownerDb = createDatabase(config.databaseMigrationUrl, { max: 1 });
  try {
    const registry = createDefaultRegistry(config);
    logRegisteredConnectors(
      {
        info: (details, message) =>
          console.log(`${message}: ${JSON.stringify(details)}`),
        warn: (details, message) =>
          console.warn(`${message}: ${JSON.stringify(details)}`),
      },
      registry,
      config,
    );
    await syncCatalog(ownerDb, registry);
    // Backups name and carry the release that wrote them (#642).
    await recordInstalledVersion(ownerDb, {
      version: config.version,
      commit: config.commit,
    });
  } finally {
    await ownerDb.$client.end({ timeout: 5 }).catch(() => undefined);
  }
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
