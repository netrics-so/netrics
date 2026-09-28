import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The package layering rule in eslint.config.mjs (#39), exercised on source
// text placed in each package.
const eslint = new ESLint();

async function layeringErrors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return (result?.messages ?? []).filter(
    (message) => message.ruleId === "no-restricted-imports",
  );
}

describe("package layering", () => {
  it.each([
    ["packages/domain/src/x.ts", "@netrics/contracts"],
    ["packages/contracts/src/x.ts", "@netrics/database"],
    ["packages/connector-runtime/src/x.ts", "@netrics/connectors"],
    ["packages/connector-sdk/src/x.ts", "@netrics/connector-runtime"],
    ["packages/database/src/x.ts", "@netrics/connector-runtime"],
    ["packages/connectors/src/x.ts", "@netrics/connector-runtime"],
  ])("rejects %s importing %s", async (filePath, module) => {
    const errors = await layeringErrors(
      filePath,
      `import * as dep from "${module}";\nexport { dep };\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("PACKAGE_LAYERS");
  });

  it.each([
    ["packages/contracts/src/x.ts", "@netrics/domain"],
    ["packages/connectors/src/x.ts", "@netrics/connector-sdk"],
    ["packages/connectors/src/x.ts", "@netrics/connector-sdk/testing"],
    ["packages/connector-runtime/src/x.test.ts", "@netrics/connectors"],
    ["apps/server/src/x.ts", "@netrics/connectors"],
  ])("allows %s importing %s", async (filePath, module) => {
    const errors = await layeringErrors(
      filePath,
      `import * as dep from "${module}";\nexport { dep };\n`,
    );
    expect(errors).toEqual([]);
  });
});
