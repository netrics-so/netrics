# Milestone 11: Smaller Items and Step-Attributed Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the milestone 11 "smaller items" (preview-route tests, model-editor undo/redo, Google Play ratings source label, docs and ADR addendum) and make processing errors point at the preparation step that caused them.

**Architecture:** `DataProcessingError` gains an optional `nodeId`. `executePreparation` attributes every failure inside a node to that node, unless a deeper node already claimed it. The data routes return `{ error, fieldId?, nodeId? }`. The web client reads this into `ApiError.details`. The preparation editor marks the failing step and the steps that depend on it. Undo/redo moves to one pure history helper that both editors share. It uses the same past/future/edit-key model as Studio (`apps/web/src/lib/studio-document.ts`).

**Tech Stack:** TypeScript, zod 4 (`@netrics/contracts`), Fastify (`apps/server`), Next.js/React (`apps/web`), vitest. Web component tests render static markup (`renderI18n`, no DOM library), so editor behaviour goes into pure helpers that are tested directly.

**Spec:** `docs/milestones/11-completion-design.md` (sections "Step-attributed errors (11C)", "Engine behaviour on failed builds (documentation)", "Smaller items"). Where it is silent, `docs/milestones/11-projects-and-derived-metrics.md` and ADR 0022 apply.

## Global Constraints

- Definition of done (`CLAUDE.md`):
  - One issue per PR with `Closes #N`, branched from `main`.
  - `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` must pass.
  - Run `pnpm openapi:check` when routes or contracts change (`pnpm openapi` regenerates).
  - Check UI changes in a real browser.
  - Squash-merge after green CI.
- Server tests need `NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5433/postgres` (`pnpm db:up`).
- Tenant isolation is enforced twice (RLS plus explicit `workspace_id`). No new query path may skip it.
- Error codes are the API contract. The new error fields are additive and optional, and `error` stays the same code. A response without a step has no `nodeId` key, not `nodeId: undefined` or `""`.
- There is one shared expression AST, `DataExpression`. This plan does not change it.
- Device payloads (schemas 1–3) and the device routes are not touched.
- Every new UI string goes into both `…/en.ts` and `…/de.ts` of its catalog area. German uses the informal "du". `Catalog<typeof dataEn>` and the `compareCatalogs` test in `apps/web/src/lib/i18n/i18n.test.ts` enforce key and argument parity.
- Do not rename connector dataset definitions or their fields without bumping the dataset `version`. A changed definition with the same version fails existing installs with `dataset_schema_version_conflict` (`packages/database/src/datasets.ts:191`). The Play label therefore lives in manifest copy, web catalogs and docs only.
- This repo is public. Do not add production details, IDs or tokens.
- No new dependencies.

## Review Focus

1. **A failure in a branch that a join or append consumes.** "Affected" follows inputs, not list order. A step from an independent branch listed after the failure stays unmarked and previewable. Test: Task 7 `preparationStepStates` join case.
2. **A step error that outlives its graph.** After undo, an edit or a restore, no marker may point at a node that no longer exists or at an older graph. A `nodeId` that is missing from the current graph falls back to the banner. Tests: Task 7 `preparationStepFailure`, plus the graph-signature rule in Task 8.
3. **Innermost attribution.** A failure deep in a chain names the step that failed, never the output that consumed it, and never the step that happens to be selected. Test: Task 4 "keeps the innermost step".
4. **Errors without a step.** Graph-level errors, version conflicts and model previews keep the banner and the exact body `{ error }`. Tests: Task 4 graph-level case, Task 5 `toEqual` on exact bodies.
5. **Undo granularity and stale selection.**
   - Typing in one field undoes as one step.
   - A new edit clears redo.
   - Undoing an added measure drops it from the preview selection, so the preview never requests a deleted measure.

   Tests: Task 9 coalescing and redo-clear tests, Task 10 `keepModelSelection`.

## Task groups (one GitHub issue and one PR each)

