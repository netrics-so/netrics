# Milestone 11 — completing the gates (design)

Status: proposed 2026-11-14. Extends [11-projects-and-derived-metrics.md](11-projects-and-derived-metrics.md)
and [ADR 0022](../decisions/0022-reusable-data-model-and-processing.md); where
this document is silent, those apply.

## Why

Most of milestone 11 is built and tested: the processing and semantic engine
(11B), dashboard bindings and filters (11D), and Apple / Google Play datasets
with multi-app setup (11E). An audit on 2026-11-14 (main `447fcc4`) checked
every gate criterion against code and tests. What remains keeps the gates
#441–#444 open:

- 11C promises a customer can derive fields, filter, append, map and publish a
  calculation **without writing code**. Today filter and calculate steps are a
  formula text box. Errors are one banner, not attached to the failing step,
  and nothing shows what a publish will affect.
- Store templates install once and can never be updated.
- Projects only group connections and dashboards; the plan's "project
  navigation checks" were never defined.
- Small gaps: no route/isolation test for `/data/preparations/preview`, no
  undo in the model editor, docs out of date, umbrella #439 closed while its
  gates are open.

The goal is to close every engineering criterion so the owner can run the
real-account acceptance (hosted and self-hosted) on a finished product.

## Goals

1. A customer builds common filters and calculations visually; the formula
   stays available and both describe the same stored definition.
2. Errors point at the step (and field) that caused them; downstream steps
   are marked as affected.
3. Before publishing a preparation, model or measure, the customer sees which
   models, dashboards and paired screens depend on it.
4. Store templates are versioned; a newer version is offered as a reviewable
   draft that keeps the customer's own changes.
5. Models and preparations can belong to a project; navigation filters by
   project; projects can be archived.
6. Model-editor undo, the missing preview-route tests, an end-to-end UI test
   of the 11C journey (English and German), docs and tracking brought up to
   date.

## Non-goals

- A block editor covering every function. Expressions outside the visual
  subset stay formula-only.
- Chart-to-filter interactions on Apple TV, iPad or kiosk. Paired screens keep
  their fixed device scope; interactions stay in the web viewer.
- Building prepared generations before switching a release (see Decisions).
- Gross-sales or estimate measures. Net proceeds only; gross stays available
  in `provider_fields`.
- Project memberships, per-project permissions, or moving data between
  workspaces.
- Automatic template updates. Updates are always offered, never applied
  silently.

## Anti-goals (failure even if it "works")

- The visual builder and the formula ever disagree about a definition, or
  switching views changes a saved definition.
- A template update overwrites a customer's change without asking, or goes
  live without review: data through draft → preview → publish, dashboards
  through an updated copy the customer swaps in.
- A draft, a template update or a project change alters a published
  dashboard or a paired screen before publication.
- Any new query or listing path skips workspace isolation (RLS plus explicit
  `workspace_id`) or device scope.
- German is missing on any new screen.

## Constraints

- Everything in `CLAUDE.md`: definition of done, forward-only migrations
  tried on data in the previous shape, tenant isolation twice, OpenAPI
  regenerated, one issue per PR.
- One shared expression AST: `DataExpression` in
  `packages/domain/src/data-expression.ts` (field / literal / call over
  `DATA_FUNCTIONS`). No second representation is stored.
