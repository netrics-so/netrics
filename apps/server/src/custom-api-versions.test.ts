import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  customApiDefinitionResponseSchema,
  customApiErrorResponseSchema,
  customApiVersionHistorySchema,
  customApiVersionResponseSchema,
} from "@netrics/contracts";

import {
  customApiFixture,
  startCustomApiTestApp,
  type CustomApiTestApp,
} from "./custom-api/test-helpers.js";
import { canonicalSha256 } from "./custom-api/canonical-json.js";
import { CUSTOM_API_HISTORY_SAME_AS_LOOKBACK } from "./custom-api/versions.js";
import { TEST_DATABASE_SETUP_TIMEOUT_MS } from "./test-db.js";

// Version history and rollback of custom API definitions (#808): who
// changed what and when, restores as new versions equal to the old one,
// the stale check, and stored versions that today's rules reject.

type Doc = Record<string, unknown> & {
  name: string;
  defaults: { refreshMinutes: number; timeZone: string };
  variables: Record<string, unknown>[];
};

let t: CustomApiTestApp;
let editor: string;
let viewer: string;
let stranger: string;
let workspaceId: string;
let strangerWorkspaceId: string;

const defs = (workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/custom-api/definitions`;
const shop = (refreshMinutes = 60) => {
  const doc = customApiFixture("v1-shop") as Doc;
  return { ...doc, defaults: { ...doc.defaults, refreshMinutes } };
};

async function create(doc: Doc = shop()) {
  const res = await t.call("POST", defs(), editor, { document: doc });
  expect(res.statusCode, res.body).toBe(201);
  return customApiDefinitionResponseSchema.parse(res.json()).definition;
}

async function save(id: string, baseVersion: number, doc: Doc) {
  const res = await t.call("POST", `${defs()}/${id}/versions`, editor, {
    baseVersion,
    document: doc,
  });
  expect(res.statusCode, res.body).toBe(201);
}

const history = async (id: string, query = "", cookie = viewer) => {
  const res = await t.call("GET", `${defs()}/${id}/versions${query}`, cookie);
  expect(res.statusCode, res.body).toBe(200);
  return customApiVersionHistorySchema.parse(res.json());
};

const restore = (
  id: string,
  version: number,
  baseVersion: number,
  cookie = editor,
) =>
  t.call("POST", `${defs()}/${id}/versions/${version}/restore`, cookie, {
    baseVersion,
  });

const errorOf = (res: { statusCode: number; json(): unknown }) =>
  customApiErrorResponseSchema.parse(res.json()).error;

beforeAll(async () => {
  t = await startCustomApiTestApp();
  const owner = await t.signUp("versions-owner@example.com");
  editor = await t.signUp("versions-editor@example.com");
  viewer = await t.signUp("versions-viewer@example.com");
  stranger = await t.signUp("versions-stranger@example.com");
  workspaceId = await t.newWorkspace(owner);
  await t.addMember(
    owner,
    workspaceId,
    "versions-editor@example.com",
    "editor",
  );
  await t.addMember(
    owner,
    workspaceId,
    "versions-viewer@example.com",
    "viewer",
  );
  strangerWorkspaceId = await t.newWorkspace(stranger);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
});

describe("custom API version history", () => {
  it("lists versions newest first with author and time, 20 per page", async () => {
    const definition = await create();
    for (let version = 1; version < 23; version++)
      await save(definition.id, version, shop(60 + version));
    const first = await history(definition.id);
    expect(first.versions).toHaveLength(20);
    expect(first.versions.map((v) => v.version)).toEqual(
      Array.from({ length: 20 }, (_, i) => 23 - i),
    );
    expect(first.versions[0]).toMatchObject({
      current: true,
      sameAs: null,
      author: { name: "versions-editor@example.com" },
      summary: { streams: 1, fields: 4, environments: 2 },
    });
    expect(first.versions[1]!.current).toBe(false);
    expect(Date.parse(first.versions[0]!.createdAt)).not.toBeNaN();
    expect(first.nextBefore).toBe(4);
    const second = await history(definition.id, "?before=4");
    expect(second.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(second.nextBefore).toBeNull();
  });

  it("restores an older version as a new version equal to it", async () => {
    const definition = await create();
    await save(definition.id, 1, shop(90));
    await save(definition.id, 2, shop(120));
    const res = await restore(definition.id, 2, 3);
    expect(res.statusCode, res.body).toBe(201);
    const restored = customApiDefinitionResponseSchema.parse(res.json());
    expect(restored.definition.currentVersion).toBe(4);
    const page = await history(definition.id);
    expect(page.versions[0]).toMatchObject({
      version: 4,
      sameAs: 2,
      current: true,
    });
    const v2 = customApiVersionResponseSchema.parse(
      (
        await t.call("GET", `${defs()}/${definition.id}/versions/2`, viewer)
      ).json(),
    );
    const v4 = customApiVersionResponseSchema.parse(
      (
        await t.call("GET", `${defs()}/${definition.id}/versions/4`, viewer)
      ).json(),
    );
    expect(v4.document).toEqual(v2.document);
    const [audit] = await t.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events
      where action = 'custom_api_definition.restored' and target = ${definition.id}`;
    expect(audit!.metadata).toEqual({
      definitionId: definition.id,
      fromVersion: 2,
      newVersion: 4,
    });
  });

  it("refuses a restore on a stale basis", async () => {
    const definition = await create();
    await save(definition.id, 1, shop(90));
    const res = await restore(definition.id, 1, 1);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res)).toBe("custom_api_definition_stale");
  });

  it("refuses restoring the current content", async () => {
    const definition = await create();
    await save(definition.id, 1, shop(90));
    await save(definition.id, 2, shop(60));
    const res = await restore(definition.id, 1, 3);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res)).toBe("custom_api_version_unchanged");
    expect((await restore(definition.id, 9, 3)).statusCode).toBe(404);
  });

  it("refuses restoring the current content stored at an older schema version (ADR 0030)", async () => {
    const definition = await create();
    await save(definition.id, 1, shop(90));
    await save(definition.id, 2, shop(60));
    // Version 3 as a version-1 server stored it.
    const [stored] = await t.admin<{ document: Doc }[]>`
      select document from custom_api_definition_versions
      where definition_id = ${definition.id} and version = 3`;
    const v1 = { ...stored!.document, schemaVersion: 1 };
    await t.admin`
      update custom_api_definition_versions
      set document = ${t.admin.json(v1 as never)},
          document_sha256 = ${canonicalSha256(v1)}, schema_version = 1
      where definition_id = ${definition.id} and version = 3`;
    const res = await restore(definition.id, 1, 3);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res)).toBe("custom_api_version_unchanged");
  });

  it("marks identical content stored at an older schema version as the same (#885)", async () => {
    const definition = await create();
    await save(definition.id, 1, shop(90));
    await save(definition.id, 2, shop(60));
    // Version 1 as a version-1 server stored it: another stored hash,
    // the same content as version 3.
    const [stored] = await t.admin<{ document: Doc }[]>`
      select document from custom_api_definition_versions
      where definition_id = ${definition.id} and version = 1`;
    const v1 = { ...stored!.document, schemaVersion: 1 };
    await t.admin`
      update custom_api_definition_versions
      set document = ${t.admin.json(v1 as never)},
          document_sha256 = ${canonicalSha256(v1)}, schema_version = 1
      where definition_id = ${definition.id} and version = 1`;
    // Version 4 differs; version 5 equals version 2 at today's schema.
    await save(definition.id, 3, shop(120));
    await save(definition.id, 4, shop(90));
    const page = await history(definition.id);
    expect(page.versions.map((v) => [v.version, v.sameAs])).toEqual([
      [5, 2],
      [4, null],
      [3, 1],
      [2, null],
      [1, null],
    ]);
  });

  it("looks back a bounded number of versions for the same content (#930 review)", async () => {
    const definition = await create();
    const back = CUSTOM_API_HISTORY_SAME_AS_LOOKBACK;
    // Versions 2 … back + 21 all differ; the last one equals version 1,
    // which lies beyond the lookback of the first page (oldest: 3).
    const newest = back + 22;
    for (let version = 1; version < newest - 1; version++)
      await save(definition.id, version, shop(1_000 + version));
    await save(definition.id, newest - 1, shop(60));
    const first = await history(definition.id);
    expect(first.versions[0]).toMatchObject({ version: newest, sameAs: null });
    expect(first.versions.at(-1)!.version).toBe(newest - 19);
    // The same content inside the lookback is found.
    await save(definition.id, newest, shop(1_000 + newest - 2));
    const again = await history(definition.id);
    expect(again.versions[0]).toMatchObject({
      version: newest + 1,
      sameAs: newest - 1,
    });
  }, 60_000);

  it("upgrades an older schema version while restoring", async () => {
    // Only schema version 1 exists: an older shape is a version-1
    // document stored without the keys today's schema defaults.
    const definition = await create();
    const minimal = shop() as Record<string, unknown>;
    delete minimal.defaults;
    await t.admin`
      update custom_api_definition_versions
      set document = ${t.admin.json(minimal as never)}
      where definition_id = ${definition.id} and version = 1`;
    await save(definition.id, 1, shop(90));
    const res = await restore(definition.id, 1, 2);
    expect(res.statusCode, res.body).toBe(201);
    const restored = customApiDefinitionResponseSchema.parse(res.json());
    expect(restored.definition.document.defaults).toEqual({
      refreshMinutes: 60,
      timeZone: "UTC",
    });
  });

  it("reads a stored version that a later rule rejects, and refuses restoring it", async () => {
    // Saved before secret variables could not be named like a credential
    // (#807): reading must not fail, restoring answers the issue.
    const definition = await create();
    await save(definition.id, 1, shop(90));
    const stricter = {
      ...shop(),
      variables: [
        { id: "account_id", label: "Account ID", secret: false },
        { id: "token", label: "Token", secret: true },
      ],
    };
    await t.admin`
      update custom_api_definition_versions
      set document = ${t.admin.json(stricter as never)}
      where definition_id = ${definition.id} and version = 1`;
    expect(
      (await t.call("GET", `${defs()}/${definition.id}/versions/1`, viewer))
        .statusCode,
    ).toBe(200);
    expect((await history(definition.id)).versions[1]!.summary.fields).toBe(4);
    const res = await restore(definition.id, 1, 2);
    expect(res.statusCode).toBe(400);
    const body = customApiErrorResponseSchema.parse(res.json());
    expect(body.error).toBe("custom_api_definition_invalid");
    expect(body.issues).toContainEqual(
      expect.objectContaining({ code: "variable_reserved" }),
    );
    // As the current version, the definition still reads.
    await t.admin`
      update custom_api_definition_versions
      set document = ${t.admin.json(stricter as never)}
      where definition_id = ${definition.id} and version = 2`;
    const got = await t.call("GET", `${defs()}/${definition.id}`, viewer);
    expect(got.statusCode, got.body).toBe(200);
    // Saving a fixed version from it works.
    await save(definition.id, 2, shop(30));
  });

  it("names a deleted author as unknown", async () => {
    const definition = await create();
    await t.admin`
      update custom_api_definition_versions set created_by = null
      where definition_id = ${definition.id}`;
    expect((await history(definition.id)).versions[0]!.author).toBeNull();
  });

  it("keeps another workspace's history private", async () => {
    const definition = await create();
    const res = await t.call(
      "GET",
      `${defs(strangerWorkspaceId)}/${definition.id}/versions`,
      stranger,
    );
    expect(res.statusCode).toBe(404);
    expect(
      (
        await t.call(
          "GET",
          `${defs(strangerWorkspaceId)}/${definition.id}/versions/1`,
          stranger,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await t.call("GET", `${defs()}/${definition.id}/versions`, stranger))
        .statusCode,
    ).toBe(404);
  });

  it("lets viewers read but not restore", async () => {
    const definition = await create();
    await save(definition.id, 1, shop(90));
    await history(definition.id, "", viewer);
    const res = await restore(definition.id, 1, 2, viewer);
    expect(res.statusCode).toBe(403);
  });
});