| Group | Title                                                       | Tasks   | Depends on                                                                                             |
| ----- | ----------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| G1    | test(server): preparation preview route and isolation tests | 1       | none                                                                                                   |
| G2    | docs: milestone 11 status, completion design, ADR addendum  | 2       | none (reopening #439 is done by the coordinator; it is open as of 2026-11-14)                          |
| G3    | Google Play ratings: label the public Play Store listing    | 3       | none                                                                                                   |
| G4    | Step-attributed processing errors in the engine and API     | 4, 5, 6 | none. G1 and G4 both add `it` blocks to `apps/server/src/data.test.ts`; rebase whichever merges second |
| G5    | Preparation editor shows errors on the failing step         | 7, 8    | G4                                                                                                     |
| G6    | Undo and redo in the model editor                           | 9, 10   | G5 (both edit `preparation-editor.tsx`)                                                                |

The design's order holds: quick items (G1–G3), then step errors (G4, G5), then model-editor undo (G6). G1–G4 can run in parallel.

---

### Task 1: Preparation preview route and isolation tests (G1)

`POST /v1/workspaces/:workspaceId/data/preparations/preview` (`apps/server/src/routes/data.ts:254`) requires `data:preview`, which editors, admins and owners have and viewers do not. It calls `service.previewPreparation` (`apps/server/src/data/service.ts:1829`). This task is tests only. If a test fails, fix the route or service in this PR.

**Files:**

- Modify: `apps/server/src/data.test.ts` (new `it` in `describe("data API authorization and contract")`, after "lets an editor publish reference data, a model and its measures", which sets `datasetId`)
- Modify: `apps/server/src/device-scope.test.ts`:
  - header table (lines 6–13)
  - `datasetId` hoisted to a module-level `let`
  - the `paths()` list at line 750
  - the "no existence oracle" loop at line 818

**Interfaces:**

- Consumes: existing `call`, `editor`, `viewer`, `stranger` and `datasetId` helpers in both files.
- Produces: the `paths()` tuple becomes `[name, method, url, body?, member?]`, where `member?: () => string` returns the cookie expected to get 200. The default is `viewer`.

- [ ] **Step 1: Write the route test in `data.test.ts`**

```ts
it("previews preparation steps for editors without saving anything", async () => {
  const graph = {
    version: 1,
    nodes: [
      { id: "source", type: "source", datasetId },
      {
        id: "doubled",
        type: "calculate",
        input: "source",
        fieldId: "doubled",
        name: "Doubled",
        expression: {
          kind: "call",
          fn: "multiply",
          args: [
            { kind: "field", fieldId: "amount" },
            { kind: "literal", type: "integer", value: 2 },
          ],
        },
      },
    ],
    outputs: ["doubled"],
  };
  const before = (await call("GET", "/preparations", editor)).json();
  const preview = await call("POST", "/preparations/preview", editor, {
    graph,
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const body = preparationPreviewResponseSchema.parse(preview.json());
  expect(body.outputs.doubled!.fields.map((f) => f.id)).toEqual([
    "id",
    "amount",
    "doubled",
  ]);
  expect(body.outputs.doubled!.rows).toHaveLength(1);
  expect((await call("GET", "/preparations", editor)).json()).toEqual(before);
  expect(
    (await call("POST", "/preparations/preview", undefined, { graph }))
      .statusCode,
  ).toBe(401);
  expect(
    (await call("POST", "/preparations/preview", viewer, { graph })).statusCode,
  ).toBe(403);
  expect(
    (await call("POST", "/preparations/preview", stranger, { graph }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await call("POST", "/preparations/preview", editor, {
        graph: { ...graph, outputs: [] },
      })
    ).json(),
  ).toEqual({ error: "invalid_request" });
  expect(
    (
      await call("POST", "/preparations/preview", editor, {
        graph,
        draft: { id: randomUUID(), version: 1 },
      })
    ).json(),
  ).toEqual({ error: "data_preparation_not_found" });
});
```

Import `preparationPreviewResponseSchema` from `@netrics/contracts`.

- [ ] **Step 2: Add the path to the isolation matrix in `device-scope.test.ts`**

  - Hoist `const datasetId` in `beforeAll` to a module-level `let datasetId: string`.
  - Add a `paths()` entry `"preparation preview"`, `"POST"`, `${w()}/data/preparations/preview`, with body `{ graph: { version: 1, nodes: [{ id: "source", type: "source", datasetId }], outputs: ["source"] } }` and member `() => editor`.
  - In the loop, use `(member ?? (() => viewer))()` as the cookie that expects 200.
  - When `member` is set, also assert that `viewer` gets 403.
  - Add an entry to the no-oracle loop: `["POST", \`${mine}/data/preparations/preview\`, graphFor("{id}"), datasetId]`. `graphFor`builds the same body with`datasetId` replaced, so the stranger's foreign and nonexistent dataset ids give equal status and body.
  - Add this row to the header table: `| Preparation preview (#N)              | 404             | 401          | n/a (session only)  |`.

- [ ] **Step 3: Run both files**

Run: `NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5433/postgres pnpm exec vitest run apps/server/src/data.test.ts apps/server/src/device-scope.test.ts`
Expected: PASS. Any failure is a real isolation or route defect. Fix it in `routes/data.ts` or `data/service.ts` and add the fix to this PR.

- [ ] **Step 4: Run the full check and commit**

Run: `pnpm format:check && pnpm lint && pnpm typecheck`

```bash
git add apps/server/src/data.test.ts apps/server/src/device-scope.test.ts
git commit -m "test(server): preparation preview route and isolation tests (#N)"
```

---

### Task 2: Milestone status, design link and ADR 0022 addendum (G2)

**Files:**

- Modify: `docs/milestones/README.md` ("Current status", lines 120–162)
- Modify: `docs/milestones/11-projects-and-derived-metrics.md` (end of "Outcome", lines 11–15; "GitHub tracking", line 154)
- Modify: `docs/decisions/0022-reusable-data-model-and-processing.md` (append after the last addendum)

- [ ] **Step 1: Update the README status**

Set "State on 2026-11-14". In the 2026-11-04 priority bullet, replace "Google Play ingestion and the overall store rating are not implemented." with three statements:

- Google Play ingestion and public listing ratings are implemented (#457, #462).
- An overall cross-store rating is deliberately not computed.
- Add this bullet:

```md
- Milestone 11 ([ADR 0022](../decisions/0022-reusable-data-model-and-processing.md)):
  11A is done (#440). 11B, 11D and 11E are built and tested; the
  remaining engineering work for the gates #441–#444 is designed in
  [the completion design](./11-completion-design.md). The umbrella #439
  stays open until every gate and the owner's real-account acceptance
  (hosted and self-hosted) pass.
```

- [ ] **Step 2: Link the design from the milestone plan**

At the end of the "Outcome" section, add: "The remaining work to close the gates is designed in [11-completion-design.md](./11-completion-design.md) (2026-11-14)." In the umbrella line under "GitHub tracking", add: "Stays open until all gates and the owner's acceptance pass."

- [ ] **Step 3: Append the ADR addendum**

This is fixed copy. It follows the design's "Engine behaviour on failed builds" section and the code in `apps/server/src/data/service.ts`: `data_prepared_generations` at about line 604, and the fallback at about lines 2553–2600.

```md
## Addendum: lazy prepared results and last-valid fallback

Recorded 2026-11-14 with the [milestone 11 completion design](../milestones/11-completion-design.md).
It replaces two sentences of §6, "Build required prepared generations before
atomically switching the active release" and "Failed builds keep the previous
published result with explicit stale/error status", with the behaviour the
code has and the owner accepted.

- Publishing a release does not build its prepared results first. They are
  computed lazily, when a query first needs them, and cached per exact input
  generations.
- When a query's result cannot be computed, the engine falls back to the last
  valid result of the same release and the same query, marked stale: the
  result carries `stale: true`, the failure's `error` code and the warning
  `using_last_valid_source_snapshot`. The fallback reads the input
  generations that result used, re-authorized, within the workspace's
  snapshot policy and expiry.
- A filter combination never queried before has no last valid result: after
  a failure it shows an error rather than stale data.
- Building prepared generations before switching a release is not planned.
```

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec prettier --check docs/milestones docs/decisions && grep -n "11-completion-design" docs/milestones/README.md docs/milestones/11-projects-and-derived-metrics.md docs/decisions/0022-reusable-data-model-and-processing.md`
Expected: prettier passes, and each of the three files has at least one link.

```bash
git add docs/milestones/README.md docs/milestones/11-projects-and-derived-metrics.md docs/decisions/0022-reusable-data-model-and-processing.md
git commit -m "docs: milestone 11 status, completion design link, ADR 0022 addendum (#N)"
```

---

### Task 3: Label Google Play ratings as the public Play Store listing (G3)

Users meet Play ratings in three places:

- the connection's "Rating country" setting (manifest `ratingStorefront`, EN text plus the `de` translation in `packages/connectors/src/google-play/index.ts`)
- the store-template review list (`storeTemplate.ratingsDefinition` in `apps/web/src/messages/dashboards/{en,de}.ts`)
- the connector docs

Dataset and field names stay unchanged (see Global Constraints).

**Files:**

- Modify: `packages/connectors/src/google-play/index.ts`:
  - manifest `description` (line 84) and its `de.description` (line 45)
  - `ratingStorefront.description` (line 108) and its `de` counterpart (line 56)
- Modify: `apps/web/src/messages/dashboards/en.ts:63-64`, `apps/web/src/messages/dashboards/de.ts:65-66`
- Modify: `docs/connectors/google-play.md`: the `store_ratings` row of the datasets table (line 38) and the "Ratings use…" paragraph (line 56)
- Test: `packages/connectors/src/google-play/connector.test.ts`, `apps/web/src/lib/i18n/i18n.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// connector.test.ts, inside describe("public listing scope and availability")
it("names the public Play Store listing as the ratings source in both languages", () => {
  const config = googlePlayManifest.configSchema.properties as Record<
    string,
    { description: string }
  >;
  expect(config.ratingStorefront!.description).toContain(
    "public Play Store listing",
  );
  expect(
    googlePlayManifest.translations!.de!.config!.ratingStorefront!.description,
  ).toContain("öffentlichen Play-Store-Eintrag");
});
// i18n.test.ts, inside describe("web catalogs")
it("names the public Play Store listing as the source of Google Play ratings", () => {
  expect(en.storeTemplate.ratingsDefinition).toContain(
    "public Play Store listing",
  );
  expect(WEB_CATALOGS.de.storeTemplate.ratingsDefinition).toContain(
    "öffentlichen Play-Store-Eintrag",
  );
});
```

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run packages/connectors/src/google-play/connector.test.ts apps/web/src/lib/i18n/i18n.test.ts -t "Play Store listing"`
Expected: FAIL. The texts do not contain the phrase yet.

- [ ] **Step 3: Change the copy**

| Key                               | English                                                                                                                                                                                                                          | German                                                                                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| manifest `description`            | "Install reports, exact earnings lines including fees and refunds, and ratings from the public Play Store listing of your apps. Connect several apps with one Google account."                                                   | "Installationsberichte, genaue Erlöszeilen einschließlich Gebühren und Rückerstattungen sowie Bewertungen aus dem öffentlichen Play-Store-Eintrag deiner Apps. Ein Google-Konto verbindet mehrere Apps."                             |
| `ratingStorefront.description`    | "Two-letter country code, for example US or DE. Defaults to US. Ratings come from the public Play Store listing for this country and its default form factor, not from a Google API."                                            | "Ländercode aus zwei Buchstaben, zum Beispiel DE oder US. Standard: US. Die Bewertungen stammen aus dem öffentlichen Play-Store-Eintrag für dieses Land und den Standard-Gerätetyp, nicht aus einer Google-API."                     |
| `storeTemplate.ratingsDefinition` | "Latest captured score and count for each store listing and country. Scores are never averaged across apps or stores. Google Play ratings come from the public Play Store listing; they are best-effort and may be unavailable." | "Zuletzt erfasste Bewertung und Anzahl je Store-Eintrag und Land. Bewertungen werden nie über Apps oder Stores gemittelt. Google-Play-Bewertungen stammen aus dem öffentlichen Play-Store-Eintrag; sie können ohne Garantie fehlen." |

In the docs, the `store_ratings` row starts "From the public Play Store listing:". The ratings paragraph opens with "**Source: the public Play Store listing.**"

- [ ] **Step 4: Run the tests**

Run: the command from Step 2, then `pnpm exec vitest run packages/connectors/src/translations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/google-play/index.ts packages/connectors/src/google-play/connector.test.ts apps/web/src/messages/dashboards/en.ts apps/web/src/messages/dashboards/de.ts apps/web/src/lib/i18n/i18n.test.ts docs/connectors/google-play.md
git commit -m "feat(google-play): label ratings as the public Play Store listing (#N)"
```

---

### Task 4: Engine attributes failures to the step (G4)

**Files:**

- Modify: `packages/domain/src/data-expression.ts:109-120` (`DataProcessingError`, `dataFail`)
- Modify: `packages/domain/src/data-preparation.ts:394-780` (`executePreparation`)
- Modify: `packages/domain/src/index.ts`, only if `data-expression.ts` exports are listed one by one
- Test: `packages/domain/src/data-processing.test.ts`

**Interfaces:**

- Produces, used by Tasks 5, 6 and 8 and by the visual-builder plan:

  ```ts
  export class DataProcessingError extends Error {
    constructor(
      readonly code: string,
      readonly fieldId?: string,
      /** Id of the preparation step (PreparationNode.id) whose work failed. */
      readonly nodeId?: string,
    );
  }
  export function dataFail(code: string, fieldId?: string, nodeId?: string): never;
  /** `error` attributed to `nodeId`, unless it is not a DataProcessingError or a deeper step already claimed it (then `error` itself). */
  export function attributeDataError(error: unknown, nodeId: string): unknown;
  ```

  The `message` stays `code` or `code: fieldId`.

- [ ] **Step 1: Write the failing tests**

Import `DataProcessingError` and `attributeDataError` from `./data-expression.js`.

```ts
describe("step attribution", () => {
  const source = { id: "source", type: "source", datasetId: "orders" } as const;
  const broken = {
    id: "calc",
    type: "calculate",
    input: "source",
    fieldId: "net",
    name: "Net",
    expression: call("add", field("missing"), lit("integer", 1)),
  } as const;
  const failure = (graph: PreparationGraph) => {
    try {
      executePreparation(graph, sources);
    } catch (error) {
      return error as DataProcessingError;
    }
    throw new Error("expected a failure");
  };
  const where = (e: DataProcessingError) => [e.code, e.fieldId, e.nodeId];
  it("names the step and column whose work failed", () => {
    expect(
      where(
        failure({ version: 1, nodes: [source, broken], outputs: ["calc"] }),
      ),
    ).toEqual(["expression_field_not_found", "missing", "calc"]);
  });
  it("keeps the innermost step when later steps consume the failure", () => {
    const kept = {
      id: "kept",
      type: "filter",
      input: "calc",
      expression: lit("boolean", true),
    } as const;
    expect(
      failure({ version: 1, nodes: [source, broken, kept], outputs: ["kept"] })
        .nodeId,
    ).toBe("calc");
  });
  it("attributes a missing input to the step that refers to it", () => {
    const append = {
      id: "both",
      type: "append",
      inputs: ["source", "ghost"],
    } as const;
    expect(
      where(
        failure({ version: 1, nodes: [source, append], outputs: ["both"] }),
      ),
    ).toEqual(["preparation_input_not_found", undefined, "both"]);
  });
  it("names a duplicated step and a source whose dataset is missing", () => {
    expect(
      failure({ version: 1, nodes: [source, source], outputs: ["source"] })
        .nodeId,
    ).toBe("source");
    expect(
      where(
        failure({
          version: 1,
          nodes: [{ ...source, datasetId: "nowhere" }],
          outputs: ["source"],
        }),
      ),
    ).toEqual(["preparation_source_not_found", undefined, "source"]);
  });
  it("leaves graph-level failures without a step", () => {
    const error = failure({ version: 1, nodes: [source], outputs: [] });
    expect(error.code).toBe("preparation_graph_invalid");
    expect(error.nodeId).toBeUndefined();
  });
  it("never re-attributes an already attributed error or foreign errors", () => {
    const deep = new DataProcessingError("x", undefined, "inner");
    expect(attributeDataError(deep, "outer")).toBe(deep);
    const other = new Error("x");
    expect(attributeDataError(other, "outer")).toBe(other);
    expect(
      (
        attributeDataError(
          new DataProcessingError("x", "f"),
          "outer",
        ) as DataProcessingError
      ).nodeId,
    ).toBe("outer");
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run packages/domain/src/data-processing.test.ts -t "step attribution"`
Expected: FAIL. `attributeDataError` is not exported.

- [ ] **Step 3: Implement**

- In `data-expression.ts`, add the third constructor parameter, the third `dataFail` parameter and `attributeDataError`. `attributeDataError` returns a new `DataProcessingError(code, fieldId, nodeId)` and never mutates the original.
- In `executePreparation`:
  - Pass the duplicated id to `preparation_node_duplicate`: the first id seen twice.
  - In `execute(id)`, wrap everything from `visiting.add(id)` through `onNode?.(node, output)` in `try { … } catch (error) { throw attributeDataError(error, id); }`.
  - The `node` lookup and the cycle check stay outside the wrapper. A missing or cyclic input is then attributed by the consumer's wrapper.
  - The cast step's own `catch` stays inside the node and is unchanged.

- [ ] **Step 4: Run the domain tests**

Run: `pnpm exec vitest run packages/domain`
Expected: PASS, including the existing cast, append and join tests.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/data-expression.ts packages/domain/src/data-preparation.ts packages/domain/src/data-processing.test.ts
git commit -m "feat(domain): attribute processing errors to the failing preparation step (#N)"
```

---

### Task 5: API returns the step and column (G4)

**Files:**

- Modify: `packages/contracts/src/data-processing.ts` (add the schema next to `preparationPreviewResponseSchema`, line 436)
- Modify: `apps/server/src/data/service.ts`:
  - `DataServiceError` (line 62)
  - `executeGraph` (lines 1215–1228)
- Modify: `apps/server/src/routes/data.ts`:
  - `execute` (lines 39–57)
  - `doc` (lines 66–73)
- Regenerate: `packages/contracts/openapi.json`
- Test: `apps/server/src/data.test.ts`

**Interfaces:**

- Consumes: `DataProcessingError.nodeId` and `attributeDataError` (Task 4).
- Produces:

  ```ts
  // @netrics/contracts
  export const dataErrorResponseSchema = errorResponseSchema.extend({
    fieldId: z.string().min(1).max(240).optional(),
    nodeId: z.string().min(1).max(240).optional(),
  });
  export type DataErrorResponse = z.infer<typeof dataErrorResponseSchema>;
  // apps/server/src/data/service.ts
  export class DataServiceError extends Error {
    constructor(code: string, status?: 400 | 404 | 409 | 413 | 503, readonly nodeId?: string);
  }
  ```

  The data routes answer `400` for a `DataProcessingError` with `{ error: code, fieldId?, nodeId? }`. They answer `DataServiceError` with its status and `{ error: code, nodeId? }`. Keys are present only when set.

- [ ] **Step 1: Write the failing test** (in `describe("data API authorization and contract")`, after the publish test)

```ts
it("attributes preview and publish failures to the failing step", async () => {
  const graph = {
    version: 1,
    nodes: [
      { id: "source", type: "source", datasetId },
      {
        id: "calc",
        type: "calculate",
        input: "source",
        fieldId: "net",
        name: "Net",
        expression: { kind: "field", fieldId: "missing" },
      },
      {
        id: "kept",
        type: "filter",
        input: "calc",
        expression: { kind: "literal", type: "boolean", value: true },
      },
    ],
    outputs: ["kept"],
  };
  const located = {
    error: "expression_field_not_found",
    fieldId: "missing",
    nodeId: "calc",
  };
  const preview = await call("POST", "/preparations/preview", editor, {
    graph,
  });
  expect([preview.statusCode, preview.json()]).toEqual([400, located]);
  const gone = await call("POST", "/preparations/preview", editor, {
    graph: {
      version: 1,
      nodes: [{ id: "source", type: "source", datasetId: randomUUID() }],
      outputs: ["source"],
    },
  });
  expect([gone.statusCode, gone.json()]).toEqual([
    404,
    { error: "data_source_not_found", nodeId: "source" },
  ]);
  const saved = await call("POST", "/preparations", editor, {
    name: "Broken",
    graph,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const published = await call(
    "POST",
    `/preparations/${saved.json().preparation.id}/publish`,
    editor,
    { version: 1 },
  );
  expect([published.statusCode, published.json()]).toEqual([400, located]);
  const conflict = await call(
    "POST",
    `/preparations/${saved.json().preparation.id}/publish`,
    editor,
    { version: 7 },
  );
  expect([conflict.statusCode, conflict.json()]).toEqual([
    409,
    { error: "version_conflict" },
  ]);
});
```

- [ ] **Step 2: Run it**

Run: `NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5433/postgres pnpm exec vitest run apps/server/src/data.test.ts -t "attributes preview and publish failures"`
Expected: FAIL. The body is `{ error: "expression_field_not_found" }` only.

- [ ] **Step 3: Implement**

- Add `dataErrorResponseSchema` to contracts.
- `DataServiceError` gets a third optional parameter `nodeId`.
- In `executeGraph`, load each source node in `try/catch`:
  - Rethrow a `DataServiceError` as `new DataServiceError(code, status, n.id)` if it has no `nodeId` yet.
  - Rethrow anything else through `attributeDataError(error, n.id)`.
- In `routes/data.ts`, add a local `sendDataError(reply, status, code, location: { fieldId?: string; nodeId?: string })` that sends `dataErrorResponseSchema.parse({ error: code, ...location })` and omits undefined keys. Use it in `execute` for both error classes.
- Give `doc()` `errorSchemas: { 400: contracts.dataErrorResponseSchema, 404: contracts.dataErrorResponseSchema }`. The compare-measure routes keep their own `errorSchemas`.

- [ ] **Step 4: Regenerate OpenAPI and run the server data tests**

Run: `pnpm openapi && pnpm openapi:check && NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5433/postgres pnpm exec vitest run apps/server/src/data.test.ts apps/server/src/compare-measure.test.ts`
Expected: PASS. The `openapi.json` diff only adds `fieldId`/`nodeId` to data-route 400/404 bodies.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/data-processing.ts packages/contracts/openapi.json apps/server/src/data/service.ts apps/server/src/routes/data.ts apps/server/src/data.test.ts
git commit -m "feat(server): return the failing step and column with data errors (#N)"
```

---

### Task 6: Web client reads the step and column (G4)

**Files:**

- Modify: `apps/web/src/lib/api.ts`:
  - `ApiError.details` type (line 200)
  - `readError` (lines 263–271)
- Modify: `apps/web/src/lib/data-editing.ts` (next to `dataErrorKey`, line 90)
- Test: `apps/web/src/lib/data-editing.test.ts`

**Interfaces:**

- Consumes: `dataErrorResponseSchema` and `DataErrorResponse` (Task 5). `DataProcessingError.nodeId` (Task 4).
- Produces:

  ```ts
  // api.ts
  details: Omit<ThemeErrorResponse & DataErrorResponse, "error">;
  // data-editing.ts
  export interface DataErrorLocation {
    nodeId?: string;
    fieldId?: string;
  }
  export function dataErrorLocation(error: unknown): DataErrorLocation;
  ```

- [ ] **Step 1: Write the failing test**

```ts
describe("data error location", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reads the failing step and column from API and engine errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "expression_field_not_found",
            fieldId: "missing",
            nodeId: "calc",
          },
          { status: 400 },
        ),
      ),
    );
    const failure = await previewPreparation("w", {
      version: 1,
      nodes: [{ id: "source", type: "source", datasetId: "s" }],
      outputs: ["source"],
    }).catch((error: unknown) => error);
    expect(dataErrorLocation(failure)).toEqual({
      nodeId: "calc",
      fieldId: "missing",
    });
    expect(dataErrorKey(failure)).toBe("field");
    expect(dataErrorLocation(new DataProcessingError("x", "f", "n"))).toEqual({
      nodeId: "n",
      fieldId: "f",
    });
    expect(dataErrorLocation(new Error("x"))).toEqual({});
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm exec vitest run apps/web/src/lib/data-editing.test.ts -t "data error location"`
Expected: FAIL. `dataErrorLocation` is not exported.

- [ ] **Step 3: Implement**

`readError` parses with `themeErrorResponseSchema.extend(dataErrorResponseSchema.shape)`, so `fieldId` and `nodeId` reach `details` instead of being stripped. `dataErrorLocation` reads `ApiError.details` or the `DataProcessingError` fields and returns only the keys that are set.

- [ ] **Step 4: Run the web lib tests**

Run: `pnpm exec vitest run apps/web/src/lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/data-editing.ts apps/web/src/lib/data-editing.test.ts
git commit -m "feat(web): read the failing step and column from data errors (#N)"
```

---

### Task 7: Step states and the step list (G5)

**Files:**

- Modify: `apps/web/src/lib/preparation-editing.ts`
- Create: `apps/web/src/components/data/preparation-step-list.tsx`
- Modify: `apps/web/src/app/styles/data.css` (styles for `.data-step-list li[data-state]`)
- Modify: `apps/web/src/messages/data/en.ts`, `apps/web/src/messages/data/de.ts` (inside `data`, next to `steps`)
- Test: `apps/web/src/lib/preparation-editing.test.ts`, `apps/web/src/components/data/preparation-step-list.test.tsx` (new)

**Interfaces:**

- Consumes: `DataErrorLocation` (Task 6). The existing `preparationStepInputs(node)`.
- Produces:

  ```ts
  // preparation-editing.ts
  export type PreparationStepState = "failed" | "affected";
  /** The failed step and every step that reads its result, directly or through others. Empty if the step is not in the graph. */
  export function preparationStepStates(
    graph: PreparationGraph,
    failedNodeId: string,
  ): Map<string, PreparationStepState>;
  /** The location if its step exists in `graph`, else null (the caller falls back to the banner). */
  export function preparationStepFailure(
    location: DataErrorLocation,
    graph: PreparationGraph,
  ): { nodeId: string; fieldId?: string } | null;
  // preparation-step-list.tsx
  export function PreparationStepList(props: {
    nodes: PreparationNode[];
    selected: string;
    states: ReadonlyMap<string, PreparationStepState>;
    /** Translated message for the failed step, and the column it names (display name, or id when unknown). */
    failure: { message: string; column?: string } | null;
    label: (node: PreparationNode) => { title: string; detail?: string };
    disabled: boolean;
    onSelect: (nodeId: string) => void;
  }): JSX.Element;
  ```

Catalog keys (`data.*`):

| Key                   | English                                                                                 | German                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `stepStatus.failed`   | "Failed"                                                                                | "Fehlgeschlagen"                                                                                                                   |
| `stepStatus.affected` | "Affected"                                                                              | "Betroffen"                                                                                                                        |
| `stepFailed`          | "This step failed. {message}"                                                           | "Dieser Schritt ist fehlgeschlagen. {message}"                                                                                     |
| `stepFailedColumn`    | "Column: {column}"                                                                      | "Spalte: {column}"                                                                                                                 |
| `stepAffected`        | "Not checked: this step uses the result of a failed step. Earlier steps still preview." | "Nicht geprüft: Dieser Schritt verwendet das Ergebnis eines fehlgeschlagenen Schritts. Frühere Schritte kannst du weiter ansehen." |

- [ ] **Step 1: Write the failing helper tests** (`preparation-editing.test.ts`)

```ts
describe("step states after a failure", () => {
  const graph: PreparationGraph = {
    version: 1,
    nodes: [
      { id: "a", type: "source", datasetId: "s1" },
      {
        id: "b",
        type: "calculate",
        input: "a",
        fieldId: "x",
        name: "X",
        expression: { kind: "literal", type: "integer", value: 1 },
      },
      {
        id: "c",
        type: "filter",
        input: "b",
        expression: { kind: "literal", type: "boolean", value: true },
      },
      { id: "d", type: "source", datasetId: "s2" },
      {
        id: "e",
        type: "join",
        left: "c",
        right: "d",
        keys: [{ left: "x", right: "x" }],
        mode: "left",
        cardinality: "many_to_one",
        rightPrefix: "r.",
      },
      { id: "f", type: "select", input: "d", fields: ["x"] },
    ],
    outputs: ["e", "f"],
  };
  it("marks the failed step and everything that reads it, across joins", () => {
    expect(Object.fromEntries(preparationStepStates(graph, "b"))).toEqual({
      b: "failed",
      c: "affected",
      e: "affected",
    });
  });
  it("marks nothing for a step that is not in the graph", () => {
    expect(preparationStepStates(graph, "gone").size).toBe(0);
  });
  it("keeps a location only when its step exists", () => {
    expect(
      preparationStepFailure({ nodeId: "b", fieldId: "x" }, graph),
    ).toEqual({ nodeId: "b", fieldId: "x" });
    expect(preparationStepFailure({ nodeId: "gone" }, graph)).toBeNull();
    expect(preparationStepFailure({ fieldId: "x" }, graph)).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing component test** (`preparation-step-list.test.tsx`, static markup in both languages)

```tsx
it.each([
  [
    "en",
    "Failed",
    "This step failed. A referenced column is unavailable.",
    "Column: Net",
    "Affected",
  ],
  [
    "de",
    "Fehlgeschlagen",
    "Dieser Schritt ist fehlgeschlagen.",
    "Spalte: Net",
    "Betroffen",
  ],
] as const)(
  "shows the failure on its step and marks later steps (%s)",
  (locale, failed, message, column, affected) => {
    const html = renderI18n(
      <PreparationStepList
        nodes={graph.nodes}
        selected="a"
        states={preparationStepStates(graph, "b")}
        failure={{
          message:
            locale === "en" ? "A referenced column is unavailable." : "x",
          column: "Net",
        }}
        label={(node) => ({ title: node.id })}
        disabled={false}
        onSelect={() => {}}
      />,
      locale,
    );
    expect(html).toContain('data-state="failed"');
    expect(html).toContain(failed);
    expect(html).toContain(message);
    expect(html).toContain(column);
    expect(html.match(/data-state="affected"/g)).toHaveLength(2);
    expect(html).toContain(affected);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>\s*<span>a</); // earlier steps stay usable
  },
);
```

The fixture `graph` is the one from Step 1, exported from a shared test-local constant or repeated.

- [ ] **Step 3: Run both**

Run: `pnpm exec vitest run apps/web/src/lib/preparation-editing.test.ts apps/web/src/components/data/preparation-step-list.test.tsx`
Expected: FAIL. The exports are missing.

- [ ] **Step 4: Implement**

- `preparationStepStates`: build a reverse-input map from `preparationStepInputs`, then breadth-first search from the failed id.
- `PreparationStepList` keeps today's markup: `ol.data-step-list > li > button[aria-current]` with `<span>` title and `<small>` detail.
- A failed or affected `li` gets `data-state`, plus a `<small>` with the `stepStatus.*` text.
- The failed step adds `<p className="error" role="alert">`. It holds `stepFailed` with `message`, followed by `stepFailedColumn` when `column` is set.
- Affected steps add `<p className="help">{stepAffected}</p>`.
- Buttons are disabled only by `disabled`, never by state.
- In `data.css`, a failed step gets the error colour token's left border, and an affected step gets a muted dashed one. Reuse existing CSS variables.

- [ ] **Step 5: Run the tests and catalog parity**

Run: the Step 3 command, then `pnpm exec vitest run apps/web/src/lib/i18n/i18n.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/preparation-editing.ts apps/web/src/lib/preparation-editing.test.ts apps/web/src/components/data/preparation-step-list.tsx apps/web/src/components/data/preparation-step-list.test.tsx apps/web/src/app/styles/data.css apps/web/src/messages/data/en.ts apps/web/src/messages/data/de.ts
git commit -m "feat(web): step states and step list for attributed errors (#N)"
```

---

### Task 8: Preparation editor wiring (G5)

**Files:**

- Modify: `apps/web/src/components/data/preparation-editor.tsx`
- Test: browser check (static render cannot reach error states; the logic is pinned by Task 7)

**Interfaces:**

- Consumes: `dataErrorLocation` (Task 6), `preparationStepStates`, `preparationStepFailure` and `PreparationStepList` (Task 7).
- Produces: `changeGraph(next, output, changedIds: string[])`. Task 9 keeps this signature.

Behaviour, decided here because the design leaves it open:

1. **New state.** `stepError: { graph: string; nodeId: string; fieldId?: string; key: string } | null`. Here `graph` is `JSON.stringify` of the graph that failed and `key` is `dataErrorKey(failure)`. The editor renders it only while `graph === JSON.stringify(currentGraph)`. That covers undo, edits and restore without extra clearing.
2. **`show()` failures.**
   - When `preparationStepFailure(dataErrorLocation(failure), next)` is non-null, set `stepError` instead of the banner `error`.
   - With `validateAll`, if the failed node is not in `preparationAt(next, output).nodes`, still preview `preparationAt(next, output)`. Earlier and independent steps then keep a usable preview. Otherwise clear the preview.
   - A successful `validateAll` preview clears `stepError`. A successful single-output preview does not clear it, because it checked only a subgraph.
   - Unattributed failures keep the banner.
3. **`changeGraph(next, output, changedIds)`.**
   - If `show` fails with a step failure whose `nodeId` is **not** in `changedIds`, apply `next` anyway: record history, `setGraph(next)` and return normally. The broken later step is then marked and can be fixed or undone.
   - Otherwise rethrow, as today. The StepForm shows the error and the graph is unchanged.
   - Callers pass these `changedIds`:
     - StepForm edit: `[editing.node.id]`
     - add: ids of the appended nodes
     - move: `[selected]`
     - remove: `[]`
4. **Other entry points.** The initial load and undo call `show(graph, output, true)`, so errors in other branches are found.
5. **Publishing.**
   - The Publish button is also disabled while a rendered `stepError` exists.
   - `persist` failures go through the same attribution, because a publish can fail at a step.
   - Saving a draft with a marked step stays allowed. Drafts are not live, and publish validates.
6. **Step list.**
   - Replace the inline `<ol className="data-step-list">` with `PreparationStepList`.
   - `failure.message` is `t(\`errors.${stepError.key}\`)`.
   - `column` is the field's name from the current preview `fields`, or else the raw `fieldId`.
   - `label` reuses the existing source-name/type logic, with the calculate name as `detail`.

- [ ] **Step 1: Implement the wiring above**

- [ ] **Step 2: Typecheck and run the web tests**

Run: `pnpm --filter @netrics/web typecheck && pnpm exec vitest run apps/web`
Expected: PASS.

- [ ] **Step 3: Check in a real browser** (`pnpm dev`, English and German UI)

  1. Make a preparation on a manual table: source → calculate `net` → filter `net > 0`.
  2. Select the filter and choose "Move step earlier". The filter is marked Failed with "Column: …". The calculate step is marked Affected.
  3. The source step still previews when clicked. Publish is disabled.
  4. Undo removes both marks.
  5. Edit the calculate step to reference a missing column. The error stays in the step form and the graph is unchanged.
  6. Switch the UI to German and repeat step 2.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/data/preparation-editor.tsx
git commit -m "feat(web): show processing errors on the failing preparation step (#N)"
```

---

### Task 9: Shared edit history; Redo in the preparation editor (G6)

The preparation editor has Undo only (`history: PreparationGraph[]`, lines 83, 248, 307–311, 486–509). The design asks for model-editor undo/redo "matching the preparation editor". Both editors therefore move to one helper and both get Redo. The helper copies Studio's semantics: `past`/`future`, an edit key that coalesces typing, and a 100-entry limit (`studio-document.ts:105-109, 238, 800-815`).

**Files:**

- Create: `apps/web/src/lib/edit-history.ts`
- Test: `apps/web/src/lib/edit-history.test.ts`
- Modify: `apps/web/src/components/data/preparation-editor.tsx`
- Modify: `apps/web/src/messages/data/en.ts`, `de.ts` (add `redo` next to `undo`)

**Interfaces:**

- Produces (used by Task 10):

  ```ts
  export const EDIT_HISTORY_LIMIT = 100;
  export interface EditHistory<T> {
    past: T[];
    present: T;
    future: T[];
    lastEditKey: string | null;
  }
  export function startHistory<T>(present: T): EditHistory<T>;
  /** New present; pushes the old one unless `editKey` equals the previous edit's key. Always clears `future`. */
  export function recordEdit<T>(
    history: EditHistory<T>,
    next: T,
    editKey?: string | null,
  ): EditHistory<T>;
  export function undoEdit<T>(history: EditHistory<T>): EditHistory<T>; // unchanged when past is empty
  export function redoEdit<T>(history: EditHistory<T>): EditHistory<T>; // unchanged when future is empty
  /** Replaces present without an undo step (save normalisation); keeps past and future, resets lastEditKey. */
  export function replacePresent<T>(
    history: EditHistory<T>,
    present: T,
  ): EditHistory<T>;
  ```

  Catalog: `redo`. English "Redo", German "Wiederholen", matching the Studio catalog.

- [ ] **Step 1: Write the failing tests**

```ts
describe("edit history", () => {
  it("undoes and redoes in order and clears redo on a new edit", () => {
    let h = recordEdit(recordEdit(startHistory(1), 2), 3);
    h = undoEdit(undoEdit(h));
    expect([h.present, h.future]).toEqual([1, [3, 2]]);
    h = redoEdit(h);
    expect(h.present).toBe(2);
    h = recordEdit(h, 9);
    expect([h.present, h.future, h.past]).toEqual([9, [], [1, 2]]);
  });
  it("coalesces consecutive edits with the same key into one undo step", () => {
    let h = startHistory("");
    for (const text of ["N", "Ne", "Net"])
      h = recordEdit(h, text, "measure:m1:name");
    h = recordEdit(h, "Net!", "measure:m2:name");
    expect(undoEdit(h).present).toBe("Net");
    expect(undoEdit(undoEdit(h)).present).toBe("");
  });
  it("is a no-op at either end and keeps at most 100 steps", () => {
    const h = startHistory(0);
    expect(undoEdit(h)).toBe(h);
    expect(redoEdit(h)).toBe(h);
    let long = h;
    for (let i = 1; i <= 150; i++) long = recordEdit(long, i);
    expect(long.past).toHaveLength(EDIT_HISTORY_LIMIT);
    expect(long.past[0]).toBe(50);
  });
  it("replaces the present without an undo step", () => {
    const h = replacePresent(recordEdit(startHistory(1), 2, "k"), 3);
    expect([h.past, h.present, h.lastEditKey]).toEqual([[1], 3, null]);
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run apps/web/src/lib/edit-history.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement `edit-history.ts`, then switch the preparation editor**

- `graph` becomes `history.present`.
- `changeGraph` and `changeSource` use `recordEdit` without a key.
- `restore` uses `startHistory(next.graph)`.
- The Undo button uses `undoEdit`. Add a Redo button right after it that uses `redoEdit`, with the same `disabled` conditions as Undo but checking `future.length`.
- Both buttons re-preview with `show(present, present.outputs[0], true)`.

- [ ] **Step 4: Add a static render assertion and run the tests**

Add to the new `apps/web/src/components/data/preparation-step-list.test.tsx`, or to a new `preparation-editor.test.tsx`. Render `PreparationEditor` with `initial={null}` in `en` and `de`. Assert `<button type="button" disabled="">Undo</button>` and `…Redo</button>` (German: `Rückgängig`, `Wiederholen`).
Run: `pnpm exec vitest run apps/web/src/lib/edit-history.test.ts apps/web/src/components/data`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/edit-history.ts apps/web/src/lib/edit-history.test.ts apps/web/src/components/data/preparation-editor.tsx apps/web/src/components/data/*.test.tsx apps/web/src/messages/data/en.ts apps/web/src/messages/data/de.ts
git commit -m "feat(web): shared edit history with redo in the preparation editor (#N)"
```

---

### Task 10: Undo and redo in the model editor (G6)

**Files:**

- Modify: `apps/web/src/components/data/model-editor.tsx`:
  - state at lines 90–91
  - `change` at line 128
  - `persist` at line 207
  - `restore` at line 256
  - formula text setter at line 1005
  - header actions at about line 380
- Modify: `apps/web/src/lib/model-measures.ts`
- Test: `apps/web/src/lib/model-measures.test.ts`, `apps/web/src/components/data/model-editor.test.tsx`

**Interfaces:**

- Consumes: `startHistory`, `recordEdit`, `undoEdit`, `redoEdit` and `replacePresent` (Task 9).
- Produces:

  ```ts
  // model-measures.ts
  /** Drops selected measures and grouped dimensions that the definition no longer has. */
  export function keepModelSelection(
    definition: SemanticModelDefinition,
    measureIds: string[],
    groupBy: string[],
  ): { measureIds: string[]; groupBy: string[] };
  ```

  Inside the editor, the history holds `{ definition: SemanticModelDefinition; formulaTexts: Record<string, string> }`. The model name stays outside the history, as the preparation name does.

- [ ] **Step 1: Write the failing tests**

```ts
// model-measures.test.ts
it("drops selections the definition no longer has after undo", () => {
  expect(
    keepModelSelection(
      definition([revenue]),
      ["revenue", "gone"],
      ["app", "removed"],
    ),
  ).toEqual({
    measureIds: ["revenue"],
    groupBy: ["app"],
  });
});
// model-editor.test.tsx
it.each([
  ["en", "Undo", "Redo"],
  ["de", "Rückgängig", "Wiederholen"],
] as const)(
  "offers disabled undo and redo before any edit (%s)",
  (locale, undo, redo) => {
    const html = render([revenue], locale);
    expect(html).toContain(
      `<button type="button" disabled="">${undo}</button>`,
    );
    expect(html).toContain(
      `<button type="button" disabled="">${redo}</button>`,
    );
  },
);
```

`model-measures.test.ts` needs a small `definition`/`revenue` fixture, mirroring `model-editor.test.tsx`.

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run apps/web/src/lib/model-measures.test.ts apps/web/src/components/data/model-editor.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Replace the `definition`/`formulaTexts` `useState` pair with one `EditHistory` state.
- `change(patch, editKey?)` records a functional update.
- Every `change`/`changeMeasure` call bound to a text `<input>` or `<textarea>` passes the key `` `${kind}:${id}:${property}` `` (for example `measure:${measure.id}:name`). Selects, checkboxes and buttons pass none.
- The formula textarea setter records with `` `formula:${id}` ``.
- `persist` uses `replacePresent` for the normalised model. `restore` uses `startHistory`.
- Add Undo and Redo buttons to the header `data-form-actions`, before Save. They are disabled when `busy`, `inputMetadata.loading` or `inputMetadata.error` is set, or when there is no past (Undo) or no future (Redo).
- After undo or redo, apply `keepModelSelection` to `measureIds` and `groupBy`, and clear `notice`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @netrics/web typecheck && pnpm exec vitest run apps/web`
Expected: PASS.

- [ ] **Step 5: Check in a real browser** (English and German)

  1. Add a measure, type a name, and change its aggregation.
  2. Undo three times: the aggregation reverts, then the whole name, then the measure is removed and no longer selected for preview.
  3. Redo twice.
  4. Preview works after each step.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/data/model-editor.tsx apps/web/src/components/data/model-editor.test.tsx apps/web/src/lib/model-measures.ts apps/web/src/lib/model-measures.test.ts
git commit -m "feat(web): undo and redo in the model editor (#N)"
```

---

## Self-review notes

- **Spec coverage.**

  | Design item                                                            | Tasks                |
  | ---------------------------------------------------------------------- | -------------------- |
  | Preview-route tests                                                    | Task 1               |
  | Docs and ADR addendum                                                  | Task 2               |
  | Reopening #439                                                         | coordinator, G2 note |
  | Play label                                                             | Task 3               |
  | Error carries step id; execution and validation set it                 | Task 4               |
  | API returns it with code and field                                     | Tasks 5, 6           |
  | Editor shows it on the step, marks later steps, keeps earlier previews | Tasks 7, 8           |
  | Codes keep translated messages; banner only without a step             | Tasks 6, 8           |
  | Model-editor undo/redo                                                 | Tasks 9, 10          |

- **Out of scope here:** the end-to-end UI test of the 11C journey (design item 6) belongs to the visual-builder/E2E plan. It should cover the step-error flow of Task 8.
- **Interface for other plans:**
  - `DataProcessingError.nodeId` is the `PreparationNode.id`.
  - The API body is `dataErrorResponseSchema` `{ error, fieldId?, nodeId? }`.
  - The web reads it with `dataErrorLocation`.
  - The step list renders it with `PreparationStepList`.