- Existing draft, history, restore and publish flows (#475, #481) are the
  only way definitions go live.
- Roles: existing `data:*` capabilities (preview / edit / publish) gate every
  new action.
- Older device payloads (schemas 1–3) and offline playback stay byte-for-byte
  compatible.

## Approaches considered

**Visual builder.**

- _A — rows for common cases, formula for the rest (chosen)._ Conditions as
  rows of field · operator · value joined by "all of" / "any of";
  calculations as value · operator · value. Both compile to and parse from
  `DataExpression`. An expression outside the subset opens in the formula
  view with a note.
- _B — full block editor for every function._ Complete, but much larger,
  cluttered for simple cases, and adds little over the formula for power
  users.
  The owner chose A.

**Template updates.**

- _A — an update arrives as a draft (chosen)._ "Update available" with a
  summary; applying creates drafts in the normal draft → preview → publish
  flow; untouched customer changes are kept; collisions are flagged for a
  choice; history/restore covers rollback.
- _B — apply directly with a keep-mine / take-theirs screen._ Simpler to
  explain, but bypasses the draft review: the only place publishing would.
  The owner chose A.

## Decisions

### Visual builder (11C)

- **Visual subset.** Conditions: a field compared with a literal or another
  field via `eq ne lt lte gt gte in contains starts_with is_null` (and their
  negation through `not`), combined by one level of `and` / `or`; one level of
  grouping (a group of rows inside the top level) is allowed. Calculations:
  two operands (field or literal) with `add subtract multiply divide`,
  optionally wrapped in `round` / `abs` / `coalesce`, and `if(condition,
a, b)` where the condition is a visual condition.
- **Round-trip rule.** `toVisual(expr)` returns either a visual model or
  "not representable" (with the reason). `fromVisual(model)` returns a
  `DataExpression`. Invariant, tested by property tests over generated
  expressions: for every representable `expr`,
  `fromVisual(toVisual(expr))` is structurally equal to `expr`. Opening and
  saving without edits never changes the stored definition.
- **Editing.** The builder offers only fields and operators whose types fit
  (the engine's type checker decides, not the UI). Literals are typed inputs
  (date picker, decimal with currency, boolean toggle).
- **Formula completion.** Function names, field names and operators,
  with argument hints from the same type information.
- **Where.** Filter and calculate steps in the preparation editor, and
  measure filters / calculated measures in the model editor.

### Step-attributed errors (11C)

- `DataProcessingError` gains an optional step (node) identifier; graph
  execution and validation set it. The API returns it with the code and
  field.
- The preparation editor shows the error on that step, marks later steps as
  "affected", and keeps earlier steps' previews usable.
- Error codes keep mapping to translated messages; generic banners remain
  only for errors with no step.

### Impact before publish (11C)

- A server endpoint lists, for a preparation, model or measure, the
  dependent models, measures, dashboards (and widgets) and paired screens,
  workspace-scoped and filtered by what the caller may see; items the
  caller can't see are counted, not named.
- The publish confirmation shows this list. Publishing is not blocked by
  dependents; it is blocked only by existing validation.

### Template updates (11E)

- Scope: the App Store / Google Play portfolio templates
  (`store-template-service.ts`, `store-portfolio.ts`). The plain Studio
  dashboard templates (`templates.ts`) are one-time starting points and get
  no updates. _(Builder-check call.)_
- Each store template has a version. An install records the template
  version, its install inputs (connections, app scope, name, locale) and,
  per created record, the original content it was created from.
- **Baseline for installs made before this change** _(builder-check call)_:
  their inputs were never stored. The original of each preparation and model
  is its first published version / release (the install publishes those at
  creation). The original of each installed dashboard is its current
  content at migration time, treated as unchanged by the customer.
- **App scope is not a customer change** _(builder-check call)_: adding or
  removing apps re-generates the scope-derived parts (mappings, products,
  per-app preparations) from the stored inputs; those differences are never
  shown as conflicts.
- **Dashboards have no draft step** (Studio edits go live immediately), so
  widget changes don't go through drafts. _(Owner decision 2026-11-14.)_
  Data changes (preparations, models, measures) arrive as drafts; widget
  changes create an **updated copy** of the affected dashboard, unassigned
  from screens. The customer compares it in Studio and, when satisfied,
  swaps it onto the original's screens in one step (the original is kept,
  archived, for rollback). A copy is created only after the data drafts it
  depends on are published, so it never shows unpublished definitions.
- A newer version shows "Update available" on the template's dashboards and
  in data settings, with a summary (added / changed / removed measures,
  steps, widgets).
- Applying it compares three states per record: original template,
  customer's current record, new template. Unchanged-by-customer records take
  the new content; customer-only changes are kept; when both changed the same
  thing, the customer chooses per item. The result is data drafts published through the normal flow, plus
  updated dashboard copies (below). Removed template parts are proposed for
  removal, never deleted automatically.
- Rollback: data via the existing history / restore; dashboards by swapping
  the archived original back.

### Projects (11E navigation)

- Models and preparations get an optional `project_id`, like connections and
  dashboards. Projects get `archived_at`.
- Reference tables (manual datasets) have no project: they are shared
  lookups (app or campaign mappings), so every project lists them and its
  editors may read them (#644). Source datasets follow their connection's
  project, prepared outputs their preparation's.
- Navigation (data, dashboards, connections) is filtered by the user's
  stored active project (`memberships.active_project_id`, existing route), so
  the choice follows the user across pages and sessions; "All" (null) stays
  the default. The dashboards page's client-side filter moves to it. If the
  active project is archived, it falls back to "All". _(Builder-check call.)_
- The existing hard delete (`projects:delete`, items' `project_id` set to
  null) stays unchanged; archive is added next to it. _(Builder-check call.)_
- Archiving hides a project and its items from navigation and pickers but
  never stops published dashboards or paired screens; un-archiving restores
  it.
- "Project navigation checks" means: a test that every list and picker
  respects the project filter and workspace isolation, and that archived
  projects disappear from pickers but keep working on screens.

### Engine behaviour on failed builds (documentation)

The code computes prepared results lazily and falls back to the last valid
result of the same release and query, marked stale. ADR 0022 describes
building before switching the release. The owner accepted the current
behaviour; an ADR 0022 addendum records it, including that a filter
combination never queried before shows an error rather than stale data
after a failure.

### Smaller items

- Route and isolation tests for `/data/preparations/preview`, added to the
  device-scope query-path list.
- Undo / redo in the model editor, matching the preparation editor.
- Google Play ratings: label the source ("public Play Store listing") in the
  UI and connector docs.
- Docs: milestone README status, this design linked from the milestone plan,
  ADR addendum. Reopen #439 until all gates and the owner's acceptance pass.

## Order

1. Quick items: preview-route tests, docs/ADR addendum, reopen #439, Play
   ratings label.
2. Step-attributed errors.
3. Visual builder + formula completion (largest; may span two PRs: domain
   round-trip, then UI).
4. Impact before publish.
5. Model-editor undo.
6. End-to-end UI test of the 11C journey in English and German.
7. Projects.
8. Versioned template updates.
9. Owner acceptance run (hosted and self-hosted, real accounts).

## Left to the builder

- Exact visual-model types, component structure and layout, following the
  existing design system and editors.
- Endpoint names and payload shapes (contracts + OpenAPI).
- How template versions, inputs and originals are stored (columns vs. a
  table), as long as the three-way comparison is possible and the migration
  applies the baseline rule above to existing installs.
- Splitting each item into issues and PRs.
