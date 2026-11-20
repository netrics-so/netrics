# Custom API foundation (milestone 13, plan F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the dataset transport the `custom-api` connector will emit as "dataset contract v1" (documented, with compatibility tests and the new field role `image`), and harden the connector egress guard so a user-written definition cannot reach private networks, metadata services, rebound DNS names, foreign redirect targets or unbounded bodies.

**Architecture:** Two independent groups, one issue and one PR each, both parallel with C-G1. F-G1 adds `role?: "image"` to `datasetFieldSchema` (SDK 0.2.17), carries it through the domain `DataField` and the preparation engine with explicit keep/drop rules, exposes it in the data API, and writes the contract as an ADR backed by fixture-based compatibility tests at the SDK and database layers. F-G2 extends `createEgressFetch` in place (no second HTTP client): DNS results pinned per egress instance, an `allowPrivateHosts` escape hatch for self-hosters that never covers metadata addresses, `"same-host"` redirect mode and credential stripping on cross-origin hops, a decompressed-size limit, a per-request timeout with its own retryable error, and an SSRF suite; the server reads `NETRICS_CUSTOM_API_PRIVATE_HOSTS` into its config for C-G3 to use. Every new option defaults to today's behaviour.

**Tech Stack:** TypeScript, zod 4 (`@netrics/connector-sdk`, `@netrics/contracts`), undici 8 (`fetch` with a custom `Agent`), Node 26 `node:net`/`node:dns`/`node:zlib`, drizzle + PostgreSQL (database tests), vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-custom-api-connector-design.md` — sections 5 (Execution and safety), 8 (image field role) and 9 (Dataset contract freeze), the anti-goals, and exit gate 6. Cross-plan names: `docs/superpowers/plans/2026-11-20-m13-overview.md` ("Dataset field role", "Egress", "Fixture server").

## Global Constraints

- Field role: `role?: "image"` on `datasetFieldSchema`, SDK version `0.2.17`; "it stays a `string` field (the URL) with the field role `image`". Preparations "keep it on select/rename/filter/append/join pass-through and drop it on calculated or grouped outputs" (overview); "a calculation or group-by drops it unless the field is carried unchanged" (spec 8), so group keys keep it.
- Dataset contract v1 covers "fields, types, modes, keys, reporting field, retention, versions, checkpoints" (spec 9). "No public package release; milestone 12 publishes it." The SDK package stays `private: true`.
- Dataset transport limits stay as they are (`DATASET_LIMITS`): 100 fields, 20 datasets, 1,000 rows / 1 MiB per page, 64 KiB per row, 1 KiB key, 30 days default retention.
- Egress contract (overview, verbatim names): `createEgressFetch(options: EgressOptions)` gains `pinDns: true` (default), `redirects: "same-host" | "allowlist"`, `maxDecompressedBytes`, `requestTimeoutMs`, `allowPrivateHosts?: readonly string[]` (self-host instance setting `NETRICS_CUSTOM_API_PRIVATE_HOSTS`, never set on hosted); plus the tests-only `tlsCa?: string` (trust a test certificate, so route-level tests can reach the C-G3 fixture server over https, which the definition schema demands).
- Spec bounds for custom APIs (C-G3 passes them; the guard only offers the options): "response 10 MiB, decompressed 50 MiB, 30 s per request". The guard's own defaults keep every existing caller's behaviour: wire limit 10 MiB, decompressed limit = the wire limit, redirects `"allowlist"`, request timeout 60 s (equal to the connector call budget `DEFAULT_TIMEOUT_MS` in `execute.ts`).
- The private-host setting is "off by default; the hosted service never sets it". It never widens `outboundDomains`; it only lets listed hosts resolve to private addresses. Metadata and link-local addresses stay refused even when listed.
- Existing tests must pass unchanged: `packages/connector-runtime/src/egress.test.ts`, `execute.test.ts`, every connector suite under `packages/connectors/src/` (Google Play matches the message prefix `egress denied: response exceeds` on decompressed bodies), `apps/server/src/oauth*.test.ts`, `signed-keys*.test.ts`, `exchange-rates.test.ts`.
- An egress denial stays an `EgressDeniedError` (classified permanent by `classifyConnectorError`). A timeout is not a denial: it is a new `EgressTimeoutError`, retryable.
- Packages depend inward (`PACKAGE_LAYERS`): `domain` imports nothing, so `DataFieldRole` is declared in `domain` and in the SDK separately, with a test that they agree.
- Error messages from the guard name hosts, never header values, query strings or bodies (anti-goal: no credential in any error).
- No new UI strings in this plan. The `image` role is shown in the builder (B-G2) and used by the widget (I-G2); their plans own the en/de copy.
- Definition of done (`CLAUDE.md`): `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` (with `NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5433/postgres`), `pnpm openapi:check` when contracts change (`pnpm openapi` regenerates), one issue per PR with `Closes #N`, squash-merge on green CI. No schema migration in this plan.
- ADR number: `0026` (assigned by the milestone coordinator; C-G3's custom API ADR is `0027`). If `main` moved, renumber and update the links.

## Review Focus

1. **A bundled connector's provider redirects an authorized request to another allowed host** (a CDN or storage host). Expected: the hop is followed as today, but `authorization`, `proxy-authorization` and `cookie` headers are dropped on a cross-origin hop (WHATWG fetch behaviour); same-origin hops keep them. No bundled connector relies on cross-host auth (none follows redirects with credentials; verify with `rg -n "redirect" packages/connectors/src`). Test in Task 7 (`drops credentials on a cross-origin hop and keeps them on the same origin`).
2. **A name that resolves to several addresses, one of them private** (split-horizon DNS, happy-eyeballs). Expected: the whole lookup is refused, and a refused lookup is not pinned, so a later request in the same call is checked again rather than served from a cache. Test in Task 6 (`refuses a name with one private address among public ones and does not pin the refusal`).
3. **A compressed body under an unknown or chained `content-encoding`.** Expected: only bodies whose every coding is one undici decodes (`gzip`, `x-gzip`, `deflate`, `br`, `zstd`) get the larger decompressed limit; anything else counts against the wire limit, so an unknown coding cannot be used to bypass it; `gzip, gzip` is bounded by the decoded count. Test in Task 8.
4. **A slow provider that sends headers quickly and then drips the body** (slowloris). Expected: the per-request timeout covers connect, headers, every redirect hop and the whole body read, fails with `EgressTimeoutError` (retryable, never "broken connector"). Test in Task 8 and Task 9.
5. **Appending two inputs where one marks a column `image` and the other does not.** Expected: the append succeeds and the output column has no role (roles never make an append fail); identical roles are kept. Test in Task 2.

---

## File Structure

Group F-G1 (dataset contract v1, field role):

- `packages/connector-sdk/src/datasets.ts` (modify): `DATASET_FIELD_ROLES`, `datasetFieldRoleSchema`, `role` on `datasetFieldSchema`, refinement "image fields are strings".
- `packages/connector-sdk/src/version.ts`, `version.test.ts` (modify): `SDK_VERSION = "0.2.17"`.
- `packages/connector-sdk/src/contract/dataset-contract-v1.test.ts` (create) and `packages/connector-sdk/src/contract/fixtures/v1/*.json` (create): frozen accepted/rejected documents.
- `packages/domain/src/data-expression.ts` (modify): `DataFieldRole`, `DataField.role`.
- `packages/domain/src/data-preparation.ts` (modify): keep/drop rules in `executePreparation`.
- `packages/domain/src/data-field-role.test.ts` (create).
- `packages/contracts/src/data-processing.ts` (modify): `role` on `dataFieldViewSchema`; `packages/contracts/openapi.json` (regenerated).
- `packages/database/src/datasets.test.ts` (modify): registration rules for roles and v1 fixtures.
- `apps/server/src/data.test.ts` (modify): role visible in preview responses.
- `docs/decisions/0026-dataset-contract-v1.md` (create), `docs/decisions/README.md` (row), `docs/architecture.md` (SDK table row 0.2.17, link to the ADR).

Group F-G2 (egress hardening):

- `packages/connector-runtime/src/egress.ts` (modify): ranges, `isMetadataAddress`, `parsePrivateHostEntries`, `privateHostPolicy`, new options, `EgressTimeoutError`.
- `packages/connector-runtime/src/egress-ssrf.test.ts` (create): the SSRF suite (own fixture server; `egress.test.ts` stays untouched).
- `packages/connector-runtime/src/execute.ts`, `execute.test.ts` (modify): `ExecuteOptions.egress` pass-through, timeout classification.
- `packages/connector-runtime/src/index.ts` (modify): exports.
- `apps/server/src/env.ts`, `env.test.ts` (modify): `NETRICS_CUSTOM_API_PRIVATE_HOSTS` → `config.customApiPrivateHosts`.
- `.env.example`, `deploy/compose/compose.yml`, `deploy/compose/README.md`, `docs/architecture.md` (egress paragraph) (modify).

Both groups touch `docs/architecture.md` in different sections; whoever merges second rebases.

## PR groups

| Group | Issue / PR title                                                             | Tasks | Depends on                      |
| ----- | ---------------------------------------------------------------------------- | ----- | ------------------------------- |
| F-G1  | Dataset contract v1: document, compatibility tests, field role `image`       | 1–4   | none (parallel with F-G2, C-G1) |
| F-G2  | Egress hardening for custom APIs: DNS pinning, redirects, limits, SSRF suite | 5–9   | none (parallel with F-G1, C-G1) |

C-G3 (executor) needs both merged; I-G1 and I-G2 need F-G1's role.

---

## Group F-G1 — Dataset contract v1 and the field role `image`

**Goal:** the dataset transport is a written, tested contract that the custom connector (and later community connectors, milestone 12) can rely on; a string field can carry the role `image`, which survives preparations where the spec says it should and reaches API clients.

**Dependencies:** none. Runs in parallel with F-G2 and C-G1.

**Issue title:** "Dataset contract v1: document and test the dataset transport; add the `image` field role (SDK 0.2.17)"

**Definition of done:** `CLAUDE.md` items 1–3: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` with `NETRICS_TEST_ADMIN_URL` set; `pnpm openapi && pnpm openapi:check` (Task 3 changes a contract). No migration (roles live in the existing `data_schema_versions.definition` JSON). No UI flow changes, so no e2e change. `Closes #N`.

### Task 1: `role` on dataset fields, SDK 0.2.17

**Files:**

- Modify: `packages/connector-sdk/src/datasets.ts` (`datasetFieldSchema`, the `superRefine` of `sourceDatasetSchema`)
- Modify: `packages/connector-sdk/src/version.ts` (`SDK_VERSION`, history comment), `packages/connector-sdk/src/version.test.ts` (`"keeps loading connectors written for SDK ^0.2.0 to ^0.2.17"`)
- Test: `packages/connector-sdk/src/datasets.test.ts`

**Interfaces:**

- Produces:

```ts
export const DATASET_FIELD_ROLES = ["image"] as const;
export const datasetFieldRoleSchema = z.enum(DATASET_FIELD_ROLES);
export type DatasetFieldRole = z.infer<typeof datasetFieldRoleSchema>; // "image"
// datasetFieldSchema gains:
//   role: datasetFieldRoleSchema.optional()
// DatasetField["role"] is DatasetFieldRole | undefined.
export const SDK_VERSION = "0.2.17";
```

- Refinement message (structural, no values): `"Image fields must be strings"` when `role === "image"` and `type !== "string"`. A role on a key field or on a nullable field is allowed.

- [ ] **Step 1: Write the failing tests** in `datasets.test.ts`:

```ts
it("accepts the image role on a string field (SDK 0.2.17)", () => {
  const parsed = sourceDatasetSchema.parse(
    withField({
      id: "image_url",
      name: "Image",
      type: "string",
      nullable: true,
      classification: "public",
      role: "image",
    }),
  );
  expect(parsed.fields.at(-1)?.role).toBe("image");
});
it("refuses the image role on a non-string field and unknown roles", () => {
  expect(
    sourceDatasetSchema.safeParse(
      withField({ ...stringField, type: "integer", role: "image" }),
    ).success,
  ).toBe(false);
  expect(
    sourceDatasetSchema.safeParse(withField({ ...stringField, role: "video" }))
      .success,
  ).toBe(false);
});
it("leaves fields without a role unchanged", () => {
  expect("role" in sourceDatasetSchema.parse(definitionInput).fields[0]!).toBe(
    false,
  );
});
```

`withField(field)` appends one field to the file's existing `orders` definition input. In `version.test.ts`, extend the range list with `"^0.2.17"` and the expected `SDK_VERSION` to `"0.2.17"`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/connector-sdk/src/datasets.test.ts packages/connector-sdk/src/version.test.ts`
Expected: FAIL (`role` is an unrecognized key of the strict field object; version is 0.2.16).

- [ ] **Step 3: Implement** the schema change and the refinement; bump `SDK_VERSION` with the comment line `// 0.2.17: optional dataset field role "image" (dataset contract v1, ADR 0026).`

- [ ] **Step 4: Run** the same command → PASS. Also run `pnpm vitest run packages/connectors` (manifests declare `^0.2.x`; all must still load).

- [ ] **Step 5: Commit** `feat(sdk): optional image role on dataset fields (SDK 0.2.17)`

### Task 2: The role through domain fields and preparations

**Files:**

- Modify: `packages/domain/src/data-expression.ts:22-30` (`DataField`)
- Modify: `packages/domain/src/data-preparation.ts` (`executePreparation`: the `append`, `cast`, `calculate` and `group` branches)
- Create: `packages/domain/src/data-field-role.test.ts`
- Test (unchanged, must pass): `packages/domain/src/data-processing.test.ts`, `data-append-mapping.test.ts`

**Interfaces:**

- Produces:

```ts
// packages/domain/src/data-expression.ts
export type DataFieldRole = "image";
export interface DataField {
  /* existing members */
  role?: DataFieldRole;
}
```

- Rules (the output schema of each node type):

| Node                                                   | Role on output fields                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source`                                               | as stored in the dataset definition                                                                                                                                |
| `select`, `rename`, `filter`, `replace`, `deduplicate` | kept (field carried unchanged; `replace` changes values, not meaning)                                                                                              |
| `append`                                               | kept when every input that has the column has the same role; otherwise dropped (never an error). `columnMappings` keep the source field's role under the target id |
| `join`                                                 | kept on left and on prefixed right fields                                                                                                                          |
| `calculate`                                            | input fields kept; the new field (and its `.currency` companion) never has a role                                                                                  |
| `cast`                                                 | dropped on the cast field                                                                                                                                          |
| `group`                                                | kept on key fields (carried unchanged); aggregate outputs never have a role                                                                                        |

- Roles are presentation metadata: `checkSchemaBindings` / `checkRestoredModelBindings` in `apps/server/src/data/service.ts` and `compatible()` in `packages/database/src/datasets.ts` do not compare them (a role change never makes a model "schema changed"). No change there; Task 4 pins this with a test.

- [ ] **Step 1: Write the failing tests** in `data-field-role.test.ts`, one `executePreparation` graph per rule over a source table with fields `id` (string, key), `title` (string), `image` (string, `role: "image"`), `views` (integer):

```ts
it("keeps the image role through select, rename, filter, replace and deduplicate", ...);
  // expect(output.fields.find(f => f.id === "image")?.role).toBe("image")
it("keeps the role on both sides of a join, under the right prefix", ...);
  // fields "image" and "r.image" both role "image"
it("keeps the role on group keys and never puts one on aggregates", ...);
  // group by image, aggregate last(title): image keeps "image"; aggregate field has no role
it("drops the role on a cast field and never gives a calculated field one", ...);
  // cast image → string? (no-op type) still drops; calculate copy = field(image) → no role
it("keeps an append's role only when every input agrees", ...);
  // inputs A (image role) + B (same id, no role) → no role, no error
  // inputs A + A' (both role) → role kept
  // columnMappings { a: { image: "picture" } } → "picture" has role "image"
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/domain/src/data-field-role.test.ts`
Expected: FAIL on the cast, append-mismatch and aggregate cases (spreads carry the role today, the append keeps the first input's field, and `DataField` has no `role` so the test does not typecheck).

- [ ] **Step 3: Implement** the type and the three explicit changes: `cast` maps the field to `{ ...f, type, nullable }` without `role`; `append` merges fields so that a differing `role` (including present vs absent) removes it; `calculate`/`group` build new fields without spreading inputs (already true; assert only). The `append` schema-mismatch check (`type`, `unit`, `currencyField`) stays and does not include `role`.

- [ ] **Step 4: Run** `pnpm vitest run packages/domain` → PASS.

- [ ] **Step 5: Commit** `feat(data): carry the image role through preparations`

### Task 3: The role in the data API

**Files:**

- Modify: `packages/contracts/src/data-processing.ts:37-45` (`dataFieldViewSchema`)
- Regenerate: `packages/contracts/openapi.json` (`pnpm openapi`)
- Test: `apps/server/src/data.test.ts`

**Interfaces:**

- Consumes: `DataField.role` (Task 2), `DatasetField.role` (Task 1).
- Produces: `dataFieldViewSchema` gains `role: z.enum(["image"]).optional().describe("Presentation role of a string field. \"image\": the value is an image URL (dataset contract v1, SDK 0.2.17).")`. Every response that lists fields (`/data/preview`, `/data/preparations/preview`, source lists, model previews where fields are listed) returns it when set and omits it otherwise. The contracts package does not import the SDK; it repeats the literal, and Task 4 tests that both lists agree.

- [ ] **Step 1: Write the failing test** in `apps/server/src/data.test.ts`:

```ts
it("returns the image role of source and prepared fields", async () => {
  // Register a source dataset whose `image_url` field has role "image" and
  // ingest one page, with the file's existing dataset setup (ingestDatasetPage).
  const source = await call("POST", "/preview", editor, { sourceId });
  expect(source.json().fields.find((f) => f.id === "image_url")).toMatchObject({
    role: "image",
  });
  const prepared = await call("POST", "/preparations/preview", editor, {
    graph: selectGraph(sourceId, ["image_url", "title"]),
  });
  expect(prepared.json().fields.find((f) => f.id === "image_url")?.role).toBe(
    "image",
  );
  expect(
    prepared.json().fields.find((f) => f.id === "title"),
  ).not.toHaveProperty("role");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5433/postgres pnpm vitest run apps/server/src/data.test.ts -t "image role"`
Expected: FAIL (`role` is stripped by the response schema).

- [ ] **Step 3: Implement** the schema change; `pnpm openapi`.

- [ ] **Step 4: Run** the test → PASS; `pnpm openapi:check` → clean.

- [ ] **Step 5: Commit** `feat(api): expose the image role of data fields`

### Task 4: Dataset contract v1 — document and compatibility tests

**Files:**

- Create: `docs/decisions/0026-dataset-contract-v1.md`; Modify: `docs/decisions/README.md` (row "Dataset contract v1: the frozen dataset transport for connectors"), `docs/architecture.md` (SDK table row `| 0.2.17 | Optional dataset field role "image"; dataset contract v1 (ADR 0026) |`, and one sentence in the datasets part linking ADR 0026)
- Modify: `packages/connector-sdk/src/datasets.ts` (file header comment: "Dataset contract v1, docs/decisions/0026-dataset-contract-v1.md. Changes are additive only; see the ADR.")
- Create: `packages/connector-sdk/src/contract/dataset-contract-v1.test.ts`, fixtures `packages/connector-sdk/src/contract/fixtures/v1/definitions.accepted.json`, `definitions.rejected.json`, `pages.accepted.json`, `pages.rejected.json`, `sync-results.accepted.json`
- Modify: `packages/database/src/datasets.test.ts`

**Where the contract lives, and why an ADR:** `CLAUDE.md` asks for an ADR when a choice is hard to reverse and names "SDK contract" explicitly; freezing the transport is exactly that, and ADRs 0022–0025 already define the parts being frozen, so the new record can cite them section by section. `docs/connectors/` holds per-provider guides for users and is the wrong audience. Milestone 12 turns the ADR into the published SDK reference.

**ADR content** (Status: accepted, milestone 13; Context; Decision; Consequences), one subsection per item of spec section 9, each stating the rule and the code that enforces it:

- _Fields and types:_ `datasetFieldSchema` members; the eight types and their value encodings as `validValue` checks them (decimal as string, ≤ 38 digits, scale ≤ 18; date `YYYY-MM-DD`; timestamp UTC `Z`, ≤ 9 fraction digits; `json` bounded to 10,000 nodes, depth 8); `classification`; `unit`, `currencyField` (money needs an exact numeric and a non-null string currency, ISO 4217 uppercase), `scale`; `role: "image"` (string only, presentation only, how preparations keep or drop it — the Task 2 table).
- _Keys:_ 1–10 unique non-null scalar `keyFields`; canonical key `datasetRecordKey` (decimal normalisation, nanosecond timestamps); 1 KiB key limit.
- _Modes:_ `upsert` (tombstones with key fields only), `append` (identity = key; conflicting re-send refused), `replace_window` (half-open `window`, optional `partition`, records must lie inside), `snapshot` (each complete refresh replaces the dataset).
- _Reporting field:_ non-null `date`/`timestamp`, `reportingTimeZone`; required by `replace_window`.
- _Retention:_ dataset default 30 days, `null` keeps until deleted, per-field override, personal fields need an explicit value, effective retention is the minimum (`datasetRetentionDays`).
- _Versions:_ positive integer per dataset; a registered version is immutable (same version, different definition → `dataset_schema_version_conflict`); a new version must be greater and pass `compatible()` (list its rules; role changes are compatible); backfill per dataset version (#617, architecture "connector updates").
- _Pages and checkpoints:_ `datasetPageSchema` (refresh key, page chain, `complete`, staging identity), the limits in `DATASET_LIMITS`, `SyncResult.datasetPages` / `receivedDatasets` / `nextCursor` / `nextFrom` semantics: a page is durable before its cursor is committed; an incomplete or failed run never infers deletions; staging per ADR 0023/0024.
- _Compatibility rule:_ within v1 only additive, optional changes, each with an SDK minor-patch bump (0.2.x) and a fixture; anything else is contract v2, an ADR of its own, and milestone 12's publishing rules.

**Interfaces:**

- Consumes: `sourceDatasetSchema`, `datasetPageSchema`, `validateDatasetPage`, `syncResultSchema`, `datasetRecordKey` (SDK); `registerSourceDataset`, `ingestDatasetPage` (database).
- Produces: fixture files that later plans extend only by adding entries (C-G3 may add a fixture per custom-api stream shape). Each fixture entry is `{ "name": string, "value": unknown }`; page fixtures are `{ "name", "definition", "page" }`.

- [ ] **Step 1: Write the fixtures and failing tests**

Fixtures cover at least: every field type; each mode (with `replace_window` + partition); a definition with `reportingTimeZone`; dataset retention `null`, a number, and omitted; a personal field with retention; money with `currencyField` and `unit: "currency_minor"`; a field with `role: "image"`. Rejected fixtures: duplicate field ids, nullable key, `json` key, reporting field nullable, `replace_window` without reporting field, money without currency field, personal field without retention, image role on an integer, unknown member on a field (strictness), page with a record outside its window, tombstone in an `append` dataset.

```ts
describe("dataset contract v1", () => {
  it.each(accepted)("still accepts $name", ({ value }) => {
    expect(sourceDatasetSchema.safeParse(value).success).toBe(true);
  });
  it.each(rejected)("still rejects $name", ({ value }) => {
    expect(sourceDatasetSchema.safeParse(value).success).toBe(false);
  });
  it.each(pagesAccepted)("validates page $name", ({ definition, page }) => {
    expect(() => validateDatasetPage(sourceDatasetSchema.parse(definition), page)).not.toThrow();
  });
  it.each(pagesRejected)("refuses page $name", ...);
  it.each(syncResults)("accepts sync result $name", ({ value }) => {
    expect(syncResultSchema.safeParse(value).success).toBe(true);
  });
  it("has exactly the v1 members (additions need a fixture and an SDK bump)", () => {
    expect(Object.keys(datasetFieldSchema.shape).sort()).toEqual([
      "classification", "currencyField", "id", "name", "nullable",
      "retentionDays", "role", "scale", "type", "unit",
    ]);
    expect(Object.keys(sourceDatasetSchema.shape).sort()).toEqual([
      "fields", "grain", "key", "keyFields", "mode", "name",
      "reportingField", "reportingTimeZone", "retentionDays", "version",
    ]);
    expect(datasetFieldTypeSchema.options).toEqual([
      "string", "boolean", "integer", "number", "decimal", "date", "timestamp", "json",
    ]);
    expect(DATASET_LIMITS).toEqual({ fields: 100, datasets: 20, pageRows: 1_000,
      pageBytes: 1_048_576, rowBytes: 65_536, keyBytes: 1_024, previewRows: 100, retentionDays: 30 });
  });
  it("names the same roles as the API contract and the domain", () => {
    expect([...DATASET_FIELD_ROLES]).toEqual(["image"]);
    // contracts: dataFieldViewSchema.shape.role (unwrap optional) options equal DATASET_FIELD_ROLES.
    // The SDK may not import contracts; put this one assertion in
    // packages/contracts/src/data-processing.test.ts if that file exists, else create it.
  });
});
```

In `packages/database/src/datasets.test.ts`:

```ts
it("registers and ingests every v1 accepted fixture", ...);
  // registerSourceDataset + one ingestDatasetPage per page fixture; generation published
it("treats a role change as compatible in a new version and as a conflict in the same version", ...);
  // v1 without role, then v2 with role "image" → registers; v2 again with no role → dataset_schema_version_conflict
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/connector-sdk/src/contract` and `NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5433/postgres pnpm vitest run packages/database/src/datasets.test.ts -t "v1|role"`
Expected: FAIL only where fixtures are missing; if an accepted fixture fails, the fixture is wrong, not the schema (v1 freezes today's behaviour): fix the fixture.

- [ ] **Step 3: Write the ADR** and the README/architecture rows. Every rule in the ADR cites the function or schema that enforces it; no rule appears that no test covers.

- [ ] **Step 4: Run** both commands → PASS; `pnpm format:check` (prettier formats Markdown and JSON).

- [ ] **Step 5: Commit** `docs(adr): dataset contract v1 with compatibility fixtures`

---

## Group F-G2 — Egress hardening and the SSRF suite

**Goal:** the egress guard can safely run user-written definitions: it pins and validates DNS, follows redirects only where allowed and never carries credentials to another origin, bounds wire bytes, decoded bytes and time per request, and lets a self-hoster name private hosts for internal APIs without opening metadata services. Bundled connectors keep working unchanged.

**Dependencies:** none. Runs in parallel with F-G1 and C-G1.

**Issue title:** "Egress hardening for custom APIs: DNS pinning, same-host redirects, decompression and time limits, private hosts for self-hosting, SSRF suite"

**Definition of done:** `CLAUDE.md` items 1–3: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` with `NETRICS_TEST_ADMIN_URL` set, including the unchanged `egress.test.ts`, every connector suite and the OAuth/signed-key/exchange-rate server suites; timing tests (timeouts, drip) pass 10 repeated runs (`pnpm vitest run packages/connector-runtime/src/egress-ssrf.test.ts --repeat 10` or a loop). No contract or route change, so no `openapi:check` diff. Self-host docs updated; the `selfhost` CI job must stay green with the new compose variable empty. `Closes #N`.

### Task 5: Address classification

**Files:**

- Modify: `packages/connector-runtime/src/egress.ts:22-70` (blocklist, `isBlockedAddress`)
- Create: `packages/connector-runtime/src/egress-ssrf.test.ts` (first `describe` blocks)

**Interfaces:**

- Produces:

```ts
export function isBlockedAddress(address: string): boolean; // unchanged signature, more ranges
/** Never reachable, even for allowPrivateHosts: metadata services and link-local. */
export function isMetadataAddress(address: string): boolean;
/**
 * Validates self-host private-host entries: host patterns as hostAllowed
 * reads them ("intranet.example", "*.corp.example"), IP addresses, or CIDR
 * ranges ("10.20.0.0/16", "fd12::/48"). Throws Error("invalid private host
 * entry: <entry>") for "*", "0.0.0.0/0", "::/0", prefixes shorter than /8
 * (IPv4) or /16 (IPv6), and anything else malformed. Trims, lowercases,
 * drops empty entries.
 */
export function parsePrivateHostEntries(entries: readonly string[]): string[];
export interface PrivateHostPolicy {
  /** host: the URL hostname; address: the literal or resolved address. */
  allows(host: string, address: string): boolean;
}
export function privateHostPolicy(
  entries: readonly string[],
): PrivateHostPolicy;
```

- Added blocked ranges: IPv4 `192.88.99.0/24`; IPv6 `::/96` judged by its embedded IPv4 (IPv4-compatible, e.g. `::7f00:1` is 127.0.0.1 — refused today only by accident of routing, `isBlockedAddress("::7f00:1")` returns `false` now), `64:ff9b:1::/48`, `2001::/32` (Teredo), `2002::/16` (6to4), `fec0::/10`. IPv4-mapped forms in both notations (`::ffff:127.0.0.1`, `::ffff:7f00:1`) stay judged as IPv4 (BlockList handles both; keep the test).
- Metadata set: `169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254/128`, `100.100.100.200/32`, `192.0.0.192/32`, and the IPv4-mapped forms of the IPv4 entries.
- `privateHostPolicy(entries).allows(host, address)`: `true` iff `address` is not a metadata address and (`host` matches a host-pattern entry, or `address` is inside an IP/CIDR entry).

- [ ] **Step 1: Write the failing tests**

```ts
describe("isBlockedAddress (SSRF)", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "10.0.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "192.0.0.192",
    "100.100.100.200",
    "192.88.99.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::7f00:1",
    "::a00:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1",
    "64:ff9b:1::1",
    "2001::1",
    "2002:7f00:1::",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "fec0::1",
    "ff02::1",
  ])("blocks %s", (a) => expect(isBlockedAddress(a)).toBe(true));
  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:1.1.1.1"])(
    "allows public %s",
    (a) => expect(isBlockedAddress(a)).toBe(false),
  );
});
describe("tunnelled and legacy IPv6 forms (each named, so a regression points at the form)", () => {
  it.each([
    ["IPv4-compatible loopback", "::7f00:1"],
    ["IPv4-compatible private", "::a00:1"],
    ["IPv4-compatible metadata", "::a9fe:a9fe"],
    ["6to4 of loopback", "2002:7f00:1::"],
    ["6to4 of a public address (whole 2002::/16 refused)", "2002:101:101::1"],
    ["Teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["Teredo prefix", "2001::1"],
    ["site-local", "fec0::1"],
    ["site-local upper", "feff:ffff::1"],
  ])("blocks %s (%s)", (_name, a) => expect(isBlockedAddress(a)).toBe(true));
});
describe("isMetadataAddress", () => {
  it.each([
    "169.254.169.254",
    "::ffff:169.254.169.254",
    "fd00:ec2::254",
    "100.100.100.200",
    "192.0.0.192",
    "fe80::1",
  ])("%s", (a) => expect(isMetadataAddress(a)).toBe(true));
  it("does not treat ordinary private addresses as metadata", () =>
    expect(isMetadataAddress("10.0.0.1")).toBe(false));
});
describe("private host entries", () => {
  it("accepts host patterns, addresses and ranges", () =>
    expect(
      parsePrivateHostEntries([
        " Intranet.Example ",
        "*.corp.example",
        "10.20.0.0/16",
        "fd12::/48",
        "127.0.0.1",
        "",
      ]),
    ).toEqual([
      "intranet.example",
      "*.corp.example",
      "10.20.0.0/16",
      "fd12::/48",
      "127.0.0.1",
    ]));
  it.each([
    "*",
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/7",
    "fd00::/8",
    "10.0.0.0/33",
    "http://x",
    "a b",
  ])("refuses %s", (entry) =>
    expect(() => parsePrivateHostEntries([entry])).toThrow(
      /invalid private host entry/,
    ),
  );
  it("never allows metadata, even for a listed host or range", () => {
    const policy = privateHostPolicy(["intranet.example", "169.254.0.0/16"]);
    expect(policy.allows("intranet.example", "10.1.2.3")).toBe(true);
    expect(policy.allows("intranet.example", "169.254.169.254")).toBe(false);
    expect(policy.allows("other.example", "10.1.2.3")).toBe(false);
  });
});
```

URL normalisation of encoded IPv4 literals (decimal `2130706433`, hex `0x7f.1`, octal `0177.0.0.1`, short `127.1`) is covered end-to-end in Task 6, where the URL parser turns them into `127.0.0.1` before the guard sees them.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/connector-runtime/src/egress-ssrf.test.ts`
Expected: FAIL (`::7f00:1`, `2001::1`, `2002:…`, `fec0::1`, `64:ff9b:1::1`, `192.88.99.1` not blocked; new functions missing).

- [ ] **Step 3: Implement.** IPv4-compatible extraction: parse the IPv6 address to 16 bytes (`node:net` `SocketAddress` or a small parser), and when the first 96 bits are zero and the address is not `::`/`::1`, check the last 32 bits as IPv4. CIDR membership for `privateHostPolicy` with a per-policy `BlockList`.

- [ ] **Step 4: Run** the suite and `pnpm vitest run packages/connector-runtime/src/egress.test.ts` → PASS.

- [ ] **Step 5: Commit** `feat(egress): block IPv4-compatible, 6to4, Teredo and site-local addresses; private host policy`

### Task 6: DNS pinning and private hosts in the guard

**Files:**

- Modify: `packages/connector-runtime/src/egress.ts` (`EgressOptions`, `createEgressFetch`: `guardedLookup`, `checkUrl`)
- Test: `packages/connector-runtime/src/egress-ssrf.test.ts`

**Interfaces:**

- Produces (full option set; Tasks 7–8 implement the rest):

```ts
export interface EgressOptions {
  /** manifest.outboundDomains (or a custom definition's hosts, C-G3) */
  allowedDomains: readonly string[];
  signal: AbortSignal;
  /** Wire bytes, and the whole body when it is not content-encoded. Default 10 MiB. */
  maxResponseBytes?: number;
  /** Decoded bytes of a content-encoded body. Default: maxResponseBytes. */
  maxDecompressedBytes?: number;
  maxRedirects?: number; // default 3
  /** "allowlist": every hop must be in allowedDomains (default). "same-host": every hop keeps the first URL's scheme, host and port. */
  redirects?: "allowlist" | "same-host";
  /** Whole request: connect, every hop, headers and body. Default 60_000. */
  requestTimeoutMs?: number;
  /** Resolve each host once per egress instance and reuse the validated addresses. Default true. */
  pinDns?: boolean;
  /** Self-host only: hosts/ranges that may resolve to private addresses (never metadata). Already validated by parsePrivateHostEntries. */
  allowPrivateHosts?: readonly string[];
  /** Tests only */
  lookup?: LookupFunction;
  allowPrivateAddresses?: boolean;
  allowInsecureHttp?: boolean;
  /** Tests only: an extra trusted CA (PEM) for the guard's undici Agent (`connect.ca` added to the default roots). */
  tlsCa?: string;
}
```

- `guardedLookup(hostname, …)`: with `pinDns`, a `Map<string, Array<{ address; family }>>` per `createEgressFetch` call stores the first _validated_ list for a lowercase hostname; later lookups for that name answer from it without calling `baseLookup`. A refused or failed lookup is not stored. Validation per address: refused if `isMetadataAddress`, else refused if `isBlockedAddress` unless `allowPrivateAddresses` or `policy.allows(hostname, address)`. Any refused address refuses the whole lookup (today's rule).
- `tlsCa`: when set, the per-call undici `Agent` gets `connect: { ca: [...tls.rootCertificates, tlsCa] }`; unset changes nothing. The server never reads it from the environment; only test setups pass it through `ExecuteOptions.egress`.
- `checkUrl`: an IP-literal host applies the same per-address rule (metadata always refused; private allowed only by `allowPrivateAddresses` or the policy). `allowPrivateHosts` never bypasses `hostAllowed(host, allowedDomains)`.
- Error messages stay host-only: `egress denied: <host> resolves to a non-public address`, `egress denied: non-public address <host>`, and new `egress denied: <host> resolves to a metadata address`.

- [ ] **Step 1: Write the failing tests** (the suite's own fixture server on `127.0.0.1` answers `/ok` and sets `connection: close` so each request opens a new socket and calls the lookup; a `scriptedLookup(...answers)` returns the next answer per call and counts calls):

```ts
it("refuses encoded loopback literals after URL normalisation", async () => {
  const guard = createEgressFetch({ allowedDomains: ["127.0.0.1"], signal });
  for (const host of ["2130706433", "0x7f.1", "0177.0.0.1", "127.1", "[::ffff:127.0.0.1]", "[::1]", "[::7f00:1]"])
    await expect(guard(`https://${host}/ok`)).rejects.toThrow(EgressDeniedError);
});
it("refuses metadata literals and names that resolve to them", async () => {
  // https://169.254.169.254/latest/meta-data, https://[fd00:ec2::254]/, and a name resolving to 169.254.169.254
});
it("refuses localhost and names that resolve to private addresses", ...); // lookup → 10.0.0.5 / ::1
it.each([
  ["IPv4-compatible", "::7f00:1"],
  ["6to4", "2002:7f00:1::"],
  ["Teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
  ["site-local", "fec0::1"],
])("refuses a name resolving to a %s address, even with allowPrivateHosts for another host", async (_name, address) => {
  // lookup → [{ address, family: 6 }]; fixtureGuard({ lookup, allowPrivateHosts: ["other.test"] }) rejects /non-public address/
});
it("trusts a test certificate passed as tlsCa (tests only)", async () => {
  // the suite's fixture server also listens with a self-signed certificate for 127.0.0.1 (generated with
  // `openssl req -x509 …` into a temp dir in beforeAll); https://127.0.0.1:<tlsPort>/ok with
  // allowPrivateHosts ["127.0.0.1"]: rejects without tlsCa (certificate error), answers 200 with tlsCa: certPem
});
it("pins the first validated answer for the rest of the call (DNS rebinding)", async () => {
  const lookup = scriptedLookup(["127.0.0.1"], ["169.254.169.254"]);
  const pinned = fixtureGuard({ lookup, allowPrivateHosts: ["api.fixture.test"] });
  expect((await pinned(url("/ok"))).status).toBe(200);
  expect((await pinned(url("/ok"))).status).toBe(200);
  expect(lookup.calls).toBe(1);
  const unpinned = fixtureGuard({ lookup: scriptedLookup(["127.0.0.1"], ["169.254.169.254"]),
    allowPrivateHosts: ["api.fixture.test"], pinDns: false });
  await unpinned(url("/ok"));
  await expect(unpinned(url("/ok"))).rejects.toThrow(/metadata address/);
});
it("refuses a name with one private address among public ones and does not pin the refusal", ...);
  // lookup answers [1.1.1.1, 10.0.0.1] then [127.0.0.1] with allowPrivateHosts: first call rejects, second reaches the fixture; calls === 2
it("lets a listed private host through, but no other host and never outside outboundDomains", async () => {
  // allowPrivateHosts ["api.fixture.test"]: /ok 200
  // same, but allowedDomains lacks api.fixture.test: rejects "not in the connector's outboundDomains"
  // allowPrivateHosts ["other.test"]: rejects "non-public address"
  // allowPrivateHosts ["127.0.0.1"] + http://127.0.0.1:<port>/ok with allowedDomains ["127.0.0.1"]: 200 (the C-G3 fixture-server setup)
});
```

`fixtureGuard(overrides)` = `createEgressFetch({ allowedDomains: ["api.fixture.test"], signal, lookup: toLocalhost, allowInsecureHttp: true, ...overrides })` — note: no `allowPrivateAddresses`, so the private-host path is what is under test.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/connector-runtime/src/egress-ssrf.test.ts -t "pins|private host|metadata|encoded"`
Expected: FAIL (`allowPrivateHosts`, `pinDns` unknown; the rebinding case reaches the second lookup).

- [ ] **Step 3: Implement** the options, the pin map and the shared per-address rule.

- [ ] **Step 4: Run** the suite and `egress.test.ts` → PASS.

- [ ] **Step 5: Commit** `feat(egress): pin validated DNS answers per call; private hosts for self-hosting`

### Task 7: Redirects: same-host mode and credential stripping

**Files:**

- Modify: `packages/connector-runtime/src/egress.ts` (redirect loop in `egressFetch`)
- Test: `packages/connector-runtime/src/egress-ssrf.test.ts`

**Interfaces:**

- Consumes: `EgressOptions.redirects`, `maxRedirects` (Task 6).
- Produces: per hop, in order: redirect cap (`egress denied: too many redirects`, unchanged); `checkUrl` on the target (unchanged); with `redirects: "same-host"`, refuse when `protocol` or `host` (hostname and port) differ from the first URL: `egress denied: redirect to another host <targetHost>`; on any hop whose origin differs from the previous hop's, send the headers without `authorization`, `proxy-authorization` and `cookie` (case-insensitive). Redirect statuses stay 3xx with `location`, as today.

- [ ] **Step 1: Write the failing tests** (fixture routes `/to-sibling` → `http://cdn.fixture.test:<port>/echo-auth`, `/to-self` → `/echo-auth`, `/to-other-port` → `http://api.fixture.test:<other port>/ok`, `/to-https` → `https://api.fixture.test:<port>/ok`, `/to-metadata` → `http://169.254.169.254/latest/meta-data`, `/to-decimal` → `http://2130706433/`; `/echo-auth` answers `{ authorization: req.headers.authorization ?? null }`):

```ts
it("drops credentials on a cross-origin hop and keeps them on the same origin", async () => {
  const guard = fixtureGuard({ allowedDomains: ["api.fixture.test", "cdn.fixture.test"], allowPrivateHosts: ["*.fixture.test"] });
  const init = { headers: { Authorization: "Bearer secret-token" } };
  expect((await guard(url("/to-self"), init)).json()).toEqual({ authorization: "Bearer secret-token" });
  expect((await guard(url("/to-sibling"), init)).json()).toEqual({ authorization: null });
});
it("keeps same-host redirects on the first URL's host, port and scheme", async () => {
  const guard = fixtureGuard({ redirects: "same-host", allowedDomains: ["api.fixture.test", "cdn.fixture.test"], allowPrivateHosts: ["*.fixture.test"] });
  expect((await guard(url("/to-self"))).status).toBe(200);
  for (const path of ["/to-sibling", "/to-other-port", "/to-https"])
    await expect(guard(url(path))).rejects.toThrow(/redirect to another host/);
});
it("refuses redirects to metadata and encoded private addresses in every mode", ...);
it("never puts a header value in a redirect error", async () => {
  // a refused hop with Authorization "Bearer secret-token": error.message does not contain "secret-token"
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/connector-runtime/src/egress-ssrf.test.ts -t "redirect|credentials"` → FAIL (credentials are re-sent to the sibling; `redirects` unknown).

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** the suite, `egress.test.ts` ("re-checks every redirect and caps them", "keeps App Store icon requests on the exact pinned hosts" must stay green), and `pnpm vitest run packages/connectors` → PASS.

- [ ] **Step 5: Commit** `feat(egress): same-host redirect mode; no credentials across origins`

### Task 8: Decompressed-size limit and per-request timeout

**Files:**

- Modify: `packages/connector-runtime/src/egress.ts` (body read, signal)
- Modify: `packages/connector-sdk/src/connector.ts` (doc comment on `ConnectorResponse` only: "The host may also bound decoded bytes of a content-encoded body and the time per request." No SDK bump: no type changes.)
- Test: `packages/connector-runtime/src/egress-ssrf.test.ts`

**Interfaces:**

- Produces:

```ts
export class EgressTimeoutError extends Error {
  // name "EgressTimeoutError"; message `egress timeout: ${host} did not answer within ${ms} ms`
}
```

- Body limits: keep undici `fetch` (it decodes `content-encoding` as it does today; switching to raw `request()` would change the headers and bodies bundled connectors see). Let `codings` = the response's `content-encoding` split on commas, trimmed, lowercased, `identity` removed. If `codings` is non-empty and every coding is in `gzip`, `x-gzip`, `deflate`, `br`, `zstd`: refuse a declared `content-length` above `maxResponseBytes` and stream-count decoded bytes against `maxDecompressedBytes` (`egress denied: response exceeds ${max} bytes once decompressed`). Otherwise count bytes against `maxResponseBytes` (`egress denied: response exceeds ${max} bytes`, unchanged). Both messages start with `egress denied: response exceeds` (Google Play matches that prefix). Cancel the body stream on refusal.
- Timeout: one `AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeoutMs)])` per `egressFetch` call, passed to every hop and kept for the body read. When the timeout signal fired and `options.signal` did not, throw `EgressTimeoutError`; when `options.signal` aborted, rethrow as today.

- [ ] **Step 1: Write the failing tests** (routes: `/gzip-json` 200 gzip of `{"ok":true}` with `content-encoding: gzip`; `/bomb` gzip of 64 MiB zeros, about 64 KiB on the wire, no content-length; `/bomb-chained` the bomb gzipped twice with `content-encoding: gzip, gzip`; `/brotli` a 2 MiB brotli body; `/unknown-coding` 2 KiB raw bytes with `content-encoding: x-custom`; `/slow-headers` waits 500 ms before headers; `/drip` sends headers, then one byte every 100 ms for 2 s):

```ts
it("decodes a gzip JSON body as before", async () =>
  expect((await fixtureGuard(privateFixture)(url("/gzip-json"))).json()).toEqual({ ok: true }));
it("stops a decompression bomb at the decompressed limit", async () => {
  const guard = fixtureGuard({ ...privateFixture, maxResponseBytes: 10 * MIB, maxDecompressedBytes: 1 * MIB });
  for (const path of ["/bomb", "/bomb-chained"])
    await expect(guard(url(path))).rejects.toThrow(/^egress denied: response exceeds 1048576 bytes once decompressed$/);
});
it("defaults the decompressed limit to the response limit (bundled connectors unchanged)", async () => {
  await expect(fixtureGuard({ ...privateFixture, maxResponseBytes: 1 * MIB })(url("/brotli")))
    .rejects.toThrow(/^egress denied: response exceeds 1048576 bytes/);
});
it("allows a larger decoded body when asked", async () => {
  const body = await fixtureGuard({ ...privateFixture, maxResponseBytes: 1 * MIB, maxDecompressedBytes: 4 * MIB })(url("/brotli"));
  expect(body.bytes().byteLength).toBe(2 * MIB);
});
it("counts an unknown content-encoding against the wire limit", async () => {
  await expect(fixtureGuard({ ...privateFixture, maxResponseBytes: 1024, maxDecompressedBytes: 1 * MIB })(url("/unknown-coding")))
    .rejects.toThrow(/^egress denied: response exceeds 1024 bytes$/);
});
it("times out slow headers and a dripping body with a retryable error", async () => {
  const guard = fixtureGuard({ ...privateFixture, requestTimeoutMs: 200 });
  for (const path of ["/slow-headers", "/drip"]) {
    const error = await guard(url(path)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EgressTimeoutError);
    expect(error).not.toBeInstanceOf(EgressDeniedError);
  }
});
it("reports the caller's abort as an abort, not a timeout", ...);
```

`privateFixture` = `{ allowPrivateHosts: ["api.fixture.test"] }`. Generate the bomb once in `beforeAll` with `gzipSync(Buffer.alloc(64 * MIB), { level: 9 })`.

- [ ] **Step 2: Run** `pnpm vitest run packages/connector-runtime/src/egress-ssrf.test.ts -t "decompress|bomb|coding|times out|abort|gzip|brotli"` → FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** the suite 10 times (timing), `egress.test.ts`, and `pnpm vitest run packages/connectors/src/google-play` → PASS.

- [ ] **Step 5: Commit** `feat(egress): decompressed-size limit and per-request timeout`

### Task 9: Runtime pass-through and the self-host setting

**Files:**

- Modify: `packages/connector-runtime/src/execute.ts:52-56` (`ExecuteOptions.egress`), `:115-119` (`createEgressFetch` call); `packages/connector-runtime/src/index.ts` (export `EgressTimeoutError`, `isMetadataAddress`, `parsePrivateHostEntries`, `privateHostPolicy`)
- Modify: `apps/server/src/env.ts` (schema entry and `customApiPrivateHosts` in the transformed config)
- Modify: `.env.example`, `deploy/compose/compose.yml` (next to `NETRICS_IMAGE_QUOTA_*`), `deploy/compose/README.md` (new section "Custom APIs on your own network"), `docs/architecture.md` (egress paragraph at "Connector code reaches the network only through `runtime.fetch`": DNS pinning, redirect modes and credential stripping, decoded-size limit, per-request timeout, private hosts for self-hosting)
- Test: `packages/connector-runtime/src/execute.test.ts`, `apps/server/src/env.test.ts`

**Interfaces:**

- Produces:

```ts
// execute.ts — host-set egress policy; the server sets the custom-api values
// only for the custom-api connector (C-G3), never for bundled connectors.
egress?: Pick<EgressOptions,
  | "lookup" | "allowPrivateAddresses" | "allowInsecureHttp" | "tlsCa"
  | "allowPrivateHosts" | "redirects" | "requestTimeoutMs"
  | "maxResponseBytes" | "maxDecompressedBytes" | "pinDns">;

// apps/server/src/env.ts — Config
customApiPrivateHosts: string[]; // parsePrivateHostEntries(split(",")); [] when unset
```

- Env entry: `NETRICS_CUSTOM_API_PRIVATE_HOSTS: z.string().default("")` transformed with `parsePrivateHostEntries(value.split(","))`; an invalid entry fails config with an issue message `NETRICS_CUSTOM_API_PRIVATE_HOSTS: invalid private host entry: <entry>`. Comment: "Self-hosting only: hosts or ranges custom API definitions may reach on private networks (comma-separated, e.g. `intranet.example,*.corp.example,10.20.0.0/16`). Metadata and link-local addresses stay refused. The hosted service never sets it."
- Compose: `NETRICS_CUSTOM_API_PRIVATE_HOSTS: ${NETRICS_CUSTOM_API_PRIVATE_HOSTS:-}` in the environment block shared by `api` and `worker` (both run connector calls; check that the block is shared, otherwise add it to both).
- Classification in `classifyConnectorError`: unchanged code path; `EgressTimeoutError` is not an `EgressDeniedError`, so it is redacted and retryable. Pin with a test.

- [ ] **Step 1: Write the failing tests**

```ts
// execute.test.ts
it("passes the host's egress policy to runtime.fetch", async () => {
  // fixture provider on 127.0.0.1 under a declared name; egress: { allowInsecureHttp: true, lookup: toLocalhost, allowPrivateHosts: ["api.fixture.test"] }
  // executeCheck succeeds; without allowPrivateHosts it fails with ContractViolationError /non-public address/
});
it("treats an egress timeout as a retryable provider failure", async () => {
  // egress: { ..., requestTimeoutMs: 100 } against a route that never answers:
  // rejects, not instanceof ContractViolationError
});
// env.test.ts
it("reads private hosts for custom APIs and defaults to none", () => {
  expect(loadConfig({}).customApiPrivateHosts).toEqual([]);
  expect(
    loadConfig({
      NETRICS_CUSTOM_API_PRIVATE_HOSTS: " intranet.example,10.20.0.0/16 ",
    }).customApiPrivateHosts,
  ).toEqual(["intranet.example", "10.20.0.0/16"]);
});
it.each(["*", "0.0.0.0/0", "::/0", "http://intranet"])(
  "refuses the private host entry %s",
  (entry) =>
    expect(() =>
      loadConfig({ NETRICS_CUSTOM_API_PRIVATE_HOSTS: entry }),
    ).toThrow(/NETRICS_CUSTOM_API_PRIVATE_HOSTS/),
);
```

- [ ] **Step 2: Run**

Run: `pnpm vitest run packages/connector-runtime/src/execute.test.ts -t "egress policy|egress timeout"` and `NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5433/postgres pnpm vitest run apps/server/src/env.test.ts -t "private host"`
Expected: FAIL (type error on the `egress` pick; config key missing).

- [ ] **Step 3: Implement** the pass-through, env, compose, `.env.example` and the docs.

- [ ] **Step 4: Run** both commands → PASS; then the full DoD (`pnpm format:check && pnpm lint && pnpm typecheck && NETRICS_TEST_ADMIN_URL=… pnpm test`).

- [ ] **Step 5: Commit** `feat(server): NETRICS_CUSTOM_API_PRIVATE_HOSTS for self-hosted custom APIs`

---

## Self-review notes

- Spec coverage. Section 9 (fields, types, modes, keys, reporting field, retention, versions, checkpoints; compatibility tests; no package release): Task 4. Section 8 role (string field, passed through like the unit, dropped on calculation/group unless carried unchanged): Tasks 1–3. Section 5 egress (DNS pinning, per-hop redirect validation with same-host, decompressed limit, per-request timeout, IPv4/IPv6/mapped/encoded/metadata tests, self-host private hosts off by default): Tasks 5–9. Anti-goals "reach a private address, a cloud metadata service, or another host by redirect or DNS change" and "send credentials to a different host": Tasks 5–7. Exit gate 6 (SSRF suite incl. decompression bombs, no credential in errors): Tasks 5–8.
- Left to other plans, on purpose: "a cap on JSON depth and record count" (spec 5) belongs to the executor that parses responses (C-G3), not to the byte-level guard; the 10 MiB / 50 MiB / 30 s custom-API values are passed by C-G3; redaction of the connection's secret values (spec 5, last bullet) is C-G3's; image-host rules (I-G1).
- Decisions made here, where the spec was silent: the contract is an ADR (0026), not a connector guide; roles are presentation metadata, so role changes are version-compatible and never a model schema change; an append with disagreeing roles drops the role instead of failing; `cast` always drops it; metadata and link-local addresses are never reachable, even when a self-hoster lists them; `allowPrivateHosts` never widens `outboundDomains`; DNS answers are pinned per egress instance (one connector call), refusals are not; credentials are stripped on every cross-origin hop in both redirect modes (a behaviour change for bundled connectors that none of them relies on); the decompressed limit defaults to the response limit and the timeout to the call budget, so existing callers see no change; undici `fetch` stays the client.
- Existing behaviour already in place and kept: address checks run inside the socket lookup (`egress.test.ts` "checks resolved addresses at connect time"); encoded IPv4 literals are normalised by the WHATWG URL parser before `checkUrl` (Task 6 pins it).
- Contract names used as in the overview: `role?: "image"`, SDK `0.2.17`, `pinDns`, `redirects: "same-host" | "allowlist"`, `maxDecompressedBytes`, `requestTimeoutMs`, `allowPrivateHosts?: readonly string[]`, `NETRICS_CUSTOM_API_PRIVATE_HOSTS` (read into `config.customApiPrivateHosts`), plus the tests-only `tlsCa` added during milestone reconciliation. The fixture server (C-G3) reaches `127.0.0.1` with `allowPrivateHosts: ["127.0.0.1"]` plus `allowInsecureHttp` (http) or `tlsCa` (https), tested in Task 6.
