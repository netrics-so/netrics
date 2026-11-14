# M11 Impact before publish and Projects navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before publishing a preparation, model or measure, the customer sees which preparations, models, measures, dashboards (widgets) and paired screens depend on it; and models and preparations can belong to a project, projects can be archived, and navigation and pickers follow the user's stored active project.

**Architecture:** Impact is a pure dependency collector (`apps/server/src/data/impact.ts`) fed by one workspace-scoped loader that reads drafts, published versions/releases, widget bindings, dashboard filter mappings and live devices; a route per kind returns it, redacted by the caller's capabilities, and a confirmation dialog in both data editors shows it. Projects gain `archived_at`, data items gain `project_id` (migration), list routes accept one `project` query that the web fills from `memberships.active_project_id` (resolved to null when archived), and one web helper decides picker scope.

**Tech Stack:** TypeScript, Fastify, drizzle-orm 0.45 / drizzle-kit 0.31 on PostgreSQL 17 (RLS), zod 4 contracts + generated OpenAPI, Next.js App Router, vitest, ICU catalogs (`apps/web/src/messages/<area>/{en,de}.ts`).

**Spec:** `docs/milestones/11-completion-design.md` (sections "Impact before publish (11C)" and "Projects (11E navigation)"); where silent, `docs/milestones/11-projects-and-derived-metrics.md` and ADR 0022.

## Global Constraints

- Definition of done from `CLAUDE.md`: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`; `pnpm openapi:check` whenever routes or contracts change (`pnpm openapi` regenerates `packages/contracts/openapi.json`).
- Tests run with `NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5433/postgres` (`pnpm db:up` starts Postgres on 5433). Every test command below assumes it is exported.
- Tenant isolation twice: every new query runs inside `withWorkspace` (RLS under `netrics_app`) **and** carries an explicit `workspace_id = $workspace` predicate on every table it reads.
- Schema changes: a drizzle migration generated with `pnpm db:generate`, forward only, tested on data in the previous shape (`createTestDatabase({ upTo })` + `testDb.migrate()`, `TEST_DATABASE_SETUP_TIMEOUT_MS`).
- Roles: existing `data:*` capabilities gate every new data action (`data:edit` reads impact, `data:edit` assigns a data item's project). No new `data:` capability. No new `projects:` capability: archive/unarchive is gated by `projects:rename` (same role set: owner, admin, editor; reversible metadata change). Hard delete stays `projects:delete`, unchanged.
- Impact never blocks publishing: "Publishing is not blocked by dependents; it is blocked only by existing validation."
- Items the caller cannot see are "counted, not named".
- Archiving "hides a project and its items from navigation and pickers but never stops published dashboards or paired screens; un-archiving restores it." Device payloads (schemas 1–3) stay byte-for-byte identical.
- "All" (null) stays the default active project. An archived active project falls back to "All".
- A project change never alters a published dashboard or paired screen, and never creates a data draft (assigning a project does not bump `version`).
- German is required on every new screen, informal "du".
- One issue per PR, `Closes #N` in the body. Squash-merge after green CI.

## Review Focus

1. **Preparation publish with pinned models.** A model release pins the preparation versions it was published with (`data_model_releases.dependencies.prepared`, read by `createDataLoader` before `publishedVersion`), so publishing a preparation changes no dashboard until the model is published again. The dialog must say so instead of claiming screens change now. Test owned by Task 1 (`pinnedVersion`) and Task 3 (copy).
2. **Archived active project across sessions.** User picks project P, someone archives P: every page shows "All"; un-archiving P brings the user's choice back. Test owned by Task 4 (resolution) and Task 5 (route).
3. **Hard-deleted project.** Items' `project_id` becomes null (existing FK `ON DELETE SET NULL`); the deleted project's id stored as active project becomes null too (existing FK on `memberships`); lists under "All" show those items. Test owned by Task 7.
4. **Dependency cycles and self-reference.** A preparation whose draft reads its own output, or two preparations reading each other through older published versions, must not hang the collector. Test owned by Task 1.
5. **Revoked and unassigned screens; scoped screens.** Revoked devices are never listed as affected; a device with a fixed scope is listed once for its dashboard. A device whose dashboard is in an archived project keeps an identical payload. Tests owned by Task 1 (revoked) and Task 7 (payload).

---

## Group A — Impact before publish (11C)

One issue and one PR: **"Impact before publish: dependents of preparations, models and measures"**. Depends on nothing in this plan. Touches the publish buttons of `preparation-editor.tsx` and `model-editor.tsx`, which the step-errors and visual-builder plans also touch: rebase on whichever merges first.

### Task 1: Pure impact collector

**Files:**

- Create: `apps/server/src/data/impact.ts`
- Test: `apps/server/src/data/impact.test.ts`
- Modify: `packages/contracts/src/data-processing.ts` (append schemas)

**Interfaces:**

- Consumes: `measureDependencies(measure: ModelMeasure): string[]` from `@netrics/domain` (`packages/domain/src/data-model-windows.ts:55`); `SemanticModelDefinition`, `PreparationGraph` types.
- Produces (contracts, exported from `@netrics/contracts`):

```ts
export const dataImpactTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preparation"), id: z.uuid() }),
  z.object({ kind: z.literal("model"), id: z.uuid() }),
  z.object({
    kind: z.literal("measure"),
    id: z.uuid(), // the model
    measureIds: z.array(id).min(1).max(50),
  }),
]);
export const dataImpactQuerySchema = z.strictObject({
  // repeated ?measureId=a&measureId=b; a single value is coerced to [value]
  measureId: z
    .union([id, z.array(id).min(1).max(50)])
    .optional()
    .transform((v) => (v === undefined ? undefined : [v].flat())),
});
export const dataImpactResponseSchema = z.object({
  target: dataImpactTargetSchema,
  preparations: z.array(z.object({ id: z.uuid(), name: z.string() })),
  models: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      publishedVersion: z.number().int().positive().nullable(),
      /** Preparation targets only: the target version this model's live release reads; null when it reads none yet. */
      pinnedVersion: z.number().int().positive().nullable(),
    }),
  ),
  measures: z.array(z.object({ modelId: z.uuid(), id, name: z.string() })),
  dashboards: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      widgets: z.array(
        z.object({
          id: z.uuid(),
          type: z.string(),
          title: z.string().nullable(),
        }),
      ),
      /** Bound through a shared filter mapping only (no widget). */
      viaFilter: z.boolean(),
    }),
  ),
  screens: z.array(
    z.object({ id: z.uuid(), name: z.string(), dashboardId: z.uuid() }),
  ),
  hidden: z.object({
    preparations: z.number().int().nonnegative(),
    models: z.number().int().nonnegative(),
    dashboards: z.number().int().nonnegative(),
    screens: z.number().int().nonnegative(),
  }),
  /** Model and measure targets: measures whose draft differs from the live release; null when never published. */
  changedMeasureIds: z.array(id).nullable(),
});
export type DataImpactTarget = z.infer<typeof dataImpactTargetSchema>;
export type DataImpact = z.infer<typeof dataImpactResponseSchema>;
```

