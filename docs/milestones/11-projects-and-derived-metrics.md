# Milestone 11 — Reusable data models and dashboard filtering

## Outcome

A customer connects several systems, prepares their data, relates shared
entities, defines named measures, and creates dashboards with consistent
filters. Templates provide a useful starting point and remain editable through
the same tools. Apple and Google Play app metrics are the first complete
journey; a non-store scenario proves reuse.

Scope direction agreed with the owner on 2026-11-04; implementation authorized
on 2026-11-05. The architecture
in [ADR 0022](../decisions/0022-reusable-data-model-and-processing.md) is
accepted. This plan expands the previous derived-metrics milestone; none of
the gates below is recorded as complete. Keep this filename for existing links.

## Dependencies

- Existing ingestion, tenancy and jobs (milestones 02–03)
- Dashboard and widget models (milestones 04 and 09–09.3)
- Existing connectors as compatibility sources (05, 07, 08 and 10)
- No dependency on publishing the community SDK (12) or a custom API UI (13)

The dataset SDK capability is designed here, then stabilized and published in 12. Custom APIs in 13 use this processing engine. Existing owner acceptance
gates remain open independently; a new plan does not close them.

## In scope

- Typed source datasets, retained provider fields, schema versions and replay
- Reusable preparation graphs with visual steps and a safe expression editor
- Select, rename, extract, cast, filter, replace, deduplicate, calculate, group,
  append and validated joins
- Shared dimension datasets and confirmed cross-source entity mappings
- Semantic models, typed relationships and reusable named measures
- Arithmetic, conditional and boolean logic, ratios, aggregation, distinct
  counts, latest snapshots and bounded time comparisons/rolling windows
- Preview, lineage, freshness, coverage, errors, publication and rollback
- Dashboard filters, widget applicability, saved screen state and chart-driven
  filter interactions
- Complete Apple/Google Play downloads, financial and rating templates;
  explicit source semantics and limits, including multi-app setup/management
- Compatibility for existing observations, dashboards, devices and compare
  widgets; "Save as measure" from a compare widget
- Project creation, editing, archive, navigation and optional assignment of
  connections, models and dashboards, without changing workspace tenancy

## Delivery gates

### 11A — Dataset and ingestion foundation

Define and migrate dataset/schema/batch/record/generation metadata and storage.
Specify source identity, revision, complete-partition replacement, tombstones,
checkpoint durability and generation publication. Declare field classification,
retention defaults, storage/row budgets, preview limits and replay availability.
Version the SDK capability without breaking current connectors. Wrap existing
observations as explicitly aggregated datasets.

Gate: a fixture source with string, decimal, boolean, date and JSON fields can
backfill, resume after interruption, correct records and replay a retained
window without duplicates. An incomplete refresh never publishes partial data
or infers deletion. RLS, tenant-aware FKs and storage access checks pass.

### 11B — Processing and semantic query engine

Implement typed graph validation/execution, row and aggregate expression scopes,
prepared generations, shared dimensions, entity mappings and model releases.
Support single-direction one-to-one/many-to-one relationships and explicit
inner/left preparation joins. Validate fanout and output grain. Aggregate facts
independently before combining them across common dimensions. Define query and
build budgets and invalidation for corrections and rolling dependencies.

Gate: deterministic fixtures exercise each operation and type, null/boolean
truth tables, aggregate filter context, currency/time/grain checks, late
corrections, cardinality failures and generation-consistent queries. A failed
build leaves the previous published release usable with visible status.

### 11C — Data preparation and model UX

Build a source table preview, ordered preparation steps, before/after preview,
field naming, formula completion, relationship/mapping editor and a measure
catalog. Show errors at the responsible step and downstream impact before
publish. Offer undo, explicit template updates and rollback where data permits.
Use existing workspace roles with explicit preview/edit/publish capabilities.

Gate: a customer can derive a boolean field, filter records, append sources,
confirm an entity mapping and publish a named calculation without writing
code. Visual and formula editing produce the same definition. Drafts never
change published dashboards. English and German cover the full journey.

### 11D — Dashboard query bindings and filters

Add model measure/grouping bindings and typed dashboard filter definitions.
Implement date/dimension controls, defaults, reset, explicit widget overrides
and declared chart-to-filter interactions. Validate applicability in Studio.
Intersect viewer choices with authorization and fixed device scope. Include
model/data versions, coverage, freshness and applied filters in results/caches.
Keep native/kiosk calculation on the server and preserve older payloads.

