import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@netrics/contracts": r("./packages/contracts/src/index.ts"),
      "@netrics/connector-sdk/testing": r(
        "./packages/connector-sdk/src/testing/index.ts",
      ),
      "@netrics/connector-sdk": r("./packages/connector-sdk/src/index.ts"),
      "@netrics/connector-runtime": r(
        "./packages/connector-runtime/src/index.ts",
      ),
      "@netrics/connectors": r("./packages/connectors/src/index.ts"),
      "@netrics/database": r("./packages/database/src/index.ts"),
      "@netrics/domain": r("./packages/domain/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
  },
});