- Produces (server, `apps/server/src/data/impact.ts`):

```ts
export interface ImpactGraph {
  preparations: Array<{
    id: string;
    name: string;
    /** preparation ids read by the draft graph (source nodes "prepared:<id>:<out>") */
    draftReads: string[];
    /** keys of the published version's dependencies.prepared (transitive) */
    publishedReads: string[];
  }>;
  models: Array<{
    id: string;
    name: string;
    publishedVersion: number | null;
    draft: SemanticModelDefinition;
    released: SemanticModelDefinition | null;
    /** release dependencies.prepared (transitive pins) */
    releasePins: Record<string, number>;
  }>;
  widgets: Array<{
    id: string;
    dashboardId: string;
    type: string;
    title: string | null;
    modelId: string;
    measureIds: string[];
  }>;
  filterModels: Array<{ dashboardId: string; modelId: string }>;
  dashboards: Array<{ id: string; name: string }>;
  /** non-revoked devices with a dashboard */
  devices: Array<{ id: string; name: string; dashboardId: string }>;
}
export function collectDataImpact(
  graph: ImpactGraph,
  target: DataImpactTarget,
): Omit<DataImpact, "hidden">;
export function redactDataImpact(
  impact: Omit<DataImpact, "hidden">,
  may: { data: boolean; dashboards: boolean; screens: boolean },
): DataImpact;
```

Rules `collectDataImpact` implements (tests pin each):

- Preparation target P: dependent preparations = transitive closure over `draftReads ∪ publishedReads` (P itself excluded, visited set guards cycles). Dependent models = models whose `draft.datasets` or `released.datasets` contain `prepared:<P or dependent>:*`, or whose `releasePins` has P or a dependent. `pinnedVersion = releasePins[P] ?? null`. `measures = []`.
- Model target M: `preparations = []`, `models = []`, all widgets with `modelId = M`, all dashboards in `filterModels` with M (`viaFilter: true` when no widget of that dashboard binds M).
- Measure target (M, ids): `measures` = measures of M's draft that depend on any id, transitively via `measureDependencies`, ids themselves excluded; widgets with `modelId = M` whose `measureIds` intersect ids ∪ dependent measure ids. Filter-mapped dashboards are not affected by a measure.
- Preparation target reaches dashboards and screens through every dependent model as in the model rule.
- Screens: devices whose `dashboardId` is an affected dashboard. Output lists sorted by name, then id.
- `changedMeasureIds` (model and measure targets): ids whose JSON differs between `draft.measures` and `released.measures`, plus ids only in either; `null` when `released` is null; for preparation targets `null`.
- `redactDataImpact`: when `may.data` is false, preparations/models/measures are emptied and counted into `hidden`; `may.dashboards` false empties dashboards (count into `hidden.dashboards`); `may.screens` false empties screens. Nothing else is touched.

- [ ] **Step 1: Write the failing tests** in `apps/server/src/data/impact.test.ts`, building `ImpactGraph` literals by hand:

```ts
it("follows preparations transitively and reports the pinned version", () => {
  // P <- Q (draft reads P) ; model M1 reads Q (draft datasets), release pins { P: 3, Q: 2 }
  const impact = collectDataImpact(graph, { kind: "preparation", id: P });
  expect(impact.preparations.map((p) => p.id)).toEqual([Q]);
  expect(impact.models).toEqual([
    { id: M1, name: "Revenue", publishedVersion: 4, pinnedVersion: 3 },
  ]);
  expect(impact.dashboards.map((d) => d.id)).toEqual([D1]);
  expect(impact.screens.map((s) => s.id)).toEqual([LOBBY]);
});
it("terminates on cycles and never lists the target itself", () => {
  // P draftReads [Q], Q publishedReads [P], P draftReads [P]
  expect(
    collectDataImpact(cyclic, { kind: "preparation", id: P }).preparations.map(
      (p) => p.id,
    ),
  ).toEqual([Q]);
});
it("limits a measure target to widgets using it or a measure built on it", () => {
  // M measures: revenue, revenue7 (rolling base revenue), orders; W1 binds revenue7, W2 binds orders
  const impact = collectDataImpact(graph, {
    kind: "measure",
    id: M,
    measureIds: ["revenue"],
  });
  expect(impact.measures.map((m) => m.id)).toEqual(["revenue7"]);
  expect(impact.dashboards.flatMap((d) => d.widgets.map((w) => w.id))).toEqual([
    W1,
  ]);
});
it("lists a dashboard bound only through a filter mapping for a model target", () => {
  expect(
    collectDataImpact(graph, { kind: "model", id: M }).dashboards.find(
      (d) => d.id === D2,
    ),
  ).toMatchObject({ viaFilter: true, widgets: [] });
});
it("ignores revoked devices (the graph never contains them) and lists a device once", () => {
  /* two widgets on D1, one device */
});
it("reports changed measures against the live release, null when unpublished", () => {
  expect(
    collectDataImpact(graph, { kind: "model", id: M }).changedMeasureIds,
  ).toEqual(["revenue"]);
  expect(
    collectDataImpact(unpublished, { kind: "model", id: M }).changedMeasureIds,
  ).toBeNull();
});
it("counts what the caller may not see instead of naming it", () => {
  const out = redactDataImpact(full, {
    data: true,
    dashboards: false,
    screens: false,
  });
  expect(out.dashboards).toEqual([]);
  expect(out.screens).toEqual([]);
  expect(out.hidden).toEqual({
    preparations: 0,
    models: 0,
    dashboards: 2,
    screens: 1,
  });
});
```

Also a contracts test in `packages/contracts/src/data-processing.test.ts`: `dataImpactQuerySchema.parse({ measureId: "revenue" })` → `{ measureId: ["revenue"] }`; `{ measureId: "1bad" }` throws.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/server/src/data/impact.test.ts packages/contracts/src/data-processing.test.ts`
Expected: FAIL (`collectDataImpact` / `dataImpactQuerySchema` not exported).

- [ ] **Step 3: Implement** the schemas in `packages/contracts/src/data-processing.ts` and `collectDataImpact`, `redactDataImpact` in `apps/server/src/data/impact.ts` (pure, no imports from `@netrics/database`).

- [ ] **Step 4: Run to verify they pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/data/impact.ts apps/server/src/data/impact.test.ts packages/contracts/src/data-processing.ts packages/contracts/src/data-processing.test.ts
git commit -m "feat(data): collect dependents of preparations, models and measures"
```

### Task 2: Impact loader, service and routes

**Files:**

- Modify: `apps/server/src/data/impact.ts` (add loader)
- Modify: `apps/server/src/data/service.ts` (add `impact` to the object returned by `createDataService`)
- Modify: `apps/server/src/routes/data.ts` (inside the existing `for (const kind of ["preparations", "models"] as const)` loop)
- Modify: `packages/contracts/openapi.json` (regenerated)
- Test: `apps/server/src/data/impact-routes.test.ts`

