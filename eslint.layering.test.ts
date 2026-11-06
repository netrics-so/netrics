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

describe("route files", () => {
  it.each([
    'import { eq } from "drizzle-orm";\nexport { eq };\n',
    'import { schema } from "@netrics/database";\nexport { schema };\n',
  ])("reject raw queries: %s", async (source) => {
    const errors = await layeringErrors("apps/server/src/routes/x.ts", source);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("@netrics/database");
  });
});

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
    ["apps/server/src/routes/x.ts", "@netrics/contracts"],
  ])("allows %s importing %s", async (filePath, module) => {
    const errors = await layeringErrors(
      filePath,
      `import * as dep from "${module}";\nexport { dep };\n`,
    );
    expect(errors).toEqual([]);
  });
});

// Every web→API request goes through apiFetch (#155).
describe("web → API calls", () => {
  async function restrictedSyntax(filePath: string, source: string) {
    const [result] = await eslint.lintText(source, { filePath });
    return (result?.messages ?? []).filter(
      (message) => message.ruleId === "no-restricted-syntax",
    );
  }

  it.each([
    'const base = "http://api:3001";\nexport const r = fetch(`${base}/v1/me`);\n',
    'export const r = fetch(new URL("/v1/me", "http://api:3001"));\n',
    'export const r = fetch("http://api:3001/v1/me");\n',
    'export const r = fetch("//api:3001/v1/me");\n',
    "export const u = process.env.NETRICS_API_URL;\n",
    'export const u = process.env["NETRICS_API_URL"];\n',
  ])("rejects a direct API call outside the helper: %s", async (source) => {
    const errors = await restrictedSyntax("apps/web/src/lib/x.ts", source);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("apiFetch");
  });

  it.each([
    'export const r = fetch("/v1/me", { method: "DELETE" });\n',
    'const id = "w";\nexport const r = fetch(`/v1/workspaces/${id}`);\n',
    "export const f = (path: string) => fetch(path);\n",
  ])("allows same-origin browser fetches: %s", async (source) => {
    expect(await restrictedSyntax("apps/web/src/lib/x.tsx", source)).toEqual(
      [],
    );
  });

  it("allows the helper itself to read NETRICS_API_URL", async () => {
    const errors = await restrictedSyntax(
      "apps/web/src/lib/api-fetch.ts",
      "export const u = process.env.NETRICS_API_URL;\n",
    );
    expect(errors).toEqual([]);
  });
});
