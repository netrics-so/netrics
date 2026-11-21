import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CUSTOM_API_EXPORT_FORMAT,
  connectionResponseSchema,
  customApiDefinitionResponseSchema,
  customApiErrorResponseSchema,
  customApiExportSchema,
} from "@netrics/contracts";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import {
  FIXTURE_SECRETS,
  fixtureDefinition,
  startCustomApiFixtureServer,
  type CustomApiFixtureServer,
} from "@netrics/connectors/custom-api/testing";

import { exportFileSlug, parseImport } from "./custom-api/transfer.js";
import {
  customApiFixture,
  startCustomApiTestApp,
  type CustomApiTestApp,
} from "./custom-api/test-helpers.js";
import { TEST_DATABASE_SETUP_TIMEOUT_MS } from "./test-db.js";

// Export and import of custom API definitions (#808): the file holds the
// document only (no login, no connection value, no ids), and an import
// validates and upgrades like a save and creates a new definition.

let fixture: CustomApiFixtureServer;
let t: CustomApiTestApp;
let owner: string;
let viewer: string;
let other: string;
let workspaceId: string;
let otherWorkspaceId: string;

const defs = (workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/custom-api/definitions`;

/** The bearer fixture with a plain connection variable. */
function bearer(): CustomApiDefinition {
  const base = fixtureDefinition("bearer", fixture.origin);
  return {
    ...base,
    name: "Shop API",
    variables: [{ id: "account_id", label: "Account", secret: false }],
  };
}

async function create(
  document: unknown,
  workspace = workspaceId,
  cookie = owner,
) {
  const res = await t.call("POST", defs(workspace), cookie, { document });
  expect(res.statusCode, res.body).toBe(201);
  return customApiDefinitionResponseSchema.parse(res.json()).definition;
}

const importFile = (
  file: unknown,
  extra: Record<string, unknown> = {},
  workspace = otherWorkspaceId,
  cookie = other,
) => t.call("POST", `${defs(workspace)}/import`, cookie, { file, ...extra });

/** Every form a secret could take in a text. */
const forms = (value: string) => [
  value,
  encodeURIComponent(value),
  Buffer.from(value).toString("base64"),
  JSON.stringify(value).slice(1, -1),
];

beforeAll(async () => {
  fixture = await startCustomApiFixtureServer({ tls: true });
  t = await startCustomApiTestApp({
    deps: {
      executeOptions: {
        egress: { tlsCa: fixture.ca!, allowPrivateHosts: ["127.0.0.1"] },
      },
    },
  });
  owner = await t.signUp("transfer-owner@example.com");
  viewer = await t.signUp("transfer-viewer@example.com");
  other = await t.signUp("transfer-other@example.com");
  workspaceId = await t.newWorkspace(owner);
  await t.addMember(
    owner,
    workspaceId,
    "transfer-viewer@example.com",
    "viewer",
  );
  otherWorkspaceId = await t.newWorkspace(other, "Other");
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
  await fixture?.close();
});

describe("custom API export", () => {
  it("exports the document with schemaVersion and no credentials or connection values", async () => {
    const definition = await create(bearer());
    const connectionIds: string[] = [];
    for (const name of ["Shop A", "Shop B"]) {
      const res = await t.call(
        "POST",
        `${defs()}/${definition.id}/connections`,
        owner,
        {
          name,
          environmentId: "production",
          variables: { account_id: "ACCT-777" },
          credentials: { token: FIXTURE_SECRETS.token },
        },
      );
      expect(res.statusCode, res.body).toBe(201);
      connectionIds.push(
        connectionResponseSchema.parse(res.json()).connection.id,
      );
    }
    const res = await t.call(
      "GET",
      `${defs()}/${definition.id}/export`,
      viewer,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="shop-api.netrics-api.json"',
    );
    expect(res.headers["cache-control"]).toBe("no-store");
    const file = customApiExportSchema.parse(res.json());
    expect(file).toMatchObject({
      format: CUSTOM_API_EXPORT_FORMAT,
      schemaVersion: 1,
    });
    expect(file.definition).toEqual(definition.document);
    for (const secret of [
      FIXTURE_SECRETS.token,
      "ACCT-777",
      ...connectionIds,
      workspaceId,
      definition.id,
    ])
      for (const form of forms(secret)) expect(res.body).not.toContain(form);
    const [audit] = await t.admin<{ n: number }[]>`
      select count(*)::int as n from audit_events
      where action = 'custom_api_definition.exported' and target = ${definition.id}`;
    expect(audit!.n).toBe(1);
  });

  it("exports an older version on request", async () => {
    const definition = await create(bearer());
    const saved = await t.call(
      "POST",
      `${defs()}/${definition.id}/versions`,
      owner,
      {
        baseVersion: 1,
        document: { ...bearer(), name: "Shop API v2" },
      },
    );
    expect(saved.statusCode).toBe(201);
    const v1 = customApiExportSchema.parse(
      (
        await t.call(
          "GET",
          `${defs()}/${definition.id}/export?version=1`,
          owner,
        )
      ).json(),
    );
    expect((v1.definition as { name: string }).name).toBe("Shop API");
    expect(
      (
        await t.call(
          "GET",
          `${defs()}/${definition.id}/export?version=9`,
          owner,
        )
      ).statusCode,
    ).toBe(404);
  });

  it("makes file names from the definition name", () => {
    expect(exportFileSlug("Shop API")).toBe("shop-api");
    expect(exportFileSlug("Ärger & Größe!")).toBe("arger-grosse");
    expect(exportFileSlug("日本")).toBe("custom-api");
    expect(exportFileSlug("a".repeat(80))).toHaveLength(60);
  });
});

describe("custom API import", () => {
  it("imports an export into another workspace as a new definition", async () => {
    const definition = await create(bearer());
    const exported = (
      await t.call("GET", `${defs()}/${definition.id}/export`, owner)
    ).json();
    const res = await importFile(exported);
    expect(res.statusCode, res.body).toBe(201);
    const imported = customApiDefinitionResponseSchema.parse(
      res.json(),
    ).definition;
    expect(imported.id).not.toBe(definition.id);
    expect(imported.currentVersion).toBe(1);
    expect(imported.document).toEqual(definition.document);
    const [row] = await t.admin<{ created_by: string; email: string }[]>`
      select v.created_by, u.email from custom_api_definition_versions v
      join users u on u.id = v.created_by
      where v.definition_id = ${imported.id}`;
    expect(row!.email).toBe("transfer-other@example.com");
    const [audit] = await t.admin<{ n: number }[]>`
      select count(*)::int as n from audit_events
      where action = 'custom_api_definition.imported' and target = ${imported.id}`;
    expect(audit!.n).toBe(1);
  });

  it("upgrades an older schema version on import", async () => {
    // Only schema version 1 exists: the older shape is a version-1 file
    // without the keys today's schema defaults.
    const document = customApiFixture("v1-shop") as Record<string, unknown>;
    delete document.defaults;
    const res = await importFile({
      format: CUSTOM_API_EXPORT_FORMAT,
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      definition: document,
    });
    expect(res.statusCode, res.body).toBe(201);
    const imported = customApiDefinitionResponseSchema.parse(
      res.json(),
    ).definition;
    expect(imported.document.defaults).toEqual({
      refreshMinutes: 60,
      timeZone: "UTC",
    });
  });

  it("refuses a file with extra keys such as credentials", async () => {
    const file = {
      format: CUSTOM_API_EXPORT_FORMAT,
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      definition: { ...bearer(), credentials: { token: "IMPORT-SECRET-9" } },
    };
    const res = await importFile(file);
    expect(res.statusCode).toBe(400);
    const body = customApiErrorResponseSchema.parse(res.json());
    expect(body.error).toBe("custom_api_import_invalid");
    expect(res.body).not.toContain("IMPORT-SECRET-9");
    const envelope = await importFile({
      ...file,
      definition: bearer(),
      token: "x",
    });
    expect(customApiErrorResponseSchema.parse(envelope.json()).error).toBe(
      "custom_api_import_invalid",
    );
  });

  it("refuses a newer schema version with a clear code", async () => {
    for (const file of [
      {
        format: CUSTOM_API_EXPORT_FORMAT,
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        definition: { ...bearer(), schemaVersion: 2 },
      },
      {
        format: CUSTOM_API_EXPORT_FORMAT,
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        definition: { ...bearer(), schemaVersion: 2 },
      },
    ]) {
      const res = await importFile(file);
      expect(res.statusCode).toBe(400);
      expect(customApiErrorResponseSchema.parse(res.json()).error).toBe(
        "custom_api_import_newer",
      );
    }
  });

  it("lists validation issues without echoing values", async () => {
    const document = {
      ...bearer(),
      // A reserved secret variable name and a value that must not echo.
      variables: [{ id: "token", label: "VALUE-ECHO-123", secret: true }],
      environments: [
        { id: "production", name: "P", baseUrl: "http://VALUE-ECHO-456.test" },
      ],
    };
    const res = await importFile({
      format: CUSTOM_API_EXPORT_FORMAT,
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      definition: document,
    });
    expect(res.statusCode).toBe(400);
    const body = customApiErrorResponseSchema.parse(res.json());
    expect(body.error).toBe("custom_api_import_invalid");
    expect(body.issues!.length).toBeGreaterThan(0);
    expect(body.issues!.length).toBeLessThanOrEqual(20);
    expect(
      body.issues!.every((issue) => issue.path.startsWith("definition")),
    ).toBe(true);
    expect(res.body).not.toContain("VALUE-ECHO");
    // Not a file at all.
    expect(parseImport("hello")).toMatchObject({
      ok: false,
      error: "custom_api_import_invalid",
    });
  });

  it("refuses a reserved variable name as a save does", async () => {
    const res = await importFile({
      format: CUSTOM_API_EXPORT_FORMAT,
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      definition: {
        ...bearer(),
        variables: [
          { id: "account_id", label: "Account", secret: false },
          { id: "password", label: "Password", secret: true },
        ],
      },
    });
    const body = customApiErrorResponseSchema.parse(res.json());
    expect(body.issues).toContainEqual(
      expect.objectContaining({
        path: "definition.variables.1.id",
        code: "variable_reserved",
      }),
    );
  });

  it("refuses a file above the size limit", async () => {
    const res = await importFile({
      format: CUSTOM_API_EXPORT_FORMAT,
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      definition: { ...bearer(), padding: "x".repeat(600 * 1024) },
    });
    expect(res.statusCode).toBe(413);
  });

  it("names a duplicate import Shop API (2)", async () => {
    const definition = await create(bearer());
    const exported = (
      await t.call("GET", `${defs()}/${definition.id}/export`, owner)
    ).json();
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await importFile(exported, {}, workspaceId, owner);
      expect(res.statusCode, res.body).toBe(201);
      names.push(
        customApiDefinitionResponseSchema.parse(res.json()).definition.name,
      );
    }
    expect(names.slice(-3)).toEqual([
      "Shop API (2)",
      "Shop API (3)",
      "Shop API (4)",
    ]);
    const named = await importFile(exported, { name: "Mine" });
    expect(
      customApiDefinitionResponseSchema.parse(named.json()).definition.name,
    ).toBe("Mine");
  });

  it("lets viewers export but not import", async () => {
    const definition = await create(bearer());
    const exported = await t.call(
      "GET",
      `${defs()}/${definition.id}/export`,
      viewer,
    );
    expect(exported.statusCode).toBe(200);
    const res = await importFile(exported.json(), {}, workspaceId, viewer);
    expect(res.statusCode).toBe(403);
  });
});
