import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@netrics/contracts": r("./packages/contracts/src/index.ts"),
      "@netrics/database": r("./packages/database/src/index.ts"),
      "@netrics/domain": r("./packages/domain/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
  },
});