Gate: one date/product/country filter consistently changes applicable widgets
from several sources. Unsupported combinations fail visibly; no widget ignores
a filter silently. Existing dashboard/compare/device payload behavior passes
parity checks, including offline cached playback. Compare can save a reusable
measure. Cross-workspace and device-scope tests cover every query path.

### 11E — App portfolio and general-purpose proof

Upgrade Apple source retention and complete Google Play ingestion. Resolve the
rating data source/scope, rating counts and whether scores can be combined;
do not substitute a written-review average for the store's rating. Separate
proceeds, gross sales and estimates with their reporting delays. Document the
chosen provider capabilities before claiming support for a metric.

Provide guided account connection, permission checks, recognizable app
selection with search/select-all, adding/removing apps later without repeating
credentials, confirmed cross-store mappings, and ready-made portfolio/per-app
dashboards. Templates create normal editable preparation/model/widget records.
Refresh status, partial permissions, missing reports and reauthorization must
be actionable beside affected data. Record historical replay limitations.

Gate: connect several apps per platform, see downloads/proceeds/ratings without
manual Studio configuration, filter across them, modify one reusable measure
and publish it to every dependent dashboard. Run hosted and self-hosted with
real accounts. Separately combine advertising and website data by a shared
campaign mapping with no app-specific core code; reject unsupported granular
revenue rather than duplicating it. Complete the project navigation checks.

## Out of scope

- Arbitrary SQL or JavaScript execution
- Automatic many-to-many or bidirectional semantic relationships
- General streaming or data-warehouse infrastructure
- Project-specific memberships or custom row-access policy authoring
- Machine-learning forecasting or silently applied AI transformations

Suggestions are inspectable proposals with source fields, expressions and
assumptions. Customers confirm identity mappings and definition changes.

## Final exit gate

All five gates pass. A customer connects Apple, Google Play and another system,
installs useful templates, prepares a custom dataset, relates shared entities,
defines numeric and boolean measures, and creates a filtered overview shown in
the browser and on a paired screen. One shared-definition change updates every
dependent dashboard after publication. Retry, correction, invalid joins,
missing data, rollback, permission loss and legacy migration are demonstrated
without double-counting or cross-workspace access.

Before implementation PRs, split each gate into GitHub issues with one
reviewable change per PR. GitHub issues remain the source of truth for open
implementation work; this plan does not create or complete issue records.

## GitHub tracking

