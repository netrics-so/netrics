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

// Migration 0097 (#898) on HTTP check configurations in the previous
// shape: a stored check URL loses its fragment, nothing else changes.

const LAST_BEFORE = "0096_state_widget";
const MIGRATION = "0097_http_check_url_fragments";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

describe("migration 0097 on stored HTTP check URLs", () => {
  it("strips fragments from check URLs only, in order, and is idempotent", async () => {
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
      const withFragments = await insert("http-check", {
        checks: [
          {
            name: "Callback",
            url: "https://a.example.com/cb#access_token=OLD-TOKEN",
            method: "GET",
            timeoutSeconds: 10,
          },
          { name: "Plain", url: "https://b.example.com/health?x=1" },
          { name: "Empty", url: "https://c.example.com/#" },
          { name: "Top", url: "https://d.example.com/page#top" },
        ],
        resourceSelection: ["kept#as-is"],
      });
      const clean = { checks: [{ name: "Site", url: "https://e.example/" }] };
      const untouched = await insert("http-check", clean);
      const odd = await insert("http-check", { checks: "not a list" });
      const other = await insert("other", {
        checks: [{ name: "x", url: "https://o.example/#keep" }],
      });

      const configs = async () =>
        Object.fromEntries(
          (await owner`select id, config from connections order by id`).map(
            (row) => [row.id as string, row.config as unknown],
          ),
        );
      const before = await configs();

      await testDb.migrate();

      const after = await configs();
      expect(after[withFragments]).toEqual({
        checks: [
          {
            name: "Callback",
            url: "https://a.example.com/cb",
            method: "GET",
            timeoutSeconds: 10,
          },
          { name: "Plain", url: "https://b.example.com/health?x=1" },
          { name: "Empty", url: "https://c.example.com/" },
          { name: "Top", url: "https://d.example.com/page" },
        ],
        resourceSelection: ["kept#as-is"],
      });
      expect(JSON.stringify(after)).not.toContain("OLD-TOKEN");
      expect(after[untouched]).toEqual(clean);
      expect(after[odd]).toEqual(before[odd]);
      expect(after[other]).toEqual(before[other]);

      const statement = readFileSync(
        path.join(migrationsFolder, `${MIGRATION}.sql`),
        "utf8",
      );
      await owner.unsafe(statement);
      expect(await configs()).toEqual(after);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
