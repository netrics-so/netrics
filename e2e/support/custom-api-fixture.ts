// The custom API fixture server for the builder journey (#807), started by
// playwright.config.ts as its own web server: https on 127.0.0.1 with the
// certificate the config generated (never committed). Runs from the built
// connectors package (`pnpm build`).
import { readFileSync } from "node:fs";

import { startCustomApiFixtureServer } from "../../packages/connectors/dist/custom-api/testing/index.js";
import { CUSTOM_API_PORT, CUSTOM_API_TLS } from "./custom-api-origin.ts";

const server = await startCustomApiFixtureServer({
  port: CUSTOM_API_PORT,
  tls: {
    key: readFileSync(CUSTOM_API_TLS.key, "utf8"),
    cert: readFileSync(CUSTOM_API_TLS.cert, "utf8"),
  },
});
console.log(`custom API fixture on ${server.origin}`);

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
