# Store template updates (milestone 11E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App Store / Google Play portfolio templates get versions; an install remembers its version, inputs and per-record originals, and a newer version is offered as a reviewable update that keeps the customer's own changes: data through draft → preview → publish, dashboards through an updated copy the customer swaps onto its screens.

**Architecture:** The store template becomes a versioned definition (`store-template.ts`) that builds every record of an install from stored inputs and a key → record-id map. A new table keeps, per install, which record each template key created and that record's original content; existing installs get a baseline in the migration. A pure three-way module compares original / customer current / new template per item (step, measure, dimension, widget, filter, slide, settings) and produces a plan; applying the plan writes ordinary data drafts through the existing data service, and, once those are published, builds an updated dashboard copy that the customer swaps onto the original's screens (the original is archived for rollback).

**Tech Stack:** TypeScript, Fastify, drizzle-orm + PostgreSQL (RLS), zod contracts + generated OpenAPI, Next.js web app, vitest.

**Spec:** `docs/milestones/11-completion-design.md`, section "Template updates (11E)", plus the anti-goals and constraints it lists. Where silent: `docs/milestones/11-projects-and-derived-metrics.md` and ADR 0022.

## Global Constraints

- Scope is the store portfolio template only: `apps/server/src/dashboards/store-template-service.ts` and `store-portfolio.ts`. The Studio templates in `templates.ts` get no versions and no updates.
- Updates are always offered, never applied silently. Nothing an update writes may change a published dashboard, a published definition or a paired screen before the customer publishes (data) or swaps (dashboards).
- Data changes (preparations, models, measures) arrive only as drafts through the existing draft → preview → publish flow (#475, #481). No new publish path.
- Widget changes create an updated copy of the dashboard, unassigned from screens, created only after the data drafts of that update are published. The swap moves the original's screens in one step; the original is archived, not deleted.
- Three states per item: original template, customer current, new template. Unchanged by customer → new template content; changed only by customer → kept; both changed → customer chooses per item. Removed template parts are proposed, never removed without the customer's choice.
- App scope (connections, app scope, every dataset reference derived from them) is never a conflict.
- Baseline for installs that exist when the migration runs: preparation and model originals are their first published version / release; a dashboard's original is its content at migration time.
- Roles: existing capabilities only. Read status: `dashboards:view`. Apply (drafts): `data:edit` and `dashboards:create`. Create copy: `dashboards:create`. Swap / swap back: `dashboards:update` and `devices:manage`.
- Tenant isolation twice: RLS (`app.workspace_id`) on every new table, and an explicit `workspace_id` predicate in every new query.
- Every new UI string in English and German (informal "du"), in the existing message catalogs.
- Definition of done from `CLAUDE.md`: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm openapi:check` after route/contract changes (`pnpm openapi` regenerates), migrations generated with `pnpm db:generate`, hand-edited where unsafe, and tried on data in the previous shape; one issue per PR with `Closes #N`.
- Migration numbers below (`0072_store_template_versions`, `0073_dashboard_archive`) are assumptions: the next free number at writing is `0071`, and the Projects plan (earlier in the build order) is expected to take it. Generate with `pnpm db:generate` and keep whatever index drizzle assigns; update `upTo` in the migration tests to the migration just before.

## Review Focus

1. **A customer has an unpublished draft of a template preparation or model when they apply an update.** Expected: the draft is the "customer current" state, so its edits are kept or offered as conflicts, never discarded. Test in Task 8 (`keeps an unpublished customer draft as the customer state`).
2. **The customer's dashboard changes between applying an update and creating the copy** (a widget the template changes is edited in Studio in between). Expected: copy creation refuses with `store_update_review_changed` and the plan, instead of using a stale decision. Test in Task 10.
3. **A screen with a fixed scope is swapped to a copy whose filters no longer support that scope** (the template removed or retyped a shared filter). Expected: the whole swap is refused with `device_scope_not_applicable` naming the screens; no screen moves. Test in Task 11.
4. **An install made before this change whose records were edited before the migration** (renamed dashboard, extra widget, edited measure in a later release). Expected: baseline originals are the first published version / release and the dashboard as it was at migration time; the edits show as customer changes (data) or as unchanged (dashboard), and nothing is lost. Test in Task 2 and Task 4.
5. **The same update applied twice or concurrently** (double click, two tabs). Expected: the second apply fails with `store_update_stale` (plan basis changed) and creates no second set of drafts. Test in Task 8.

---

## File Structure

Server (`apps/server/src/dashboards/`):

- `store-template.ts` (create): the versioned template definition: `STORE_TEMPLATE_VERSION`, input and key types, `storeTemplateKeys`, `buildStoreTemplateRecord`. Uses the builders in `store-portfolio.ts`.
- `store-portfolio.ts` (modify): `buildStoreDashboard` also returns a template key per widget.
- `store-template-items.ts` (create): pure normalization of preparation graphs, model definitions and dashboards into keyed items, with dataset references made symbolic.
- `store-template-merge.ts` (create): pure three-way classification, merge and summary.
- `store-template-legacy.ts` (create): completes a baseline install (inputs and keys) from its migrated originals.
- `store-template-updates.ts` (create): plan, apply, copy, swap and swap-back services (database work).
- `store-template-service.ts` (modify): install records version, inputs and originals.
- `service.ts` (modify): `createUpdatedDashboardCopy` beside `duplicate`; archived dashboards in `list`.

Elsewhere:

- `packages/database/src/schema.ts` (modify): `dataTemplateInstalls` columns, `dataTemplateRecords`, `dataTemplateUpdates`, `dashboards.archivedAt`.
- `packages/database/drizzle/0072_store_template_versions.sql`, `0073_dashboard_archive.sql` (generated, hand-edited).
- `packages/contracts/src/store-templates.ts` (modify): status, plan, apply, copy, swap schemas. `packages/contracts/src/index.ts`: `archivedAt` on dashboard list items and `dashboardSchema`.
- `apps/server/src/routes/store-templates.ts` (modify): new routes. `apps/server/src/devices/service.ts` (modify): export `validateScope`; refuse archived dashboards.
- Web: `apps/web/src/lib/api.ts` (client functions), `apps/web/src/app/workspaces/[workspaceId]/dashboards/stores/updates/[requestId]/page.tsx` + `store-update-review.tsx` (create), `dashboards-browser.tsx`, `components/data/data-workspace.tsx`, `components/studio-editor/studio-status.tsx` (badges), `messages/dashboards/{en,de}.ts`, `messages/data/{en,de}.ts`, `messages/api-errors/{en,de}.ts`.

## PR groups

| Group | Issue / PR title                                                        | Tasks | Depends on                                                     |
| ----- | ----------------------------------------------------------------------- | ----- | -------------------------------------------------------------- |
| A     | Store templates: versions, install inputs and originals (with baseline) | 1–4   | Projects group merged (migration order only)                   |
| B     | Store template updates: three-way plan and "update available" API       | 5–7   | A                                                              |
| C     | Apply a store template update as data drafts                            | 8     | B                                                              |
| D     | Dashboard archive, updated copy and swap onto screens                   | 9–11  | C                                                              |
| E     | Web: update available, review, apply and swap (en/de)                   | 12–14 | D; Projects web changes merged (same `dashboards-browser.tsx`) |
| F     | Change the apps of an installed store template                          | 15–16 | D (and E for the UI task)                                      |

The impact-before-publish endpoint is not required. If it is merged before Group E, Task 13 shows it per draft (optional step there).

---

## Group A — Store templates: versions, install inputs and originals

### Task 1: Versioned template definition

**Files:**

- Create: `apps/server/src/dashboards/store-template.ts`
- Modify: `apps/server/src/dashboards/store-portfolio.ts:449-554` (`buildStoreDashboard`)
- Modify: `apps/server/src/dashboards/store-template-service.ts:261-423` (install builds through the definition)
- Test: `apps/server/src/dashboards/store-template.test.ts` (create), `store-template-service.test.ts` (unchanged, must still pass)

**Interfaces:**

- Produces:

```ts
export const STORE_TEMPLATE_ID = "store_portfolio";
export const STORE_TEMPLATE_VERSION = 1;
export interface StoreTemplateInputs {
  name: string;
  locale: Locale;
  connections: {
    id: string;
    name: string;
    connectorId: StoreConnectorId;
    datasets: Record<string, string>;
  }[];
  /** The value buildStoreDashboard fixes the app filter to; null = all apps. */
  fixedProduct: string | null;
  /** Install-time product groups; seed for the mapping tables only, null for baseline installs. */
  groups: StoreTemplateRequest["groups"] | null;
}
export type StoreTemplateKey = string; // see key grammar below
export type StoreTemplateIds = Record<StoreTemplateKey, string> & {
  "dataset:mapping": string;
  "dataset:products": string;
};
export type StoreTemplateRecord =
  | {
      kind: "preparation";
      key: StoreTemplateKey;
      name: string;
      graph: PreparationGraph;
    }
  | {
      kind: "model";
      key: StoreTemplateKey;
      name: string;
      definition: SemanticModelDefinition;
    }
  | {
      kind: "dashboard";
      key: StoreTemplateKey;
      name: string;
      request: CreateDashboardRequest;
      widgetKeys: string[];
    };
export interface StoreTemplateDefinition {
  version: number;
  /** Record keys in creation (dependency) order. */
  keys(inputs: StoreTemplateInputs): StoreTemplateKey[];
  /** One record; `ids` holds every key created before it in `keys()` order. */
  build(
    key: StoreTemplateKey,
    inputs: StoreTemplateInputs,
    ids: StoreTemplateIds,
  ): StoreTemplateRecord;
}
export const storeTemplate: StoreTemplateDefinition;
```

- Key grammar (version 1): `preparation:source:<connectionId>:<metric>`, `preparation:append:<metric>:<round>:<index>` (the existing 80-per-graph combine tree, round 0 first), `model:<metric>`, `dashboard:portfolio`. Widget keys: `widget:downloads`, `widget:proceeds`, `widget:ratings`.
- `buildStoreDashboard(...)` additionally returns `widgetKeys: string[]` (reading order). Its `CreateDashboardRequest` output is byte-for-byte unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it("builds version 1 exactly as the install did before versions existed", () => {
  const ids = fakeIds(); // deterministic uuids per key
  const records = storeTemplate.keys(fixtureInputs).map((key) => {
    const record = storeTemplate.build(key, fixtureInputs, ids);
    ids[key] = ids[key] ?? uuidFor(key);
    return record;
  });
  expect(records.map((r) => r.key)).toEqual([
    `preparation:source:${apple.id}:downloads`,
    `preparation:source:${apple.id}:proceeds`,
    `preparation:source:${apple.id}:ratings`,
    `preparation:source:${google.id}:downloads`,
    `preparation:source:${google.id}:proceeds`,
    `preparation:source:${google.id}:ratings`,
    "preparation:append:downloads:0:0",
    "preparation:append:proceeds:0:0",
    "preparation:append:ratings:0:0",
    "model:downloads",
    "model:proceeds",
    "model:ratings",
    "dashboard:portfolio",
  ]);
  expect(sha256(JSON.stringify(records))).toBe(VERSION_1_HASH);
});
it("needs a version bump for any content change", () => {
  // VERSION_HASHES: Record<number, string>; the current version must have an entry.
  expect(VERSION_HASHES[STORE_TEMPLATE_VERSION]).toBe(
    sha256(JSON.stringify(buildAll(fixtureInputs))),
  );
});
it("keeps a single connection without an append preparation", () => {
  expect(
    storeTemplate.keys({ ...fixtureInputs, connections: [appleSource] }),
  ).not.toContain("preparation:append:downloads:0:0");
});
```

`VERSION_1_HASH` is computed once from today's builders (run the test, copy the hash in the same commit) and documented in the test as "changing template content requires a new version and a new hash".

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/server/src/dashboards/store-template.test.ts`
Expected: FAIL, module `./store-template.js` not found.

- [ ] **Step 3: Implement `storeTemplate` and switch `install` to it**

`install` loops `storeTemplate.keys(inputs)`, builds each record with the ids created so far, saves and publishes it exactly as today (`publish` / `saveModel` + `publishModel` / dashboard `create`), and records `ids[key]`. Result shape, record names, audit event and idempotency hash stay as they are.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/server/src/dashboards/store-template.test.ts apps/server/src/dashboards/store-template-service.test.ts apps/server/src/dashboards/store-portfolio.test.ts`
Expected: PASS (existing install tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/dashboards/store-template.ts apps/server/src/dashboards/store-template.test.ts apps/server/src/dashboards/store-portfolio.ts apps/server/src/dashboards/store-template-service.ts
git commit -m "refactor(templates): build the store template from a versioned definition"
```

### Task 2: Schema and migration with baseline for existing installs

**Files:**

- Modify: `packages/database/src/schema.ts:2084-2109` (`dataTemplateInstalls`), add `dataTemplateRecords`, `dataTemplateUpdates`
- Create: `packages/database/drizzle/0072_store_template_versions.sql` (via `pnpm db:generate`, then hand-edit)
- Test: `apps/server/src/store-template-versions-migration.test.ts` (create; in the server package because the fixture uses the pure builders from `store-portfolio.ts`)

**Interfaces:**

- Produces (drizzle):
  - `dataTemplateInstalls` gains `templateId text not null default 'store_portfolio'`, `templateVersion integer not null default 1` (check `> 0`), `inputs jsonb` (null = baseline install not yet completed), `updatedAt timestamptz not null default now()`.
  - `dataTemplateRecords` (`data_template_records`): `workspaceId`, `requestId`, `key text`, `kind text` (check in `'preparation','model','dashboard','dataset'`), `recordId uuid not null`, `templateVersion integer not null`, `original jsonb` (null only for `dataset`), `widgetKeys jsonb` (dashboards: `Record<widgetId, widgetKey>`; else null), `detachedAt timestamptz`. PK `(workspace_id, request_id, key)`; FK `(workspace_id, request_id)` → `data_template_installs` on delete cascade; index `(workspace_id, record_id)`.
  - `dataTemplateUpdates` (`data_template_updates`): `id uuid pk default random`, `workspaceId`, `requestId`, `fromVersion`, `toVersion`, `decisions jsonb not null`, `drafts jsonb not null` (`{ key, kind, recordId, version }[]`), `dashboards jsonb not null` (`{ key, originalId, copyId: string|null, swappedAt: string|null, swappedBackAt: string|null }[]`), `createdBy uuid`, `createdAt`, `closedAt timestamptz`. FK to installs cascade; unique partial index `(workspace_id, request_id) where closed_at is null` (one open update per install).
- Hand-edits in the SQL, after the generated DDL: `ENABLE` + `FORCE ROW LEVEL SECURITY`, a `<table>_tenant` policy identical to `data_template_installs_tenant` (0057), `GRANT SELECT, INSERT, UPDATE, DELETE ... TO netrics_app` on both new tables and `GRANT UPDATE ON data_template_installs` (0057 granted only SELECT, INSERT, DELETE). Then the baseline backfill between `SET LOCAL row_security = off;` and `SET LOCAL row_security = on;` (precedent: `0033_dashboard_studio.sql`).
- Baseline backfill rules (pure SQL, every install row):
  - preparations: for each id in `result->'preparationIds'` that still exists in the same workspace, key `'legacy:' || id`, kind `preparation`, `template_version = 1`, `original = jsonb_build_object('graph', v.graph)` from the lowest `version` in `data_preparation_versions` for that preparation.
  - models: for each `(metric, id)` in `result->'models'`, key `'model:' || metric`, `original = jsonb_build_object('definition', r.definition)` from the lowest-version row in `data_model_releases`.
  - dashboard: if `result->>'dashboardId'` still exists, key `dashboard:portfolio`, `original = jsonb_build_object('legacySnapshot', jsonb_build_object('dashboard', to_jsonb(d), 'slides', <slides ordered by position, each with its widgets as to_jsonb rows>))`, `widget_keys = null` (assigned in Task 4).
  - datasets: keys `dataset:mapping`, `dataset:products` from `result`, `original = null`.
  - A closing `DO $$ ... RAISE EXCEPTION` check that every install got a `model:%` row per model id that still exists (pattern from 0033).

- [ ] **Step 1: Write the failing migration test**

`beforeAll`: `createTestDatabase({ upTo: "0070_prune_revoked_devices" })` (or the migration just before this one), then insert through `owner` (raw SQL; the drizzle schema is newer) one workspace with a baseline install: two connections, 9 preparations with a version-1 row (graphs from `buildStorePreparation` / `buildStoreAppend`) and a version-2 row (a customer edit published later), 3 models with releases v1 and v2, a dashboard with one slide and four widgets (the three template widgets plus one customer widget) from `buildStoreDashboard`, renamed `'Customer name'`, and the `data_template_installs` row with the matching `result`. A second workspace with its own install. `vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS })`.

```ts
it("gives existing installs version 1 with first-published originals and the dashboard as it is now", async () => {
  await test.migrate();
  const [install] =
    await owner`select template_version, inputs from data_template_installs where workspace_id=${workspaceId}`;
  expect(install).toEqual({ template_version: 1, inputs: null });
  const records =
    await owner`select key, kind, record_id, original from data_template_records where workspace_id=${workspaceId} order by key`;
  expect(records).toHaveLength(9 + 3 + 1 + 2);
  expect(
    records.find((r) => r.key === "model:proceeds")!.original.definition,
  ).toEqual(modelV1.proceeds);
  expect(
    records.find((r) => r.key === `legacy:${prepIds[0]}`)!.original.graph,
  ).toEqual(prepV1[0]);
  const snapshot = records.find((r) => r.key === "dashboard:portfolio")!
    .original.legacySnapshot;
  expect(snapshot.dashboard.name).toBe("Customer name");
  expect(snapshot.slides[0].widgets).toHaveLength(4);
});
it("keeps the records of each workspace private under the app role", async () => {
  const db = createDatabase(test.appUrl);
  const rows = await withWorkspace(db, { workspaceId: otherId }, (tx) =>
    tx.select().from(schema.dataTemplateRecords),
  );
  expect(rows.every((row) => row.workspaceId === otherId)).toBe(true);
  expect(rows.length).toBeGreaterThan(0);
});
it("skips records deleted before the migration without failing", async () => {
  /* dashboard deleted before migrate → no dashboard row, models still present */
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/server/src/store-template-versions-migration.test.ts`
Expected: FAIL (`column "template_version" does not exist`).

- [ ] **Step 3: Change `schema.ts`, run `pnpm db:generate`, hand-edit the SQL as listed above**

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/server/src/store-template-versions-migration.test.ts apps/server/src/dashboards/store-template-service.test.ts packages/database/src/tenancy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/schema.ts packages/database/drizzle apps/server/src/store-template-versions-migration.test.ts
git commit -m "feat(database): store template versions, install records and a baseline for existing installs"
```

### Task 3: Install records version, inputs and originals

**Files:**

- Modify: `apps/server/src/dashboards/store-template-service.ts`
- Test: `apps/server/src/dashboards/store-template-service.test.ts` (move `upTo` to the new migration's predecessor only if needed; the suite already migrates fully)

**Interfaces:**

- Consumes: `storeTemplate`, `StoreTemplateInputs` (Task 1); tables (Task 2).
- Produces: after `install`, `data_template_installs.inputs` holds `StoreTemplateInputs` (zod: `storeTemplateInputsSchema` exported from `store-template.ts`), `template_version = STORE_TEMPLATE_VERSION`, and one `data_template_records` row per key with `original` = the built record's content (`{ graph }`, `{ definition }`, or `{ request }` for the dashboard) and `widget_keys` mapping each created widget id to its widget key (widgets are created in `widgetKeys` order; read them back in slide/position order).
- `createStoreTemplateService` gains an optional `template?: StoreTemplateDefinition` dependency (default `storeTemplate`) so tests can install an older or newer fixture version.

- [ ] **Step 1: Write the failing test** (in the existing describe, after the first install)

```ts
it("records the version, the inputs and each record's original", async () => {
  const [row] =
    await owner`select template_version, inputs from data_template_installs where workspace_id=${workspaceId} and request_id=${requestId}`;
  expect(row!.template_version).toBe(STORE_TEMPLATE_VERSION);
  expect(row!.inputs).toMatchObject({
    name: "App portfolio",
    locale: "en",
    fixedProduct: null,
    connections: [{ id: apple.id }, { id: google.id }],
  });
  const records =
    await owner`select key, record_id, original, widget_keys from data_template_records where workspace_id=${workspaceId} order by key`;
  expect(records.map((r) => r.key)).toContain(
    `preparation:source:${apple.id}:downloads`,
  );
  expect(records.find((r) => r.key === "model:downloads")!.record_id).toBe(
    installed.models.downloads,
  );
  expect(
    Object.values(
      records.find((r) => r.key === "dashboard:portfolio")!.widget_keys,
    ).sort(),
  ).toEqual(["widget:downloads", "widget:proceeds", "widget:ratings"]);
});
```

Also extend "rolls back every new record after a policy failure" with `data_template_records` in its table list (count 0).

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run apps/server/src/dashboards/store-template-service.test.ts` → FAIL on `inputs` null.
- [ ] **Step 3: Implement** the inserts in the install transaction, after the dashboard is created and before the audit event.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `feat(templates): store-template installs record version, inputs and originals`

### Task 4: Complete baseline installs

**Files:**

- Create: `apps/server/src/dashboards/store-template-legacy.ts`
- Test: `apps/server/src/dashboards/store-template-legacy.test.ts` (pure, fixtures from builders) and a case in `store-template-versions-migration.test.ts` (after migrate)

**Interfaces:**

- Produces:

```ts
export type LegacyCompletion =
  | {
      ok: true;
      inputs: StoreTemplateInputs;
      keys: Record<string /* legacy:<id> */, StoreTemplateKey>;
      widgetKeys: Record<string, string>;
    }
  | { ok: false; code: "store_template_baseline_unavailable" };
export function completeLegacyInstall(input: {
  result: StoreTemplateResult;
  preparations: { id: string; graph: PreparationGraph }[]; // originals from records
  models: Record<StoreMetric, SemanticModelDefinition>; // originals from records
  snapshot: LegacyDashboardSnapshot | null;
  connections: {
    id: string;
    name: string;
    connectorId: StoreConnectorId;
    datasets: Record<string, string>;
  }[];
}): LegacyCompletion;
/** Runs completeLegacyInstall in tx and writes inputs, keys and widget keys; no-op when inputs is set. */
export async function ensureInstallCompleted(
  tx: Transaction,
  workspaceId: string,
  requestId: string,
): Promise<LegacyCompletion>;
```

- Rules (do not depend on the current template version, so they keep working after version 2 ships):
  - connections: distinct `X` of `resources:X` source nodes, sorted; names/datasets from the connections table and `registerSourceDataset` ids found in the `raw` source nodes.
  - per-source key: metric from the `output` select fields (`downloads` → downloads, `amount` → proceeds, `rating` → ratings).
  - append key: metric of its inputs; `round` = depth in the combine tree; `index` = order within `result.preparationIds`.
  - locale: `de` when the downloads model's measure name equals the frozen v1 string `"Downloads und Nutzerinstallationen"`, else `en` (constant copied into this file, not imported).
  - name: snapshot dashboard name; `fixedProduct`: snapshot `data_filters` app filter `fixedValue.values[0]` or null; `groups: null`.
  - widget keys: the first measure widget (slide position, then y, x) whose `model_binding.modelId` is `models[metric]` → `widget:<metric>`; all other widgets unkeyed (customer widgets).
  - The legacy dashboard original is rewritten from `legacySnapshot` to the normalized form of Task 5 (`{ normalized }`).
  - Any rule that cannot be satisfied → `{ ok: false }`; the install then reports `store_template_baseline_unavailable` and offers no update.

- [ ] **Step 1: Write failing tests**

```ts
it("reconstructs inputs and keys of a two-store German install", () => {
  const done = completeLegacyInstall(germanFixture);
  expect(done).toMatchObject({
    ok: true,
    inputs: {
      locale: "de",
      fixedProduct: null,
      connections: [{ id: apple.id }, { id: google.id }],
    },
  });
  expect(Object.values(done.ok ? done.keys : {})).toContain(
    "preparation:append:ratings:0:0",
  );
  expect(Object.values(done.ok ? done.widgetKeys : {}).sort()).toEqual([
    "widget:downloads",
    "widget:proceeds",
    "widget:ratings",
  ]);
});
it("refuses an install whose preparations no longer read as the template", () => {
  expect(completeLegacyInstall({ ...germanFixture, preparations: [] })).toEqual(
    { ok: false, code: "store_template_baseline_unavailable" },
  );
});
it("completes a migrated install once and keeps the customer widget unkeyed", async () => {
  /* migration test: ensureInstallCompleted twice → same rows; 4th widget not in widget_keys */
});
```

- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/dashboards/store-template-legacy.test.ts apps/server/src/store-template-versions-migration.test.ts` → FAIL.
- [ ] **Step 3: Implement** both functions; `ensureInstallCompleted` updates the record keys (`legacy:<id>` → structural key) and `inputs` in one statement set, with `workspace_id` predicates.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(templates): complete store-template installs made before versions`

---

## Group B — Three-way plan and "update available" API

### Task 5: Items with symbolic references

**Files:**

- Create: `apps/server/src/dashboards/store-template-items.ts`
- Test: `apps/server/src/dashboards/store-template-items.test.ts`

**Interfaces:**

- Produces:

```ts
export type ItemKind =
  | "step"
  | "output"
  | "measure"
  | "dimension"
  | "relationship"
  | "widget"
  | "filter"
  | "slide"
  | "settings";
export type ItemRef = `${StoreTemplateKey}#${ItemKind}:${string}`;
export type Items = Map<ItemRef, unknown>; // value: canonical JSON (sorted keys)
/** prepared:<id>:<out>, dataset ids and model ids become ref:<key>[:<out>] using the install's key↔id map. */
export function symbolize(
  value: unknown,
  idsToKeys: Map<string, string>,
): unknown;
export function preparationItems(
  key: StoreTemplateKey,
  graph: PreparationGraph,
  idsToKeys: Map<string, string>,
): Items; // step:<node.id>, output:<index>
export function modelItems(
  key: StoreTemplateKey,
  def: SemanticModelDefinition,
  idsToKeys: Map<string, string>,
): Items; // measure:<id>, dimension:<id>, relationship:<index>; `datasets` is scope (see below)
export interface NormalizedDashboard {
  settings: unknown;
  filters: Record<string, unknown>;
  slides: Record<string, unknown>;
  widgets: Record<string, { slide: string; value: unknown }>;
}
export function normalizeDashboard(
  view: Dashboard,
  widgetKeys: Record<string, string>,
  idsToKeys: Map<string, string>,
): NormalizedDashboard; // unkeyed widgets → custom:<widgetId>; slides → slide:<position>
export function normalizeTemplateDashboard(
  request: CreateDashboardRequest,
  widgetKeys: string[],
  idsToKeys: Map<string, string>,
): NormalizedDashboard;
export function dashboardItems(
  key: StoreTemplateKey,
  d: NormalizedDashboard,
): Items;
/** App-scope parts (Global Constraints): never conflicts, always the new template's value. */
export function isScopeItem(ref: ItemRef): boolean;
```

- Scope items: whole `preparation:append:*` records, the existence of `preparation:source:<connectionId>:*` records, model `datasets`, the `fixedValue` inside `filter:app` (split into its own ref `…#filter:app.fixedValue`). Dataset and record ids never appear in item values (symbolized), so id differences can never be changes.
- Widget values exclude ids and per-format layouts; settings exclude `name`, `projectId`, `version`, timestamps. Record names are never items (they are the customer's).

- [ ] **Step 1: Failing tests**: `"turns record ids into template keys so two installs compare equal"` (two installs built with different ids → equal `Items`); `"keys customer widgets by id and template widgets by key"`; `"splits the app filter's fixed value into a scope item"` (`isScopeItem("dashboard:portfolio#filter:app.fixedValue")` true, `isScopeItem("model:downloads#measure:downloads")` false).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/dashboards/store-template-items.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(templates): normalize store-template records into comparable items`

### Task 6: Three-way classification, merge and summary

**Files:**

- Create: `apps/server/src/dashboards/store-template-merge.ts`
- Test: `apps/server/src/dashboards/store-template-merge.test.ts`

**Interfaces:**

- Consumes: `Items`, `ItemRef`, `isScopeItem` (Task 5).
- Produces:

```ts
export type Outcome =
  | "unchanged"
  | "template"
  | "customer"
  | "choose"
  | "propose_removal"
  | "scope";
export interface PlanItem {
  ref: ItemRef;
  change: "added" | "changed" | "removed";
  outcome: Outcome;
  original?: unknown;
  current?: unknown;
  next?: unknown;
}
export function classify(
  original: Items,
  current: Items,
  next: Items,
): PlanItem[]; // omits "unchanged"
export type Decision = {
  ref: ItemRef;
  choice: "template" | "customer" | "remove" | "keep";
};
/** Merged items; throws MergeDecisionMissing(refs) when a choose / propose_removal item has no decision. */
export function merge(
  original: Items,
  current: Items,
  next: Items,
  decisions: Decision[],
): Items;
export interface UpdateSummary {
  measures: Counts;
  steps: Counts;
  widgets: Counts;
  conflicts: number;
  removals: number;
}
export type Counts = { added: number; changed: number; removed: number };
export function summarize(
  original: Items,
  next: Items,
  plan: PlanItem[],
): UpdateSummary; // template changes, not customer edits
```

- Rules (table the tests pin):

| original | current | next               | outcome                                               |
| -------- | ------- | ------------------ | ----------------------------------------------------- |
| a        | a       | b                  | `template`                                            |
| a        | c       | a                  | `customer` (not listed in the plan's conflicts)       |
| a        | c       | b (c ≠ b)          | `choose`                                              |
| a        | c       | c                  | `unchanged`                                           |
| —        | —       | b                  | `template` (added)                                    |
| —        | c       | —                  | `customer` (customer-added, kept)                     |
| a        | a       | —                  | `propose_removal`                                     |
| a        | c       | —                  | `choose` (customer changed what the template removes) |
| a        | —       | b                  | `choose` (customer removed what the template changed) |
| a        | —       | a or —             | `unchanged`                                           |
| any      | any     | any, `isScopeItem` | `scope` (next value, never a conflict)                |

- `merge` result per outcome: `template`/`scope` → next; `customer` → current; `choose` → next for `template`, current for `customer`; `propose_removal` → removed for `remove`, current for `keep`.

- [ ] **Step 1: Failing tests**: one `it.each` over the table above; `"refuses to merge with an undecided conflict"` (`expect(() => merge(o, c, n, [])).toThrow(MergeDecisionMissing)`); `"never removes an item without a decision"`; `"counts added, changed and removed measures, steps and widgets of the template"`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/dashboards/store-template-merge.test.ts` → FAIL.
- [ ] **Step 3: Implement** (deep equality on canonical JSON).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(templates): three-way store-template comparison`

### Task 7: Status and plan endpoints

**Files:**

- Create: `apps/server/src/dashboards/store-template-updates.ts` (plan part)
- Modify: `packages/contracts/src/store-templates.ts`, `apps/server/src/routes/store-templates.ts`, `packages/contracts/openapi.json` (regenerated)
- Test: `apps/server/src/dashboards/store-template-updates.test.ts` (create), `apps/server/src/cross-workspace.test.ts` (add cases)

**Interfaces:**

- Consumes: Tasks 1–6.
- Produces (contracts):

```ts
export const storeTemplateUpdateSummarySchema; // UpdateSummary
export const storeTemplateInstallListSchema = z.object({
  installs: z.array(
    z.object({
      requestId: z.uuid(),
      name: z.string(),
      templateVersion: z.number().int(),
      latestVersion: z.number().int(),
      updateAvailable: z.boolean(),
      summary: storeTemplateUpdateSummarySchema.nullable(),
      error: z.enum(["store_template_baseline_unavailable"]).nullable(),
      dashboardIds: z.array(z.uuid()),
      modelIds: z.array(z.uuid()),
      preparationIds: z.array(z.uuid()),
      openUpdate: storeTemplateUpdateSchema.nullable(), // defined in Task 8
    }),
  ),
});
export const storeTemplatePlanSchema = z.object({
  requestId: z.uuid(),
  fromVersion: z.number().int(),
  toVersion: z.number().int(),
  basis: z.string().regex(/^[0-9a-f]{64}$/),
  summary: storeTemplateUpdateSummarySchema,
  records: z.array(
    z.object({
      key: z.string(),
      kind: z.enum(["preparation", "model", "dashboard"]),
      recordId: z.uuid().nullable(),
      name: z.string(),
      hasUnpublishedDraft: z.boolean(),
      items: z.array(
        z.object({
          ref: z.string(),
          change: z.enum(["added", "changed", "removed"]),
          outcome: z.enum([
            "template",
            "customer",
            "choose",
            "propose_removal",
            "scope",
          ]),
          original: z.unknown().optional(),
          current: z.unknown().optional(),
          next: z.unknown().optional(),
        }),
      ),
    }),
  ),
});
```

- Service:

```ts
export function createStoreTemplateUpdateService(deps: {
  db: Database;
  registry: ConnectorRegistry;
  now?: () => Date;
  template?: StoreTemplateDefinition;
});
// .list(actor): StoreTemplateInstallList   .plan(actor, requestId): StoreTemplatePlan
```

- Plan: `ensureInstallCompleted`; per record, original = stored original, current = the row now (`data_preparations.graph` / `data_models.definition`, i.e. the draft when one exists; dashboard via `findDashboard` + `normalizeDashboard`), next = `template.build(key, inputs, ids)`; new keys get placeholder ids `new:<key>`. Detached records are skipped. `basis` = sha256 of `toVersion` + every record's `(key, recordId, version)` (dashboards: `dashboards.version`). `updateAvailable` = `templateVersion < template.version` or any record's `templateVersion` below it.
- Routes (all under `/v1/workspaces/:workspaceId/dashboard-templates/stores`): `GET /installs` (`dashboards:view`), `GET /installs/:requestId/update` (`data:edit`; 404 `store_template_not_found`, 409 `store_template_up_to_date`). `cache-control: no-store`. Errors through `sendError` like the existing routes.

- [ ] **Step 1: Failing tests** (service test installs with a `v1` fixture definition and reads the plan with a `v2` fixture that changes the `downloads` measure name, adds a measure `downloads_avg`, changes step `calculate_store_name`, removes `widget:ratings` and adds `widget:summary`):

```ts
it("reports an update with a summary of the template's changes", async () => {
  const { installs } = await updates(v2).list(actor());
  expect(installs[0]).toMatchObject({
    templateVersion: 1,
    latestVersion: 2,
    updateAvailable: true,
    summary: {
      measures: { added: 1, changed: 1, removed: 0 },
      widgets: { added: 1, changed: 0, removed: 1 },
    },
  });
});
it("lists customer-only changes as kept and both-changed items as choices", async () => {
  // customer renames measure downloads (draft) and edits step calculate_store_name and publishes
  const plan = await updates(v2).plan(actor(), requestId);
  expect(item(plan, "model:downloads#measure:downloads").outcome).toBe(
    "choose",
  );
  expect(item(plan, "dashboard:portfolio#widget:ratings").outcome).toBe(
    "propose_removal",
  );
});
it("never reports app-scope differences as conflicts", async () => {
  /* two installs, different connections → plans contain no 'choose' on scope refs */
});
it("says up to date when the install has the latest version", async () => {
  await expect(updates(v1).plan(actor(), requestId)).rejects.toThrow(
    "store_template_up_to_date",
  );
});
```

Route tests in the same file via `app.inject`: a viewer gets the list but 403 on the plan; a member of another workspace gets 404 `store_template_not_found` for a real `requestId` (also added to `cross-workspace.test.ts` "no sub-resource existence oracle").

- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/dashboards/store-template-updates.test.ts apps/server/src/cross-workspace.test.ts` → FAIL.
- [ ] **Step 3: Implement** service, contracts, routes; `pnpm openapi`.
- [ ] **Step 4: Run** the tests, then `pnpm openapi:check` → PASS.
- [ ] **Step 5: Commit** `feat(templates): report store-template updates with a three-way plan`

---

## Group C — Apply an update as data drafts

### Task 8: Apply endpoint

**Files:**

- Modify: `apps/server/src/dashboards/store-template-updates.ts`, `packages/contracts/src/store-templates.ts`, `apps/server/src/routes/store-templates.ts`, `packages/contracts/openapi.json`
- Test: `apps/server/src/dashboards/store-template-updates.test.ts`

**Interfaces:**

- Consumes: `merge`, `classify` (Task 6), `createDataService(tx, …)` `savePreparation` / `saveModel` (`apps/server/src/data/service.ts:1772`, `:2075`).
- Produces:

```ts
export const storeTemplateApplyRequestSchema = z.strictObject({
  basis: z.string(),
  decisions: z.array(
    z.strictObject({
      ref: z.string(),
      choice: z.enum(["template", "customer", "remove", "keep"]),
    }),
  ),
});
export const storeTemplateUpdateSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  fromVersion: z.number().int(),
  toVersion: z.number().int(),
  createdAt: z.iso.datetime(),
  drafts: z.array(
    z.object({
      key: z.string(),
      kind: z.enum(["preparation", "model"]),
      recordId: z.uuid(),
      name: z.string(),
      version: z.number().int(),
      published: z.boolean(),
    }),
  ),
  dashboards: z.array(
    z.object({
      key: z.string(),
      originalId: z.uuid(),
      copyId: z.uuid().nullable(),
      swappedAt: z.iso.datetime().nullable(),
      swappedBackAt: z.iso.datetime().nullable(),
      ready: z.boolean(),
    }),
  ),
});
// service: .apply(actor, requestId, body): StoreTemplateUpdate
```

- Route: `POST /installs/:requestId/update` (`data:edit` and `dashboards:create`). Errors: 409 `store_update_stale` (basis differs), 400 `store_update_decision_missing` (body lists `refs`), 409 `store_template_up_to_date`.
- Behaviour, one serializable transaction with the install's retry loop (`store-template-service.ts:173-470`) and the same advisory lock key:
  - recompute the plan; reject when `basis` differs;
  - for each preparation/model record with a non-scope change: build the merged graph/definition from merged items (unsymbolize refs back to ids) and `savePreparation` / `saveModel` with `id` and the current `version` → a draft (`publishedVersion` untouched). New template records are created the same way (unpublished) in `keys()` order; new ids replace `new:<key>` placeholders before dependants are built;
  - records whose whole key disappears from the template: `remove` → `detached_at = now` (the record stays; nothing is deleted, there is no delete path for preparations or models), `keep` → kept and detached too, so the template stops tracking it;
  - update `original` and `template_version` of every data record to the new template content; `data_template_installs.template_version = toVersion`;
  - dashboards: no write; store their decisions and an entry `{ key, originalId, copyId: null }` for each dashboard record with a non-unchanged item;
  - close any earlier open update of the install (`closed_at`), insert the update row, audit `data.store_template_update_applied` with `{ requestId, fromVersion, toVersion }`.
- `published` per draft = `publishedVersion >= version` of the row now; `ready` per dashboard = all drafts published and `copyId` null.

- [ ] **Step 1: Failing tests**

```ts
it("writes drafts only: dashboards and published queries stay as they were", async () => {
  const before = await readDashboardData(installed.dashboardId);
  const update = await updates(v2).apply(actor(), requestId, {
    basis: plan.basis,
    decisions: choices(plan, "template"),
  });
  expect(update.drafts.every((d) => !d.published)).toBe(true);
  expect(await readDashboardData(installed.dashboardId)).toEqual(before);
  const model = (await data.getModel(actor(), installed.models.downloads))
    .model;
  expect(model.version).toBeGreaterThan(model.publishedVersion!);
});
it("keeps a customer-only measure and step change in the draft", async () => {
  /* customer added measure 'custom_total' → present in draft definition */
});
it("keeps an unpublished customer draft as the customer state", async () => {
  /* draft edit before apply → still in the new draft */
});
it("applies the customer's choice per conflicting item", async () => {
  /* choose 'customer' for model:downloads#measure:downloads → name stays the customer's */
});
it("refuses undecided conflicts and stale plans", async () => {
  await expect(
    updates(v2).apply(actor(), requestId, { basis: plan.basis, decisions: [] }),
  ).rejects.toThrow("store_update_decision_missing");
  await updates(v2).apply(actor(), requestId, full);
  await expect(updates(v2).apply(actor(), requestId, full)).rejects.toThrow(
    "store_update_stale",
  );
});
it("publishes the drafts through the normal flow and marks the dashboard copy ready", async () => {
  for (const d of update.drafts) await publish(d);
  expect(
    (await updates(v2).list(actor())).installs[0]!.openUpdate!.dashboards[0]!
      .ready,
  ).toBe(true);
});
```

Route: `data:preview`-only role → 403; other workspace → 404.

- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/dashboards/store-template-updates.test.ts` → FAIL.
- [ ] **Step 3: Implement**; `pnpm openapi`.
- [ ] **Step 4: Run** the tests and `pnpm openapi:check` → PASS.
- [ ] **Step 5: Commit** `feat(templates): apply a store-template update as data drafts`

---

## Group D — Dashboard archive, updated copy and swap

### Task 9: Archived dashboards (minimal)

Dashboards have no archive state today (no `archived` column or code path). This task defines the minimum the swap needs. It is separate from the Projects plan's `projects.archived_at`; flag to that plan's owner that dashboards gain `archived_at` too.

**Files:**

- Modify: `packages/database/src/schema.ts:847-942` (`dashboards.archivedAt timestamptz`, nullable, no index), `packages/database/src/dashboards.ts` (`listDashboards` returns it), `apps/server/src/dashboards/service.ts` (`list` presents `archivedAt`), `packages/contracts/src/index.ts:2398` and `:2424` (`archivedAt: z.iso.datetime().nullable()`), `apps/server/src/devices/service.ts:809-890`
- Create: `packages/database/drizzle/0073_dashboard_archive.sql` (generated; no backfill: existing rows null)
- Test: `apps/server/src/dashboards.test.ts`, `apps/server/src/devices.test.ts`, `packages/database/src/dashboard-archive-migration.test.ts` (create; `upTo` the previous migration, insert a dashboard, migrate, `archived_at` is null)

**Interfaces:**

- Produces: `archivedAt` on dashboard views and list items; device assignment of an archived dashboard → 409 `dashboard_archived`; the device payload of a screen still on an archived dashboard keeps working (only swap-back or deletion change it). Archiving and unarchiving happen only through swap / swap-back (Task 11); no separate endpoint.

- [ ] **Step 1: Failing tests**: `"lists archived dashboards with archivedAt"`; `"refuses to assign an archived dashboard to a screen"` (`PATCH /devices/:id { dashboardId: archived }` → 409 `dashboard_archived`); migration test as above.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/dashboards.test.ts apps/server/src/devices.test.ts packages/database/src/dashboard-archive-migration.test.ts` → FAIL.
- [ ] **Step 3: Implement**; `pnpm db:generate`; `pnpm openapi`.
- [ ] **Step 4: Run** tests and `pnpm openapi:check` → PASS.
- [ ] **Step 5: Commit** `feat(dashboards): archived state for dashboards replaced by an update`

### Task 10: Create the updated dashboard copy

**Files:**

- Modify: `apps/server/src/dashboards/service.ts` (export `createUpdatedDashboardCopy` next to `duplicate`, `:1604`), `apps/server/src/dashboards/store-template-updates.ts`, `apps/server/src/routes/store-templates.ts`, `packages/contracts/src/store-templates.ts`, `openapi.json`
- Test: `apps/server/src/dashboards/store-template-updates.test.ts`

**Interfaces:**

- Produces:

```ts
export async function createUpdatedDashboardCopy(
  tx: Transaction,
  actor: Actor,
  input: {
    sourceId: string;
    name: string;
    merged: NormalizedDashboard; // merged items, refs unsymbolized
  },
): Promise<
  Result<{ dashboard: DashboardView; widgetKeys: Record<string, string> }>
>;
// update service: .createCopy(actor, updateId, key): StoreTemplateUpdate
```

- Route: `POST /updates/:updateId/dashboards/:key/copy` (`dashboards:create`). Errors: 409 `store_update_drafts_unpublished` (any draft of the update with `publishedVersion < version`), 409 `store_update_review_changed` (recomputed dashboard items contain a `choose` / `propose_removal` without a stored decision; response carries the fresh plan records for that dashboard), 409 `store_update_copy_exists`.
- Copy content: starts from the customer's current dashboard exactly as `duplicate` does (theme, accent, logo, project, primary format, slide backgrounds, customer widgets, custom layouts via `copyLayouts`), then applies the merged items: changed template widgets take the merged value (their custom per-format layouts are dropped, so those formats fall back to auto), added template widgets go on their template slide (`slide:<position>`, created if missing), removed ones are left out, filters and settings take merged values. Name: `storeTemplateCopy(locale).updatedName(currentName)` = `"<name> (updated)"` / `"<name> (aktualisiert)"`, sliced to 100. Bindings are validated by the normal `validateDataBindings` against published models, so a copy can never bind an unpublished measure. No device is touched. Audit `dashboard.template_copy_created`.
- The record's `original` is not changed here (it changes at swap).

- [ ] **Step 1: Failing tests**

```ts
it("waits for the data drafts before creating the copy", async () => {
  await expect(
    updates(v2).createCopy(actor(), update.id, "dashboard:portfolio"),
  ).rejects.toThrow("store_update_drafts_unpublished");
});
it("creates an unassigned copy with the template's widget changes and the customer's own widgets", async () => {
  for (const d of update.drafts) await publish(d);
  const next = await updates(v2).createCopy(
    actor(),
    update.id,
    "dashboard:portfolio",
  );
  const copy = await dashboards.get(actor(), next.dashboards[0]!.copyId!);
  expect(titles(copy)).toEqual(
    expect.arrayContaining(["Customer widget", "Summary"]),
  );
  expect(titles(copy)).not.toContain(ratingsTitle); // removal chosen
  expect(await devicesOn(copy.id)).toEqual([]);
  expect(await devicesOn(installed.dashboardId)).toEqual([screenId]);
});
it("asks again when the dashboard changed after the review", async () => {
  /* edit widget:downloads title in Studio after apply → store_update_review_changed */
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; `pnpm openapi`. **Step 4: Run** tests + `pnpm openapi:check` → PASS.
- [ ] **Step 5: Commit** `feat(templates): create the updated dashboard copy after its data is published`

### Task 11: Swap onto screens and swap back

**Files:**

- Modify: `apps/server/src/devices/service.ts:203` (export `validateScope`), `apps/server/src/dashboards/store-template-updates.ts`, routes, contracts, `openapi.json`
- Test: `apps/server/src/dashboards/store-template-updates.test.ts`, `apps/server/src/device-scope.test.ts` (add the swap to the query-path matrix)

**Interfaces:**

- Produces: `.swap(actor, updateId, key)` and `.swapBack(actor, updateId, key)` returning `StoreTemplateUpdate`; routes `POST /updates/:updateId/dashboards/:key/swap` and `/swap-back` (`dashboards:update` and `devices:manage`).
- Swap, one transaction: lock the devices (`for update`) with `workspace_id = $ws and dashboard_id = originalId and revoked_at is null`; for each scoped device, validate `{ dashboardId: copyId, values }` with `validateScope(copy, values)`; any failure → 409 `device_scope_not_applicable` with `{ devices: [{ id, name, code }] }` and nothing moves. Otherwise set `dashboard_id = copyId` and `scope.dashboardId = copyId` on all of them, set `original.archived_at = now`, switch the record to `record_id = copyId`, `original = { normalized: <new template dashboard> }`, `widget_keys` = copy's map, `template_version = toVersion`, set `swappedAt`, audit `dashboard.template_swapped` with device ids. Close the update when every dashboard entry is swapped.
- Swap back: the reverse move for devices now on the copy, `archived_at = null` on the original, `archived_at = now` on the copy, record back to the original with its previous `original` (kept in the update row as `previousOriginal`, `previousWidgetKeys`, `previousTemplateVersion` on the dashboards entry), `swappedBackAt`, audit `dashboard.template_swapped_back`. The data side rolls back through the existing history / restore; nothing extra here.

- [ ] **Step 1: Failing tests**

```ts
it("moves every screen of the original to the copy in one step and archives the original", async () => {
  const next = await updates(v2).swap(
    actor(),
    update.id,
    "dashboard:portfolio",
  );
  expect(await devicesOn(copyId)).toEqual([screenId, scopedScreenId]);
  expect((await deviceRow(scopedScreenId)).scope.dashboardId).toBe(copyId);
  expect(
    (await dashboards.get(actor(), installed.dashboardId)).archivedAt,
  ).not.toBeNull();
  expect(next.dashboards[0]!.swappedAt).not.toBeNull();
});
it("refuses the whole swap when a screen's fixed scope does not fit the copy", async () => {
  // v2b removes shared filter 'storefront'; a screen is scoped on storefront
  await expect(
    updates(v2b).swap(actor(), id, "dashboard:portfolio"),
  ).rejects.toThrow("device_scope_not_applicable");
  expect(await devicesOn(originalId)).toHaveLength(2);
});
it("swaps back to the archived original", async () => {
  /* devices back, original unarchived, copy archived */
});
it("serves the copy to a swapped screen", async () => {
  /* device payload route returns copyId */
});
```

`device-scope.test.ts`: a device of workspace A is never moved by a swap in workspace B (same `originalId` impossible; assert via a swap request with B's session → 404 and A's device unchanged).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; `pnpm openapi`. **Step 4: Run** tests + `pnpm openapi:check` → PASS.
- [ ] **Step 5: Commit** `feat(templates): swap an updated dashboard onto its screens and back`

---

## Group E — Web

All strings in `messages/dashboards/{en,de}.ts` (namespace `storeTemplate`, new sub-keys under `update`), `messages/data/{en,de}.ts`, and every new error code in `messages/api-errors/{en,de}.ts`. German uses "du" ("Für deine Vorlage gibt es ein Update", "Wähle, welche Version du behalten willst"). Component tests render both locales with `apps/web/src/lib/i18n/test-render.tsx`.

### Task 12: "Update available" on the template's dashboards and in data settings

**Files:**

- Modify: `apps/web/src/lib/api.ts` (`listStoreTemplateInstalls`, `getStoreTemplatePlan`, `applyStoreTemplateUpdate`, `createStoreTemplateCopy`, `swapStoreTemplateDashboard`, `swapBackStoreTemplateDashboard`, each `browserSend` with the Task 7–11 schemas), `apps/web/src/app/workspaces/[workspaceId]/dashboards/dashboards-browser.tsx`, `apps/web/src/components/studio-editor/studio-status.tsx`, `apps/web/src/components/data/data-workspace.tsx`, `apps/web/src/lib/data-api.ts` (`getDataWorkspace` also loads installs)
- Test: `dashboards-browser.test.tsx`, `studio-status.test.tsx`, `data-workspace.test.tsx`

**Interfaces:**

- Consumes: `storeTemplateInstallListSchema` (Task 7).
- Produces: badge "Update available" / "Update verfügbar" on cards whose id is in an install's `dashboardIds` with `updateAvailable`; Studio status line on such a dashboard; in data settings, a banner listing the install name and summary ("2 measures changed, 1 added · 3 steps changed · 1 widget removed") and marks on the listed models/preparations. All link to `/workspaces/[id]/dashboards/stores/updates/[requestId]`. Archived dashboards appear in a collapsed "Archived" / "Archiviert" section of the dashboards browser, not in the grid.

- [ ] **Step 1: Failing tests**: `"marks the template's dashboards with update available (en, de)"`, `"shows the update summary in data settings"`, `"shows archived dashboards only in the archived section"`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/app/workspaces/[workspaceId]/dashboards/dashboards-browser.test.tsx apps/web/src/components/data/data-workspace.test.tsx apps/web/src/components/studio-editor/studio-status.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): show store-template updates on dashboards and in data settings`

### Task 13: Review and apply page

**Files:**

- Create: `apps/web/src/app/workspaces/[workspaceId]/dashboards/stores/updates/[requestId]/page.tsx`, `store-update-review.tsx`, `store-update-review.test.tsx`

**Interfaces:**

- Consumes: `getStoreTemplatePlan`, `applyStoreTemplateUpdate` (Task 12).
- Produces: a page (role gate `data:edit` and `dashboards:create`, else the existing `roleCannot` pattern) with: summary; per record, items grouped as "Kept from you", "From the template", "Your choice" (`choose`: radio "Use the template's version" / "Keep mine", no default), "Proposed for removal" (`propose_removal`: radio "Remove" / "Keep", no default); scope items not shown individually ("App selection adjusted"). Item text is name + one-line description from the item value (measure name and aggregation, step type and name, widget title and type, filter name); raw JSON is never shown. "Apply as drafts" is disabled until every choice is made, sends `basis` + decisions, and on `store_update_stale` reloads the plan with a notice. A record with `hasUnpublishedDraft` notes "Includes your unpublished changes". Optional: when the impact endpoint exists, each draft row links its impact list.

- [ ] **Step 1: Failing tests**: `"needs a decision for every conflict and proposed removal before applying"`, `"sends the chosen decisions with the plan basis"`, `"reloads the plan when it changed"`, `"renders the review in German"`.
- [ ] **Step 2: Run** `pnpm vitest run 'apps/web/src/app/workspaces/[workspaceId]/dashboards/stores/updates'` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): review and apply a store-template update`

### Task 14: Progress, copy and swap

**Files:**

- Modify: `store-update-review.tsx` (progress view when the install has an `openUpdate`), test file

**Interfaces:**

- Consumes: `createStoreTemplateCopy`, `swapStoreTemplateDashboard`, `swapBackStoreTemplateDashboard`.
- Produces: three steps. 1 "Publish the data drafts": each draft with its state and a link to its editor in data settings (`/workspaces/[id]/data?model=<id>`; preparations via the existing open-preparation link), where the normal preview → publish happens. 2 "Create the updated dashboard": enabled when `ready`; then "Open in Studio" to compare. 3 "Use it on your screens": names the screens that move; on `device_scope_not_applicable` lists the screens whose fixed scope doesn't fit. After the swap, "Switch back" calls swap-back. Capability gates per button follow the Global Constraints.

- [ ] **Step 1: Failing tests**: `"keeps the copy step disabled until every draft is published"`, `"lists the screens a swap would move and those it cannot"`, `"offers switching back after a swap"` (en and de).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Check in a real browser** (`pnpm dev`, a workspace with a store install and a v2 fixture template enabled through a test-only server option or by temporarily bumping the version locally, not committed): badge → review → apply → publish drafts → create copy → open in Studio → swap → screen shows copy → switch back; repeat in German.
- [ ] **Step 6: Commit** `feat(web): publish, copy and swap steps for store-template updates`

---

## Group F — Change the apps of an installed template

The design says adding or removing apps regenerates scope-derived parts from the stored inputs, but there is no action today that changes an install's apps after installation. This group adds it. Product groups stay where they are edited today (the mapping and products tables in data settings, customer data that updates never touch); this action changes connections and the app scope only.

### Task 15: Scope change server side

**Files:**

- Modify: `apps/server/src/dashboards/store-template-updates.ts`, routes, contracts, `openapi.json`
- Test: `apps/server/src/dashboards/store-template-updates.test.ts`

**Interfaces:**

- Produces: `PUT /installs/:requestId/scope` body `{ basis, connections: uuid[], appScope?: { connectionId, appId } }` (`data:edit` and `dashboards:create`), and `GET /installs/:requestId/scope-plan?connections=…&appScope=…` returning a `storeTemplatePlanSchema` with `toVersion = fromVersion`. Both reuse plan/apply with an `inputs` override: new connections' sources are registered as in `install` (`registerSourceDataset`), their per-source preparations and the append preparations come out as drafts, removed connections' per-source preparations are `propose_removal` records, and the dashboard's `filter:app.fixedValue` change goes through the copy/swap path. Every item is `scope` except removals. Stored `inputs` change on apply.

- [ ] **Step 1: Failing tests**: `"adds a connection as draft preparations without conflicts"`, `"proposes the removed connection's preparations for removal"`, `"changes the app scope through an updated dashboard copy"`, `"refuses a connection of another workspace"` (404 `connection_not_found`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; `pnpm openapi`. **Step 4: Run** + `pnpm openapi:check` → PASS.
- [ ] **Step 5: Commit** `feat(templates): change the apps of an installed store template`

### Task 16: Scope change UI

**Files:**

- Modify: `apps/web/src/app/workspaces/[workspaceId]/dashboards/stores/store-template-form.tsx` (edit mode, `?install=<requestId>`: connections and app scope prefilled, groups section hidden with a link to the mapping table), `store-update-review.tsx` (reused for the scope plan), messages en/de
- Test: `store-template-form` tests (create `store-template-form.test.tsx` if absent)

- [ ] **Step 1: Failing tests**: `"opens an install in edit mode with its connections"`, `"shows the scope plan before applying"` (en, de).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Real-browser check** add/remove a connection end to end.
- [ ] **Step 6: Commit** `feat(web): change the apps of an installed store template`

---

## Self-review notes

- Spec coverage: versions (T1), inputs + originals (T2–T3), baseline (T2, T4), scope not a conflict (T5–T6, T15), three-way + per-item choice + removals proposed (T6, T8, T13), data as drafts (T8), copy after publish + unassigned (T10), one-step swap + archived original (T9, T11), rollback (T11 swap back; data via existing history/restore), "update available" + summary on dashboards and data settings (T7, T12), German (Group E), isolation (T2, T7, T8, T11).
- Decisions the spec left open, made here: storage as a records table plus columns (spec "Left to the builder"); record names are never compared (they are the customer's); whole records the template drops are detached, not deleted (no delete path exists for preparations/models); removal choices have no default; the copy is created by an explicit step once drafts are published (not automatically on publish); scope change covers connections and app scope, product groups stay in the mapping tables.