**Interfaces:**

- Consumes: Task 1 `collectDataImpact`, `redactDataImpact`, `ImpactGraph`, contracts schemas; `can` from `@netrics/domain`; `measureWidgetBindingSchema`, `compareMeasureBindingSchema`, `dashboardDataFiltersSchema` from `@netrics/contracts`.
- Produces:

```ts
// apps/server/src/data/impact.ts
export async function loadImpactGraph(tx: Transaction, workspaceId: string): Promise<ImpactGraph>;
// service
impact(actor: DataActor & { role: WorkspaceRole }, target: DataImpactTarget): Promise<DataImpact>;
// routes
GET /v1/workspaces/:workspaceId/data/preparations/:id/impact            -> dataImpactResponseSchema
GET /v1/workspaces/:workspaceId/data/models/:id/impact[?measureId=..]   -> dataImpactResponseSchema
```

Loader reads, each with `eq(<table>.workspaceId, workspaceId)`: `data_preparations` (draft graph) left-joined to `data_preparation_versions` at `published_version` (dependencies); `data_models` left-joined to `data_model_releases` at `published_version` (definition, dependencies); `dashboard_widgets` where `model_id is not null` (measure ids from `measureWidgetBindingSchema` for type `measure`, `Object.values(binding.measureIds)` for type `compare`; unparsable bindings are skipped, not thrown); `dashboards` (id, name, `data_filters` → `mappings[].modelId`); `devices` where `revoked_at is null and dashboard_id is not null`.

Service: unknown or other-workspace id → `fail("data_not_found", 404)` (checked by `findPreparation` / `findDataModel` first); a measure id not in the model's draft → `fail("data_measure_not_found", 404)`. Redaction: `may = { data: can(role, "data:edit"), dashboards: can(role, "dashboards:view"), screens: can(role, "devices:view") }`. The route is gated by `data:edit`; responses set `cache-control: no-store`.

- [ ] **Step 1: Write the failing route tests** in `apps/server/src/data/impact-routes.test.ts`, following the setup in `apps/server/src/data.test.ts` (`createTestDatabase()`, `buildApp`, `signup`, `addMemberViaInvitation`), with fixtures from `apps/server/src/data/test-helpers.ts` (`campaignPreparation`, `campaignModel`, `campaignDashboard`). Two workspaces W1 and W2 with the same shape (preparation → model → dashboard with one measure widget → one paired device, plus one revoked device).

```ts
it("lists dependents of a preparation in the caller's workspace only", async () => {
  const res = await call("GET", `/preparations/${prepW1}/impact`, ownerW1);
  expect(res.statusCode).toBe(200);
  const body = dataImpactResponseSchema.parse(res.json());
  expect(body.models.map((m) => m.id)).toEqual([modelW1]);
  expect(body.dashboards.map((d) => d.id)).toEqual([dashboardW1]);
  expect(body.screens.map((s) => s.name)).toEqual(["Lobby"]); // not "Old" (revoked)
  expect(JSON.stringify(body)).not.toContain(modelW2);
});
it("answers 404 for another workspace's preparation and model", async () => {
  expect(
    (await call("GET", `/preparations/${prepW2}/impact`, ownerW1)).statusCode,
  ).toBe(404);
  expect(
    (await call("GET", `/models/${modelW2}/impact`, ownerW1)).statusCode,
  ).toBe(404);
});
it("refuses viewers", async () => {
  expect(
    (await call("GET", `/models/${modelW1}/impact`, viewerW1)).statusCode,
  ).toBe(403);
});
it("narrows to a measure and rejects unknown measures", async () => {
  expect(
    (
      await call("GET", `/models/${modelW1}/impact?measureId=spend`, ownerW1)
    ).json().target,
  ).toEqual({ kind: "measure", id: modelW1, measureIds: ["spend"] });
  expect(
    (await call("GET", `/models/${modelW1}/impact?measureId=nope`, ownerW1))
      .statusCode,
  ).toBe(404);
});
it("does not block publishing", async () => {
  // impact lists a dashboard; publish of a new valid draft still answers 200
});
```

Add the isolation probe to `apps/server/src/cross-workspace.test.ts` next to the other data probes: W2's owner calling `/data/preparations/<W1 id>/impact` gets the same 404 body as a random uuid (no existence oracle).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/server/src/data/impact-routes.test.ts apps/server/src/cross-workspace.test.ts`
Expected: FAIL with 404 on the new routes (not registered).

- [ ] **Step 3: Implement** `loadImpactGraph`, `service.impact`, and the two routes (doc summary "List what depends on a preparation, model or measure before publishing", tags `["data"]`, querystring `dataImpactQuerySchema` on the models route only). Pass the role into the actor (`WorkspaceAccess` from `routes/access.ts` already carries `role`).

- [ ] **Step 4: Run tests and regenerate OpenAPI**