- Umbrella: [#439](https://github.com/netrics-so/netrics/issues/439)
- 11A: [#440](https://github.com/netrics-so/netrics/issues/440)
- 11B: [#441](https://github.com/netrics-so/netrics/issues/441)
  - Cooperative sync continuations across configurable page budgets:
    [#456](https://github.com/netrics-so/netrics/issues/456).
  - Definition preview/publication before the first complete source report:
    [#460](https://github.com/netrics-so/netrics/issues/460). This prepares
    template installation without fabricated zero values or empty generations.
  - Representative workload checks and resolved legacy catalog ceiling:
    [#466](https://github.com/netrics-so/netrics/issues/466). See the measured
    boundaries; broader retained-history/concurrency acceptance remains open.
  - Durable parsed Google report staging for worker/app/page continuations:
    [#472](https://github.com/netrics-so/netrics/issues/472). Initial buffered
    provider parsing and the wider scale acceptance remain open.
  - Incremental, range-bounded Google Play report parsing:
    [#488](https://github.com/netrics-so/netrics/issues/488). Reports above the
    fetch limit are read as pinned byte ranges and parsed row by row; typed rows
    of one report task are still collected before staging, and the wider scale
    acceptance remains open.
  - Rolling-window and period-offset measures:
    [#486](https://github.com/netrics-so/netrics/issues/486). Date-only
    anchors, windows recomputed from rows, capped month/year offsets, lookback
    that never adds result rows, and partial results for incomplete history
    (ADR 0022 addendum). Late corrections change the windows that contain them.
- 11C: [#442](https://github.com/netrics-so/netrics/issues/442)
  - Existing-step editing, explicit append matching and typed reference authoring:
    [#464](https://github.com/netrics-so/netrics/issues/464).
  - Published definition history and explicit restore-to-draft with historical
    input pins and matching authoring metadata:
    [#470](https://github.com/netrics-so/netrics/issues/470). Source corrections
    remain current; unpublished draft history/source-value rollback is not implied.
- 11D: [#443](https://github.com/netrics-so/netrics/issues/443)
  - Immutable semantic result continuation across corrections/publication:
    [#471](https://github.com/netrics-so/netrics/issues/471). Opt-in API sessions
    pin retained inputs.
  - Declared chart-to-filter interactions:
    [#490](https://github.com/netrics-so/netrics/issues/490). Table, bar and line
    widgets set one shared filter from a clicked value, validated at save and in
    Studio; browser-only, device payloads unchanged.
  - Fixed device scope controls and query-path scope tests:
    [#500](https://github.com/netrics-so/netrics/issues/500). Per-filter values or
    ranges set on a paired screen and conjoined on the server with every choice;
    widgets that cannot follow it fail or are withheld, never shown unscoped.
    Dashboard data, model queries, paged sessions and device payloads are tested
    for cross-workspace and device-scope isolation; payload schemas unchanged.
  - Compare widget compiled into a generated preparation and draft measure
    (step 1 of [#499](https://github.com/netrics-so/netrics/issues/499)):
    [#506](https://github.com/netrics-so/netrics/issues/506). Both observation
    datasets are scoped, tagged and appended; the ratio and its change compare
    with the previous range, equal to the widget for today and the last 7, 30
    and 90 days of daily sum or average metrics. Min/max/last, hourly metrics
    and unpinned currencies are refused with typed errors.
  - Optional measure binding on compare widgets (step 2 of
    [#499](https://github.com/netrics-so/netrics/issues/499)):
    [#507](https://github.com/netrics-so/netrics/issues/507). A bound widget
    stays a compare widget with its period, layout and payload shape; screens,
    kiosks and Studio read the published numerator, denominator and ratio over
    the period's current and previous windows as closed date ranges, equal to
    the inline widget for all nine periods, so no period is refused any more.
    Unpublished, removed, foreign or mismatched measures fail with typed errors
    and never fall back to the metrics; unbound payloads are unchanged, and
    scoped screens still withhold compare widgets.
  - Studio "Save as measure" and rebind for compare widgets (step 3, closing
    [#499](https://github.com/netrics-so/netrics/issues/499)):
    [#508](https://github.com/netrics-so/netrics/issues/508). A preview names
    the preparation, model and measures before anything is created, and words
    each typed refusal; an unpinned per-currency amount can be retried with a
    picked currency. The draft model is published in Data & measures (the
    existing flow, `data:publish`), then the widget is rebound as a normal
    draft edit and can be unbound to its kept metrics. Bound widgets name
    their measure and show its typed errors, in English and German.
    Compare-to-measure is complete; the rest of the 11D gate remains open.
- 11E: [#444](https://github.com/netrics-so/netrics/issues/444)
  - Apple storefront rating snapshots: [#452](https://github.com/netrics-so/netrics/issues/452).
    Implements the scoped raw rating/count source, not the complete portfolio
    template or Google Play gate.
  - Original Apple sales rows and authoritative app/window corrections:
    [#454](https://github.com/netrics-so/netrics/issues/454). General preparations
    can calculate proceeds and classify downloads from these retained fields.

  - Per-connection dataset retention in setup and settings (personal data
    preset to 90 days, connector defaults otherwise, workspace maximum still
    caps; existing connections recorded unchanged):
    [#492](https://github.com/netrics-so/netrics/issues/492).

  - Google Play report datasets, scoped public listing ratings, stored-credential
    setup preview and app management: [#457](https://github.com/netrics-so/netrics/issues/457).
    Connector integration proves exact proceeds/corrections, OAuth refresh and
    workspace isolation. Editable portfolio templates, confirmed cross-store
    mappings and dashboard source-health actions are implemented in
    [#462](https://github.com/netrics-so/netrics/issues/462). Real-account
    acceptance remains open. See [current implementation boundaries](../connectors/google-play.md#current-implementation-boundaries).

  - Persisted non-store campaign proof, explicit column matching and a reproducible
    advertising/website import walkthrough:
    [#465](https://github.com/netrics-so/netrics/issues/465). Synthetic fixtures
    exercise the generic engine; real-account acceptance remains separate.
