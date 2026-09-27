import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import type { AuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";

/**
 * Writes the OpenAPI document of the API to packages/contracts/openapi.json,
 * or with --check fails when the committed file differs from the code.
 * Needs no database: the app is built with stub dependencies and never
 * listens.
 */
const target = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/contracts/openapi.json",
);

const noAuth: AuthService = {
  handle: async () => {},
  getSessionIdentity: async () => null,
};

// Fixed version so the document only changes when the API does.
const config = loadConfig({ LOG_LEVEL: "silent", APP_VERSION: "0.x" });
const app = await buildApp(config, {
  authService: noAuth,
  checkDb: async () => true,
});
await app.ready();
const document = `${JSON.stringify(app.swagger(), null, 2)}\n`;
await app.close();

if (process.argv.includes("--check")) {
  const committed = await readFile(target, "utf8").catch(() => "");
  if (committed !== document) {
    console.error(
      "packages/contracts/openapi.json is out of date. Run `pnpm openapi` and commit the result.",
    );
    process.exit(1);
  }
  console.log("openapi.json is up to date");
} else {
  await writeFile(target, document);
  console.log(`wrote ${path.relative(process.cwd(), target)}`);
}