Run: `pnpm exec vitest run apps/server/src/data/impact-routes.test.ts apps/server/src/cross-workspace.test.ts && pnpm openapi && pnpm openapi:check`
Expected: PASS; `openapi:check` reports no diff.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/data apps/server/src/routes/data.ts apps/server/src/cross-workspace.test.ts packages/contracts/openapi.json
git commit -m "feat(api): impact routes for preparations, models and measures"
```

### Task 3: Publish confirmation with the impact list

**Files:**

- Modify: `apps/web/src/lib/data-api.ts` (add `readDataImpact`)
- Create: `apps/web/src/components/data/publish-impact-dialog.tsx`
- Test: `apps/web/src/components/data/publish-impact-dialog.test.tsx`
- Modify: `apps/web/src/components/data/preparation-editor.tsx` (`persist(publish)` at ~line 156)
- Modify: `apps/web/src/components/data/model-editor.tsx` (`persist(publish)` at ~line 184)
- Modify: `apps/web/src/messages/data/en.ts`, `apps/web/src/messages/data/de.ts`

**Interfaces:**

- Consumes: Task 2 routes; `DataImpact` type.
- Produces:

```ts
export const readDataImpact = (
  workspaceId: string,
  target: { kind: "preparation" | "model"; id: string; measureIds?: string[] },
) => Promise<DataImpact>;
export function PublishImpactDialog(props: {
  impact: DataImpact | "loading" | "failed";
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element;
```

Behaviour: clicking Publish on a record that already has an `id` saves (as today), then opens the dialog (native `<dialog>` with `showModal`, as `components/studio-editor/assign-tvs.tsx` does) while `readDataImpact` loads; Confirm publishes, Cancel leaves the saved draft. A record without an `id` (never saved) publishes directly, as today. If the impact read fails, the dialog says so and Confirm stays enabled (impact never blocks). The model editor highlights widgets whose measures are in `changedMeasureIds` with the "changed" marker.

Copy (new group `data.impact`):

| key            | en                                                                         | de                                                                                                          |
| -------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `title`        | Publish {name}?                                                            | {name} veröffentlichen?                                                                                     |
| `loading`      | Checking what uses this…                                                   | Prüfe, was das verwendet …                                                                                  |
| `failed`       | Could not check what uses this. You can still publish.                     | Konnte nicht prüfen, was das verwendet. Du kannst trotzdem veröffentlichen.                                 |
| `none`         | Nothing uses this yet.                                                     | Noch nichts verwendet das.                                                                                  |
| `preparations` | {count, plural, one {# preparation} other {# preparations}}                | {count, plural, one {# Aufbereitung} other {# Aufbereitungen}}                                              |
| `models`       | {count, plural, one {# model} other {# models}}                            | {count, plural, one {# Modell} other {# Modelle}}                                                           |
| `measures`     | {count, plural, one {# measure} other {# measures}}                        | {count, plural, one {# Kennzahl} other {# Kennzahlen}}                                                      |
| `dashboards`   | {count, plural, one {# dashboard} other {# dashboards}}                    | {count, plural, one {# Dashboard} other {# Dashboards}}                                                     |
| `screens`      | {count, plural, one {# paired screen} other {# paired screens}}            | {count, plural, one {# gekoppelter Bildschirm} other {# gekoppelte Bildschirme}}                            |
| `hidden`       | {count, plural, one {# more you can't open} other {# more you can't open}} | {count, plural, one {# weiteres, das du nicht öffnen kannst} other {# weitere, die du nicht öffnen kannst}} |
| `pinned`       | Uses version {version} until the model is published again.                 | Nutzt Version {version}, bis das Modell erneut veröffentlicht wird.                                         |
| `viaFilter`    | Through a shared filter                                                    | Über einen gemeinsamen Filter                                                                               |
| `changed`      | Changed                                                                    | Geändert                                                                                                    |
| `confirm`      | Publish                                                                    | Veröffentlichen                                                                                             |
| `cancel`       | Cancel                                                                     | Abbrechen                                                                                                   |

Check the German nouns against the existing `data` catalog (`messages/data/de.ts`) and reuse its terms if they differ ("Aufbereitung", "Modell", "Kennzahl").

- [ ] **Step 1: Write the failing component tests** with `apps/web/src/lib/i18n/test-render.tsx`:

```tsx
it("lists dependents with counts and hidden items", () => {
  render(
    <PublishImpactDialog
      impact={impactWithHidden}
      onConfirm={confirm}
      onCancel={cancel}
    />,
  );
  expect(screen.getByText("1 dashboard")).toBeVisible();
  expect(screen.getByText("Lobby")).toBeVisible();
  expect(screen.getByText("2 more you can't open")).toBeVisible();
});
it("explains pinned models for a preparation", () => {
  expect(
    screen.getByText("Uses version 3 until the model is published again."),
  ).toBeVisible();
});
it("keeps Publish enabled when the impact read failed", () => {
  /* impact="failed" */
});
it("renders in German", () => {
  /* locale de: "1 gekoppelter Bildschirm", "Abbrechen" */
});
```

And in `apps/web/src/components/data/model-editor.test.tsx`: publishing an existing model opens the dialog and calls `publishModel` only after Confirm; Cancel never calls it.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/web/src/components/data/publish-impact-dialog.test.tsx apps/web/src/components/data/model-editor.test.tsx`
Expected: FAIL (component missing; publish called without confirmation).

- [ ] **Step 3: Implement** `readDataImpact`, the dialog, the editor wiring and both catalogs.

- [ ] **Step 4: Run tests, then the i18n parity test**

Run: `pnpm exec vitest run apps/web/src/components/data apps/web/src/lib/i18n/i18n.test.ts`
Expected: PASS.

- [ ] **Step 5: Check in a real browser** (`pnpm dev`): publish a preparation that feeds a model with a dashboard on a paired kiosk; the dialog lists the model with "Uses version …", the dashboard and the kiosk, in English and German.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/data-api.ts apps/web/src/components/data apps/web/src/messages/data
git commit -m "feat(web): show dependents in the publish confirmation"
```

---

## Group B — Projects: data items, archive and filtered lists (API)

One issue and one PR: **"Projects: project on models and preparations, archive, project filter on lists"**. Depends on nothing in this plan; Group C depends on it. Contains the only migration of this plan.

### Task 4: Migration and database helpers

**Files:**

- Modify: `packages/database/src/schema.ts` (`projects` ~line 238, `dataPreparations` ~1907, `dataModels` ~1954)
- Create: `packages/database/drizzle/0071_project_archive_data_projects.sql` (+ `meta/0071_snapshot.json`, `_journal.json` entry, generated)
- Create: `packages/database/src/project-archive-migration.test.ts`
- Modify: `packages/database/src/workspaces.ts` (helpers), `packages/database/src/users.ts` (`listMembershipsForUser`), `packages/database/src/index.ts` (exports)
- Create: `packages/database/src/project-filter.ts`
- Test: `packages/database/src/project-filter.test.ts`

**Migration number:** `0071` is the next free number on `main` at `447fcc4` (last: `0070_prune_revoked_devices`). The template-updates plan also adds a migration in parallel; whichever PR merges second regenerates its migration on top (`pnpm db:generate` again after rebasing) and renumbers.

**Interfaces:**

- Produces (schema):
  - `projects.archivedAt: timestamp("archived_at", { withTimezone: true })` (nullable).
  - `dataPreparations.projectId` and `dataModels.projectId`: `uuid("project_id").references(() => projects.id, { onDelete: "set null" })`, the same shape as `connections.projectId` and `dashboards.projectId`; plus `index("data_preparations_project_idx").on(t.workspaceId, t.projectId)` and `index("data_models_project_idx").on(t.workspaceId, t.projectId)`.
- Produces (helpers):

```ts
// workspaces.ts
export async function setProjectArchived(
  tx: Transaction,
  input: {
    workspaceId: string;
    projectId: string;
    archived: boolean;
    now: Date;
  },
): Promise<Project | null>; // sets archived_at = now or null; explicit workspace predicate
// users.ts — MembershipInfo.activeProjectId is now the *effective* project:
// null when the stored project is archived (resolved inside the per-membership withWorkspace block,
// selecting projects.archived_at with explicit workspace_id predicate).
// project-filter.ts
export type ProjectFilter = {
  project?: "all" | string;
  unassigned?: "include";
};
export function projectFilterSql(
  column: AnyPgColumn,
  workspaceId: string,
  filter: ProjectFilter,
): SQL | undefined;
```

`projectFilterSql` semantics: `project` undefined → `undefined` (no predicate; full list as today). `"all"` → `column is null or column in (select id from projects where workspace_id = $ws and archived_at is null)`. A uuid → `column = $uuid`, or `(column = $uuid or column is null)` with `unassigned: "include"`. An unknown uuid yields no rows (no existence oracle).

- [ ] **Step 1: Write the failing migration test** `packages/database/src/project-archive-migration.test.ts` (pattern: `device-scope-migration.test.ts`; `LAST_BEFORE = "0070_prune_revoked_devices"`). Before `testDb.migrate()`, insert as owner: a workspace, a project, a connection and dashboard in that project, a membership with `active_project_id` set, one `data_preparations` row and one `data_models` row (minimal valid `graph` / `definition` JSON copied from `dataset-publication-migration.test.ts`).

```ts
expect(project.archived_at).toBeNull();
expect(preparation.project_id).toBeNull();
expect(model.project_id).toBeNull();
expect(membership.active_project_id).toBe(projectId); // untouched
// deleting the project still nulls every reference, including the new ones
await owner`update data_models set project_id = ${projectId}`;
await owner`delete from projects where id = ${projectId}`;
expect(
  (await owner`select project_id from data_models`)[0]!.project_id,
).toBeNull();
```

- [ ] **Step 2: Write the failing filter test** `packages/database/src/project-filter.test.ts` (fresh `createTestDatabase()`, queries under `withWorkspace` as `netrics_app`): rows in project A, archived project B, none; and a row of another workspace in a project with A's name.

```ts
expect(await names(undefined)).toEqual(["a", "b", "none"]);
expect(await names({ project: "all" })).toEqual(["a", "none"]);
expect(await names({ project: A })).toEqual(["a"]);
expect(await names({ project: A, unassigned: "include" })).toEqual([
  "a",
  "none",
]);
expect(await names({ project: otherWorkspaceProject })).toEqual([]);
```

And extend `packages/database/src/tenancy.test.ts` (or the users test that covers `listMembershipsForUser`): archived active project → `activeProjectId` null; unarchive → the stored id again.

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm exec vitest run packages/database/src/project-archive-migration.test.ts packages/database/src/project-filter.test.ts packages/database/src/tenancy.test.ts`
Expected: FAIL (column `archived_at` does not exist; `projectFilterSql` missing).

- [ ] **Step 4: Change `schema.ts`, generate the migration, implement helpers**

Run: `pnpm db:up && pnpm db:generate --name project_archive_data_projects`
Expected: `packages/database/drizzle/0071_project_archive_data_projects.sql` with three `ADD COLUMN`, two foreign keys `ON DELETE set null`, two indexes. Prepend a two-line comment as earlier migrations do. Then implement `setProjectArchived`, the effective `activeProjectId`, and `projectFilterSql`; export them from `index.ts`.

- [ ] **Step 5: Run to verify they pass** (Step 3 command). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/database
git commit -m "feat(database): archived projects and a project on models and preparations"
```

### Task 5: Archive and unarchive routes; active project respects archive

**Files:**

- Modify: `packages/contracts/src/index.ts` (`projectSchema` ~line 349)
- Modify: `apps/server/src/routes/workspaces.ts` (next to the rename/delete routes ~696–810; `toProject` ~92; set-active-project ~571)
- Modify: `apps/web/src/messages/api-errors/en.ts`, `de.ts`
- Test: `apps/server/src/workspaces.test.ts`, `apps/server/src/cross-workspace.test.ts`
- Modify: `packages/contracts/openapi.json` (regenerated)

**Interfaces:**

- Consumes: Task 4 `setProjectArchived`, effective `activeProjectId`.
- Produces:
  - `projectSchema` gains `archivedAt: z.iso.datetime().nullable()`; `GET /projects` lists archived projects too (clients filter).
  - `POST /v1/workspaces/:workspaceId/projects/:projectId/archive` and `.../unarchive` → `projectResponseSchema`; gated by `projects:rename`; 404 `project_not_found`; idempotent (archiving an archived project keeps its first `archivedAt`); audit `project.archived` / `project.unarchived` with `{ name }`.
  - `PATCH /active-project` with an archived project → 409 `project_archived`.
  - Error copy: `project_archived` en "This project is archived. Unarchive it first." / de "Dieses Projekt ist archiviert. Hol es zuerst aus dem Archiv."; `project_not_found` en "This project no longer exists." / de "Dieses Projekt gibt es nicht mehr."

- [ ] **Step 1: Write the failing tests** in `apps/server/src/workspaces.test.ts`:

```ts
it("archives and unarchives a project; editors may, viewers may not", async () => {
  expect((await post(`/projects/${p}/archive`, viewer)).statusCode).toBe(403);
  const archived = projectResponseSchema.parse(
    (await post(`/projects/${p}/archive`, editor)).json(),
  );
  expect(archived.project.archivedAt).not.toBeNull();
  expect(
    (await post(`/projects/${p}/unarchive`, editor)).json().project.archivedAt,
  ).toBeNull();
});
it("falls back to All while the active project is archived and restores it after", async () => {
  await patch("/active-project", owner, { projectId: p });
  await post(`/projects/${p}/archive`, owner);
  expect(activeOf(await get("/workspaces", owner))).toBeNull();
  await post(`/projects/${p}/unarchive`, owner);
  expect(activeOf(await get("/workspaces", owner))).toBe(p);
});
it("refuses an archived project as active project", async () => {
  expect(
    (await patch("/active-project", owner, { projectId: archived })).statusCode,
  ).toBe(409);
});
it("hard delete is unchanged", async () => {
  /* 204, items' projectId null, audit project.deleted */
});
```

In `cross-workspace.test.ts`: archiving W1's project as W2's owner → 404 identical to a random uuid.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/server/src/workspaces.test.ts apps/server/src/cross-workspace.test.ts`
Expected: FAIL (404 on `/archive`).

- [ ] **Step 3: Implement** the contract field, routes, the 409 check in set-active-project (inside the same transaction, after `findProject`), and the error copy.

- [ ] **Step 4: Run tests and OpenAPI** — `pnpm exec vitest run apps/server/src/workspaces.test.ts apps/server/src/cross-workspace.test.ts && pnpm openapi && pnpm openapi:check`. Expected: PASS, no diff.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/server/src/routes/workspaces.ts apps/server/src/workspaces.test.ts apps/server/src/cross-workspace.test.ts apps/web/src/messages/api-errors
git commit -m "feat(api): archive and unarchive projects"
```

### Task 6: Project on preparations and models

**Files:**

- Modify: `packages/contracts/src/data-processing.ts` (`preparationInputSchema`, `modelInputSchema`, `preparationViewSchema`, `modelViewSchema`; new `dataProjectRequestSchema`)
- Modify: `apps/server/src/data/service.ts` (`preparationView` ~171, `modelView` ~182, `savePreparation`, `saveModel`; new `setProject`)
- Modify: `apps/server/src/routes/data.ts` (in the `for (const kind ...)` loop)
- Test: `apps/server/src/data/projects.test.ts`
- Modify: `packages/contracts/openapi.json`

**Interfaces:**

- Consumes: Task 4 columns; `findProject` from `@netrics/database`.
- Produces:
  - Views gain `projectId: z.uuid().nullable()`.
  - Inputs gain `projectId: z.uuid().nullable().optional()`, honoured **only on create** (POST); on PUT it is ignored so a draft save never moves a project.
  - `dataProjectRequestSchema = z.strictObject({ projectId: z.uuid().nullable() })`.
  - `PUT /v1/workspaces/:workspaceId/data/{preparations|models}/:id/project` → `preparationResponseSchema` / `modelResponseSchema`; gated by `data:edit`; does **not** change `version`, `publishedVersion` or `updatedAt`; 404 `project_not_found` for an unknown, other-workspace or archived target project (assigning to an archived project is refused; clearing to null always works); audit `data.preparation_project_changed` / `data.model_project_changed` with `{ from, to }`.
  - Service: `setProject(actor, kind: "preparation" | "model", id: string, projectId: string | null)`.

- [ ] **Step 1: Write the failing tests** `apps/server/src/data/projects.test.ts` (setup as in `data.test.ts`):

```ts
it("creates a preparation in a project and moves it without a new draft", async () => {
  const created = await call("POST", "/preparations", editor, {
    name: "P",
    graph,
    projectId: A,
  });
  expect(created.json().preparation.projectId).toBe(A);
  const { version, publishedVersion } = created.json().preparation;
  const moved = await call("PUT", `/preparations/${id}/project`, editor, {
    projectId: B,
  });
  expect(moved.json().preparation).toMatchObject({
    projectId: B,
    version,
    publishedVersion,
  });
});
it("ignores projectId on a draft save", async () => {
  /* PUT /preparations/:id with projectId: B keeps A */
});
it("refuses another workspace's or an archived project", async () => {
  expect(
    (
      await call("PUT", `/models/${m}/project`, editor, {
        projectId: projectOfW2,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await call("PUT", `/models/${m}/project`, editor, { projectId: archived }))
      .statusCode,
  ).toBe(404);
});
it("refuses viewers", async () => {
  /* 403 */
});
it("keeps the published dashboard's data identical after a project move", async () => {
  // query the model before and after PUT /models/:id/project: same rows, same releaseId
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm exec vitest run apps/server/src/data/projects.test.ts`. Expected: FAIL (`projectId` rejected by strict input).

- [ ] **Step 3: Implement** contracts, views, create handling, `setProject`, routes.

- [ ] **Step 4: Run tests and OpenAPI** — `pnpm exec vitest run apps/server/src/data && pnpm openapi && pnpm openapi:check`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/server/src/data apps/server/src/routes/data.ts
git commit -m "feat(api): a project on models and preparations"
```

### Task 7: Project filter on every list, and the server project navigation checks

**Files:**

- Modify: `packages/contracts/src/index.ts` (new `projectFilterQuerySchema`)
- Modify: `apps/server/src/routes/dashboards.ts` (`GET /dashboards` ~313, `GET /dashboards/published-models` ~154), `apps/server/src/routes/connections.ts` (`GET /connections` ~119), `apps/server/src/routes/data.ts` (`GET /data/sources`, `/data/preparations`, `/data/models`)
- Modify: `packages/database/src/dashboards.ts` (`listDashboards` ~210), `packages/database/src/connections.ts` (`listConnections` ~84), `apps/server/src/dashboards/data.ts` (`publishedModels` ~108), `apps/server/src/data/service.ts` (`listSources` ~1036, `listPreparations`, `listModels`)
- Create: `apps/server/src/project-navigation.test.ts`
- Modify: `packages/contracts/openapi.json`

**Interfaces:**

- Consumes: Task 4 `projectFilterSql`, `ProjectFilter`; Task 6 columns.
- Produces:

```ts
export const projectFilterQuerySchema = z.strictObject({
  project: z.union([z.literal("all"), z.uuid()]).optional(),
  unassigned: z.literal("include").optional(),
});
export type ProjectFilterQuery = z.infer<typeof projectFilterQuerySchema>;
```

- Every route listed above accepts it as `querystring`; absent → unchanged response (backwards compatible; screens, approve page and name lookups keep the full list).
- `listDashboards(tx, workspaceId, filter?: ProjectFilter)`, `listConnections(tx, workspaceId, filter?: ProjectFilter)` — optional parameter, so the other callers (`images/resource-icons.ts`, `dashboards/template-service.ts`, `dashboards/compare-measure.ts`) are untouched.
- `listSources` filters after building items: sources with a `connectionId` follow that connection's `project_id`; `prepared:<id>:<out>` sources follow the preparation's `project_id`; manual and other sources count as unassigned.
- `publishedModels(tx, workspaceId, filter?: ProjectFilter)` filters by `data_models.project_id`.

"Project navigation checks" (spec) = this suite plus the web suite in Task 10. The server suite is table-driven over every filtered list route:

```ts
const LISTS = [
  { path: "/dashboards", pick: (b) => b.dashboards },
  { path: "/connections", pick: (b) => b.connections },
  { path: "/data/preparations", pick: (b) => b.preparations },
  { path: "/data/models", pick: (b) => b.models },
  { path: "/data/sources", pick: (b) => b.sources },
  { path: "/dashboards/published-models", pick: (b) => b.models },
] as const;
```

- [ ] **Step 1: Write the failing suite** `apps/server/src/project-navigation.test.ts`. World: W1 with project A, archived project B, items of every kind in A, in B and unassigned; W2 with the same names. For each entry of `LISTS`:

```ts
it.each(LISTS)("$path follows the project filter", async ({ path, pick }) => {
  expect(names(pick(await list(path, "?project=" + A)))).toEqual(["in A"]);
  expect(
    names(pick(await list(path, `?project=${A}&unassigned=include`))),
  ).toEqual(["in A", "none"]);
  expect(names(pick(await list(path, "?project=all")))).toEqual([
    "in A",
    "none",
  ]); // B archived: hidden
  expect(names(pick(await list(path, "")))).toEqual(["in A", "in B", "none"]); // unchanged default
});
it.each(LISTS)(
  "$path never shows another workspace",
  async ({ path, pick }) => {
    expect(ids(pick(await list(path, "?project=" + projectOfW2)))).toEqual([]);
    expect(
      ids(pick(await list(path, "?project=all"))).some((id) => W2_IDS.has(id)),
    ).toBe(false);
  },
);
it("archiving keeps paired screens working byte for byte", async () => {
  const before = await devicePayload(deviceOnDashboardInA); // GET /v1/device/dashboard for schemas 1, 2, 3
  await archive(A);
  expect(await devicePayload(deviceOnDashboardInA)).toEqual(before);
  expect((await viewDashboard(dashboardInA)).statusCode).toBe(200); // direct link keeps working
});
it("a hard-deleted project's items reappear under All", async () => {
  /* delete A; ?project=all lists them */
});
it("rejects malformed filters", async () => {
  /* ?project=nope → 400 */
});
```

Use the device payload fetch the existing tests use (`apps/server/src/device-payload-v3.test.ts`) for the three schema versions.

- [ ] **Step 2: Run to verify it fails** — `pnpm exec vitest run apps/server/src/project-navigation.test.ts`. Expected: FAIL (query rejected or ignored).

- [ ] **Step 3: Implement** the schema, route querystrings and list filters.

- [ ] **Step 4: Run** — `pnpm exec vitest run apps/server/src/project-navigation.test.ts apps/server/src/dashboards.test.ts apps/server/src/connections.test.ts apps/server/src/data.test.ts && pnpm openapi && pnpm openapi:check`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/server/src packages/database/src
git commit -m "feat(api): project filter on dashboards, connections and data lists"
```

---

## Group C — Projects: switcher, navigation and pickers (web)

One issue and one PR: **"Projects: active project switcher, filtered navigation and pickers"**. Depends on Group B.

### Task 8: Project scope helpers and the shell switcher

**Files:**

- Create: `apps/web/src/lib/project-scope.ts`
- Test: `apps/web/src/lib/project-scope.test.ts`
- Modify: `apps/web/src/lib/api.ts` (`listProjects` ~384, `listConnections` ~401, `listDashboards` ~923; new `setActiveProject`, `archiveProject`, `unarchiveProject`), `apps/web/src/lib/data-api.ts` (`getDataWorkspace` ~48), `apps/web/src/lib/dashboard-data-api.ts` (`loadPublishedModels`), `apps/web/src/lib/use-published-models.ts`
- Modify: `apps/web/src/components/app-shell/app-shell.tsx` (new `ProjectSwitcher` beside `WorkspaceSwitcher` ~182), `apps/web/src/app/workspaces/[workspaceId]/layout.tsx`
- Modify: `apps/web/src/messages/shell/en.ts`, `de.ts`
- Test: `apps/web/src/components/app-shell/app-shell.test.tsx`

**Interfaces:**

- Consumes: Task 5 `archivedAt`, effective `activeProjectId` in `GET /workspaces`; Task 7 `ProjectFilterQuery`.
- Produces:

```ts
// lib/project-scope.ts
export interface ProjectScope { active: string | null; archived: ReadonlySet<string> }
export function projectScope(activeProjectId: string | null, projects: ReadonlyArray<{ id: string; archivedAt: string | null }>): ProjectScope;
/** Lists in navigation: the active project only, or everything not archived. */
export function navigationQuery(scope: ProjectScope): ProjectFilterQuery; // { project: scope.active ?? "all" }
/** Pickers: the active project plus unassigned items, never archived projects. */
export function pickerQuery(scope: ProjectScope): ProjectFilterQuery; // active ? { project: active, unassigned: "include" } : { project: "all" }
/** Client-side twin of pickerQuery for lists that carry projectId; `keep` stays visible (the current value). */
export function inPickerScope(projectId: string | null, scope: ProjectScope, keep?: boolean): boolean;
/** Project choices for a select: not archived, plus the current one if archived. */
export function projectChoices<T extends { id: string; archivedAt: string | null }>(projects: readonly T[], current: string | null): T[];
// lib/api.ts — optional last parameter, appended as a query string
listDashboards(cookieHeader, workspaceId, query?: ProjectFilterQuery);
listConnections(cookieHeader, workspaceId, query?: ProjectFilterQuery);
setActiveProject(workspaceId: string, projectId: string | null): Promise<ActiveProjectResponse>; // browserSend PATCH
archiveProject(workspaceId: string, projectId: string): Promise<ProjectResponse>;
unarchiveProject(workspaceId: string, projectId: string): Promise<ProjectResponse>;
// lib/data-api.ts
getDataWorkspace(workspaceId, cookie?, query?: ProjectFilterQuery);
// AppShellProps gains:
projects: Array<{ id: string; name: string }>; // not archived
activeProjectId: string | null;
```

Switcher: shown only when the workspace has at least one non-archived project; options "All projects" + project names; on change calls `setActiveProject` then `router.refresh()`. The layout loads `listProjects` and passes `projectChoices(projects, null)` and `membership.activeProjectId`. The source-health badge (`sourceCount`, `attention`) stays workspace-wide on purpose: a failing source in another project still needs attention.

Copy (`shell` group): `projectSwitcher` en "Project" / de "Projekt"; `allProjects` en "All projects" / de "Alle Projekte"; `projectSwitchFailed` en "Could not switch the project. Try again." / de "Projekt konnte nicht gewechselt werden. Versuch es noch einmal."

- [ ] **Step 1: Write the failing tests**:

```ts
// project-scope.test.ts
expect(navigationQuery(projectScope(null, projects))).toEqual({
  project: "all",
});
expect(pickerQuery(projectScope(A, projects))).toEqual({
  project: A,
  unassigned: "include",
});
expect(
  inPickerScope(
    B,
    projectScope(null, [{ id: B, archivedAt: "2026-11-14T00:00:00Z" }]),
  ),
).toBe(false);
expect(inPickerScope(B, scopeWithBArchived, true)).toBe(true); // current value kept
expect(inPickerScope(null, projectScope(A, projects))).toBe(true);
expect(projectChoices(withArchived, null).map((p) => p.id)).toEqual([A]);
expect(projectChoices(withArchived, B).map((p) => p.id)).toEqual([A, B]);
// app-shell.test.tsx
it("switches the active project and refreshes", async () => {
  /* select "Alpha" → PATCH body { projectId: A }, router.refresh called */
});
it("hides the switcher without projects", () => {
  /* projects=[] → no "Project" select */
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm exec vitest run apps/web/src/lib/project-scope.test.ts apps/web/src/components/app-shell/app-shell.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** helpers, API functions, switcher, layout wiring and copy.

- [ ] **Step 4: Run** (Step 2 command plus `apps/web/src/lib/i18n/i18n.test.ts`). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib apps/web/src/components/app-shell "apps/web/src/app/workspaces/[workspaceId]/layout.tsx" apps/web/src/messages/shell
git commit -m "feat(web): active project switcher in the app shell"
```

### Task 9: Navigation lists follow the active project

**Files:**

- Modify: `apps/web/src/app/workspaces/[workspaceId]/dashboards/page.tsx`, `dashboards-browser.tsx` (remove `filterByProject`, `NO_PROJECT` and the filter `<select>`), `dashboards-browser.test.tsx`
- Modify: `apps/web/src/app/workspaces/[workspaceId]/sources/page.tsx`
- Modify: `apps/web/src/app/workspaces/[workspaceId]/data/page.tsx`, `apps/web/src/components/data/data-workspace.tsx` (client refresh passes the same query)
- Modify: `apps/web/src/app/workspaces/[workspaceId]/page.tsx` (home: dashboards and connections ~77)
- Modify: `apps/web/src/messages/dashboards/en.ts`, `de.ts` (drop `projectFilter`, `noProject`; add `activeProjectMeta`)

**Interfaces:**

- Consumes: Task 8 `projectScope`, `navigationQuery`, API query parameters.
- Produces: each page computes `const scope = projectScope(membership.activeProjectId, projects)` and lists with `navigationQuery(scope)`. The page header meta names the active project: `activeProjectMeta` en "In {project}" / de "In {project}". New dashboards, preparations and models are created in the active project (`projectId: scope.active` in the create calls; the dashboard create body already accepts `projectId`).

Decision recorded here: the old "No project" filter value has no place in `memberships.active_project_id`, so it goes away; unassigned items show under "All projects".

- [ ] **Step 1: Write the failing tests** — replace the `filterByProject` cases in `dashboards-browser.test.tsx` with: the browser renders exactly the dashboards it is given and shows no project `<select>`; add a page-level test for `navigationQuery` use if the repo has page tests, otherwise assert in `data-workspace.test.tsx` that the client refresh calls `getDataWorkspace` with `{ project: A }` when the active project is A.

- [ ] **Step 2: Run to verify they fail** — `pnpm exec vitest run "apps/web/src/app/workspaces/[workspaceId]/dashboards" apps/web/src/components/data/data-workspace.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** the page changes and copy.

- [ ] **Step 4: Run** (Step 2 command + `apps/web/src/lib/i18n/i18n.test.ts`). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app apps/web/src/components/data apps/web/src/messages/dashboards
git commit -m "feat(web): dashboards, sources and data follow the active project"
```

### Task 10: Pickers, project selects, archive UI and the web project navigation checks

**Files:**

- Modify: `apps/web/src/components/studio-editor/inspector.tsx` (project select ~150), `apps/web/src/components/studio-editor/studio-editor.tsx` (`usePublishedModels` ~172; new `projectScope` prop), `apps/web/src/components/studio-editor/add-widget-menu.tsx` (metric choices by connection), `apps/web/src/app/workspaces/[workspaceId]/dashboards/[dashboardId]/studio/page.tsx`
- Modify: `apps/web/src/app/workspaces/[workspaceId]/screens/screens-view.tsx` (dashboard assignment select), `apps/web/src/app/(site)/devices/approve/page.tsx`
- Modify: `apps/web/src/components/data/preparation-editor.tsx`, `model-editor.tsx` (project select in the header; source picker loads `data/sources` with `pickerQuery`)
- Modify: `apps/web/src/app/workspaces/[workspaceId]/connections/[connectionId]/` settings page (project select; the PATCH body already accepts `projectId`)
- Modify: `apps/web/src/app/workspaces/[workspaceId]/dashboards/page.tsx` projects section (list with Archive / Unarchive, archived projects in their own list)
- Modify: `apps/web/src/messages/{dashboards,data,sources,studio,screens}/{en,de}.ts`
- Create: `apps/web/src/components/project-select.tsx`, `apps/web/src/components/project-select.test.tsx`
- Create: `apps/web/src/project-navigation.test.tsx`

**Interfaces:**

- Consumes: Task 8 helpers; Task 5 archive API; Task 6 `PUT /data/{kind}/:id/project`.
- Produces:

```tsx
export function ProjectSelect(props: {
  projects: ReadonlyArray<{ id: string; name: string; archivedAt: string | null }>;
  value: string | null;
  onChange: (projectId: string | null) => void;
  disabled?: boolean;
}): JSX.Element; // options from projectChoices(projects, value); "No project" = null
// lib/data-api.ts
setDataProject(workspaceId: string, kind: "preparations" | "models", id: string, projectId: string | null): Promise<...>;
```

Pickers in scope (this list is the definition of "every picker"): the Studio inspector project select; the Studio published-model picker (`pickerQuery`); the Studio metric picker (metrics whose connection is `inPickerScope`, the bound one kept); the screens assignment select and the device approve select (dashboards `inPickerScope`, the assigned one kept); the data editors' source picker (`pickerQuery`); the project selects in data editors and connection settings (`projectChoices`). Lookups by id (dashboard names on the screens page, connection names in the Studio) keep the full list so archived items still render on screens and in existing widgets.

Copy: `projects.archive` en "Archive" / de "Archivieren"; `projects.unarchive` en "Unarchive" / de "Aus dem Archiv holen"; `projects.archived` en "Archived" / de "Archiviert"; `projects.archiveHint` en "Archived projects and their items are hidden from lists and pickers. Screens keep showing their dashboards." / de "Archivierte Projekte und ihre Inhalte sind in Listen und Auswahlen ausgeblendet. Bildschirme zeigen ihre Dashboards weiter an."; `project` en "Project" / de "Projekt"; `noProject` en "No project" / de "Kein Projekt".

- [ ] **Step 1: Write the failing tests** — `project-select.test.tsx` (archived project hidden unless current; choosing "No project" calls `onChange(null)`; German labels). `apps/web/src/project-navigation.test.tsx`, the web half of the project navigation checks, table-driven over the picker components with one fixture (projects A active, B archived; items in A, B, none):

```tsx
it.each(PICKERS)(
  "$name shows the active project and unassigned items, never archived ones",
  ({ render }) => {
    render({ scope: projectScope(A, projects) });
    expect(optionNames()).toEqual(["in A", "none"]);
  },
);
it.each(PICKERS)(
  "$name keeps the current value from an archived project",
  ({ render }) => {
    render({ scope: projectScope(null, projects), current: "in B" });
    expect(optionNames()).toContain("in B");
  },
);
```

- [ ] **Step 2: Run to verify they fail** — `pnpm exec vitest run apps/web/src/components/project-select.test.tsx apps/web/src/project-navigation.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** `ProjectSelect`, `setDataProject`, the picker filters, the archive UI (gated by `can(role, "projects:rename")`) and the copy.

- [ ] **Step 4: Run** — `pnpm exec vitest run apps/web && pnpm typecheck && pnpm lint`. Expected: PASS.

- [ ] **Step 5: Check in a real browser** (`pnpm dev`, English and German): pick project A in the shell; dashboards, sources and data show only A's items; the Studio model picker shows A's and unassigned models; archive A on the dashboards page; the shell falls back to "All projects", A's items disappear from lists and pickers; a kiosk paired to A's dashboard keeps showing it; unarchive A and the shell shows A again.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): project-aware pickers, project selects and archiving"
```

---

## Groups and dependencies

| Group | Issue / PR title                                                               | Tasks | Depends on                                                  |
| ----- | ------------------------------------------------------------------------------ | ----- | ----------------------------------------------------------- |
| A     | Impact before publish: dependents of preparations, models and measures         | 1–3   | — (rebase over step-errors / visual-builder editor changes) |
| B     | Projects: project on models and preparations, archive, project filter on lists | 4–7   | — (migration number vs. template-updates plan)              |
| C     | Projects: active project switcher, filtered navigation and pickers             | 8–10  | B                                                           |

## Notes for other plans

- **Template updates** can describe an update with the impact list: call `GET /data/models/:id/impact?measureId=…` for changed measures and `GET /data/preparations/:id/impact` per changed preparation, or server-side `loadImpactGraph(tx, workspaceId)` + `collectDataImpact(graph, target)` from `apps/server/src/data/impact.ts` (one load, many targets). The updated dashboard copies it creates are unassigned from screens, so they appear in `dashboards` but not in `screens` until swapped.
- **Step-attributed errors / visual builder** touch `persist(publish)` in both editors; Task 3 wraps the publish call in a confirmation and leaves error handling as it is.
