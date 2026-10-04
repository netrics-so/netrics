import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Web components are rendered in tests (react-dom/server); apps/web's
  // tsconfig keeps JSX for Next.js ("preserve"), so transform it here.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      // apps/web's own path alias (tsconfig "@/*").
      "@": r("./apps/web/src"),
      "@netrics/contracts": r("./packages/contracts/src/index.ts"),
      "@netrics/connector-sdk/testing": r(
        "./packages/connector-sdk/src/testing/index.ts",
      ),
      "@netrics/connector-sdk": r("./packages/connector-sdk/src/index.ts"),
      "@netrics/connector-runtime": r(
        "./packages/connector-runtime/src/index.ts",
      ),
      "@netrics/connectors": r("./packages/connectors/src/index.ts"),
      "@netrics/database/testing": r("./packages/database/src/test-db.ts"),
      "@netrics/database": r("./packages/database/src/index.ts"),
      "@netrics/domain": r("./packages/domain/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: [
      "apps/*/src/**/*.test.ts",
      "apps/web/src/**/*.test.tsx",
      "packages/*/src/**/*.test.ts",
      "*.test.ts",
    ],
  },
});
