import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { migrationsFolder } from "./index.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "./test-db.js";

// Migration 0098 (#921) on data in the 0097 shape: an API of the previous
// release saved a check URL with a fragment after 0097 ran. The migration
// cleans it, and from then on every write of an http-check connection is
// stripped by the database, whichever API version writes it.

const LAST_BEFORE = "0097_http_check_url_fragments";
const MIGRATION = "0098_http_check_url_fragments_guard";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

describe("migration 0098 on HTTP check URLs saved after 0097", () => {
  it("cleans them, strips every later write, and is idempotent", async () => {
    const owner = postgres(testDb.adminUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      const [workspace] = await owner`
        insert into workspaces (name) values ('W') returning id`;
      await owner`insert into connectors (id, version, manifest) values
        ('http-check', '0.1.0', ${owner.json({ id: "http-check" })}),
        ('other', '1.0.0', ${owner.json({ id: "other" })})`;
      const insert = async (connector: string, config: unknown) => {
        const [row] = await owner`
          insert into connections (workspace_id, connector_id, name, config)
          values (${workspace!.id}, ${connector}, 'c',
                  ${owner.json(config as never)})
          returning id`;
        return row!.id as string;
      };
      const configOf = async (id: string) => {
        const [row] =
          await owner`select config from connections where id = ${id}`;
        return row!.config as unknown;
      };
      // Saved by an API of the previous release after 0097 ran.
      const saved = await insert("http-check", {
        checks: [
          {
            name: "Callback",
            url: "https://a.example.com/cb#access_token=LATE-TOKEN",
            method: "GET",
          },
          { name: "Plain", url: "https://b.example.com/health?x=1" },
        ],
        resourceSelection: ["kept#as-is"],
      });
      const empty = await insert("http-check", { checks: [] });
      const odd = await insert("http-check", { checks: "not a list" });
      const other = await insert("other", {
        checks: [{ name: "x", url: "https://o.example/#keep" }],
      });

      await testDb.migrate();

      expect(await configOf(saved)).toEqual({
        checks: [
          { name: "Callback", url: "https://a.example.com/cb", method: "GET" },
          { name: "Plain", url: "https://b.example.com/health?x=1" },
        ],
        resourceSelection: ["kept#as-is"],
      });
      expect(await configOf(empty)).toEqual({ checks: [] });
      expect(await configOf(odd)).toEqual({ checks: "not a list" });
      expect(await configOf(other)).toEqual({
        checks: [{ name: "x", url: "https://o.example/#keep" }],
      });

      // Later writes of a previous-release API: an insert and an update.
      const inserted = await insert("http-check", {
        checks: [{ name: "New", url: "https://c.example.com/#top" }],
      });
      expect(await configOf(inserted)).toEqual({
        checks: [{ name: "New", url: "https://c.example.com/" }],
      });
      await owner`update connections
        set config = ${owner.json({
          checks: [{ name: "Edit", url: "https://d.example.com/p#LATER" }],
        })}
        where id = ${saved}`;
      expect(await configOf(saved)).toEqual({
        checks: [{ name: "Edit", url: "https://d.example.com/p" }],
      });
      // Another connector's configuration is never rewritten.
      await owner`update connections
        set config = ${owner.json({ url: "https://o.example/#still" })}
        where id = ${other}`;
      expect(await configOf(other)).toEqual({
        url: "https://o.example/#still",
      });
      const all = await owner`select config from connections`;
      expect(JSON.stringify(all)).not.toContain("TOKEN");
      expect(JSON.stringify(all)).not.toContain("LATER");

      const before =
        await owner`select id, config from connections order by id`;
      await owner.unsafe(
        readFileSync(path.join(migrationsFolder, `${MIGRATION}.sql`), "utf8"),
      );
      expect(
        await owner`select id, config from connections order by id`,
      ).toEqual(before);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
