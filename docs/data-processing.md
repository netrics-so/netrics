# Data processing implementation

The architecture is [ADR 0022](./decisions/0022-reusable-data-model-and-processing.md).
Implementation is tracked in [#439](https://github.com/netrics-so/netrics/issues/439).
The dataset foundation, processing engine, data authoring workspace and first
published-measure dashboard bindings are implemented in stacked draft pull
requests. Editable app-store portfolio templates are included; advanced
authoring, history and dashboard interactions remain separate delivery work.

Store connectors can declare `supportsResourceSelection` to offer one stored
account credential with a configurable app scope. Stored-connection preview
checks draft config and discovers apps without saving or enqueueing an import.
An atomic settings update accepts `resources: null` for all current/future apps,
an explicit list for selected apps, or `[]` to collect no new app data. Omission
preserves the existing scope; none of these choices deletes retained history.

Aggregates such as sum, average, minimum and maximum keep their known result
when some input values are null, but mark it partial and emit
`aggregate_missing_inputs`. Formulas inherit that partial status. Count and
three-valued boolean semantics distinguish unknown inputs from false. A deliberate
filter excluding missing rows is evaluated before aggregation. Execution version 4
invalidates older prepared/query caches so pending-input status is preserved.

Definition previews and publication can use a newly registered source's schema
before its first complete report arrives. Previews show a waiting note and no
calculated rows; publication stores definitions and schema bindings without
creating raw or prepared generations. Raw previews still report
`data_source_pending`. Model queries retain known values as partial and include
pending source identities. A wholly pending count is null, never zero; boolean
aggregates preserve unknown truth unless a known value decides the result.
Incomplete inputs never create prepared generations or last-valid query snapshots.
The definitions read the first complete generation without republishing. Available
inputs still undergo actual relationship/cardinality checks during publication.

`data_datasets.has_published_data` survives retention pruning. A source that
once published data cannot become a schema-only first import after its history
is removed. Migration 0056 conservatively marks all pre-migration sources as
historical, since older retention may have removed evidence of publication;
an existing unfinished source therefore needs its next complete import before
using this path. Removed, foreign and expired inputs remain unavailable.

## Typed source datasets

SDK 0.2.9 adds optional `manifest.datasets` and `SyncResult.datasetPages`.
Observation connectors remain supported. A dataset-only connector declares
`metrics: []` and at least one dataset. Fields use stable IDs rather than
editable labels. Integer values must be safe integers; `number` is a finite
floating-point value; `decimal` is an exact plain decimal string (38 digits,
at most 18 fractional digits). Money fields declare a unit and a non-null
currency field; floating-point money is rejected. Dates are reporting dates,
while timestamps are UTC instants. Keep provider date/time semantics explicit.

```ts
const dataset = sourceDatasetSchema.parse({
  key: "orders",
  name: "Orders",
  version: 1,
  grain: "one order",
  mode: "upsert",
  keyFields: ["id"],
  reportingField: "day",
  reportingTimeZone: "Europe/Berlin",
  fields: [
    {
      id: "id",
      name: "Order",
      type: "string",
      nullable: false,
      classification: "internal",
    },
    {
      id: "day",
      name: "Date",
      type: "date",
      nullable: false,
      classification: "internal",
    },
    {
      id: "paid",
      name: "Paid",
      type: "boolean",
      nullable: false,
      classification: "internal",
    },
    {
      id: "amount",
      name: "Amount",
      type: "decimal",
      nullable: false,
      classification: "internal",
      unit: "currency",
      currencyField: "currency",
      scale: 2,
    },
    {
      id: "currency",
      name: "Currency",
      type: "string",
      nullable: false,
      classification: "internal",
    },
  ],
});

// Include `dataset` in manifest.datasets. Inside sync():
return {
  observations: [],
  datasetPages: [
    {
      datasetKey: "orders",
      schemaVersion: 1,
      refreshKey: "provider-report-revision-1",
      pageKey: "page-1",
      previousPageKey: null,
      records: [
        {
          values: {
            id: "order-1",
            day: "2026-11-05",
            paid: true,
            amount: "12.50",
            currency: "EUR",
          },
        },
      ],
      complete: true,
    },
  ],
  done: true,
};
```

A refresh key identifies one immutable source refresh in a connection/dataset.
It must remain stable across retries, including when the host resumes from a
saved connection cursor. Each page names its predecessor. A repeated identical
page is a no-op; different content under the same page key is a contract error.
Do not restart at a new refresh key when resuming the middle of an earlier one.
A new provider report revision requires a new refresh key. A final sync result
cannot contain an incomplete dataset page.

## Publication and replay

Pages and connection checkpoints commit together. Staged records are not
queryable. The last complete page creates a published source generation in
one transaction. Upserts merge by the declared source key; append datasets
reject conflicting event identities; snapshots replace the dataset only when
complete. `replace_window` pages declare a half-open reporting window and
optional typed partition predicates. All records must fall inside that scope;
other partitions/dates survive. Only upserts accept explicit key-only tombstones.
Conflicting duplicate keys inside one refresh fail rather than guess a winner.

Schemas are immutable per version. Compatible upgrades may add nullable fields
or change labels. Changing keys/types/units needs a full snapshot rebuild;
retention/classification changes require an explicit policy migration. An older
in-progress snapshot cannot overwrite a newer published refresh.

The database exports `previewDataset` (bounded, workspace-scoped) and
`replayDatasetRefresh` (rebuild from retained complete pages without network
access). Replay preserves the original collection time and expiry. Published
row values remain typed JSONB source views; prepared analytical relations,
expression graphs and semantic queries are described below.

Legacy observation descriptors from `listObservationDatasets` explicitly mark
their already-aggregated grain. Daily values remain reporting dates; the adapter
does not claim a provider timezone or reconstruct raw transactions. Existing
observation queries and retention remain unchanged.

## Policy, execution budgets and retention

Storage volume, refresh size, source/app count, preparation/model count and
retention are installation/tier policy, not fixed product ceilings. Instance
defaults are read at runtime from `NETRICS_DATA_POLICY` (a JSON object). Omitted
keys use `DEFAULT_DATA_POLICY`; `null` removes that policy ceiling. Workspace
overrides inherit those instance defaults. For example:

```json
{
  "maxWorkspaceBytes": null,
  "maxGenerationRows": null,
  "maxRefreshPages": null,
  "maxSources": null,
  "queryRows": 1000000,
  "queryOperations": 50000000,
  "maxRetentionDays": null
}
```

The installation API exposes `GET/PUT /v1/admin/workspaces/:id/data-policy`.
Instance administrators qualify; service tokens need the separate
`installation:data-policy:read` or `installation:data-policy:write` scope.
Workspace owners/editors cannot raise their tier's policy. PUT replaces the
overrides; `{}` restores inheritance. No billing plan identifiers are built
into the dataset or processing schema. A hosted plan service can manage these
overrides; self-hosters control the same defaults and API.

Storage and source-count policy defaults are uncapped. Execution defaults are
100,000 rows, 5 million operations and 128 MiB of output per evaluation, 15
seconds per database statement and 100 connector pages per sync attempt. All
are configurable, including `null`. They govern an individual execution, not
the amount of retained history. Query snapshots default to 100 identities per
release and a one-day lifetime; prepared cache entries default to one day,
bounded by the earliest source expiry. Those policies are configurable too.
Wire safeguards remain: 100 fields, 1,000 records/1 MiB per page, 64 KiB per
record, 1 KiB per key, and 100 rows per preview. Paged ingestion can exceed one
page; expression depth and permitted functions stay bounded. These safeguards
protect transport and execution rather than defining customer data quotas.

The connector-page budget is a scheduling quantum. After that many committed
pages, the worker records a `continued` segment and requeues the same durable
job with its checkpoint and original reporting window. This releases its lease
for other work without increasing failed attempts or marking the connection
as an outage. The next worker turn resumes that job; a large finite backfill
can span any number of such turns. Only the final page advances last-success
time. Genuine provider failures still use the retry policy, and malformed or
non-advancing connector results still fail as contract errors. A connector that
keeps advancing forever keeps using its configured execution share until an
operator cancels it; the page budget does not infer that the account is too
large.

Source retention defaults to 30 days after collection. A source can request
any positive retention period or explicitly use `retentionDays: null` to retain
until deleted. Personal fields require an explicit retention choice; no fixed
90-day rule is imposed. The shortest finite source/field/tier retention applies
to the complete record. A shorter workspace retention policy immediately
reduces stored deadlines and clears derived caches; increasing it later cannot
revive expired data. Replay preserves original collection time and deadlines.
Credentials, headers and tokens never belong in datasets.

Expired rows are excluded at read time. Hourly scheduler maintenance removes
expired rows, pages, prepared outputs and query snapshots in batches through
`prune_dataset_history`. The scheduler has no direct read access to source
records. Dataset/model tables use forced RLS and explicit tenant predicates.

## Preparations and semantic models

Workspace editors can use the data API under `/v1/workspaces/:id/data`:

- `sources` and `preview` expose typed fields and bounded previews, including
  legacy observations, entered reference tables and published preparations.
- `manual` publishes reference snapshots with generation-based optimistic
  concurrency. Creating an existing key never overwrites it.
- `formula` parses readable expressions such as `[Revenue] / [Downloads]`
  into stable field references. Arbitrary code and SQL are unavailable.
- `preparations` stores graph drafts. Select, rename, cast, replace, filter,
  calculate, deduplicate, append, validated inner/left joins and aggregation
  are supported. `preview` evaluates without publishing; `publish` validates
  outputs and records an immutable version.
- `models` stores shared dimensions, directed relationships, aggregate
  measures and formulas over measures. `preview` uses the draft; `publish`
  creates an immutable release; `query` evaluates the active release.

Each query pins source generations in one serializable transaction. Independent
facts aggregate before their results combine, preventing join fanout. Typed
filters apply to every operand through declared dimensions; incompatible
filters fail. Exact decimal money stays a string, mixed-currency totals fail,
and divide-by-zero produces null with a warning. Missing values remain distinct
from zero. Prepared generations are identified by preparation version and input
provenance; late corrections invalidate them automatically on the next read.

Published models pin preparation definition versions while reading newer
compatible source generations. Editing drafts cannot change live queries.
Republishing a model adopts newer preparation definitions. A failed build
leaves its previous publication active. A previously successful query can
fall back to its complete retained source vector after a processing/schema
failure, with `stale: true`, the error code and a warning. Fallback re-authorizes
every source and cannot restore removed or expired data. Legacy observation
snapshots cannot be reconstructed after their values change.

## Data authoring workspace

Workspace editors can open **Data & measures** to inspect typed datasets,
create entered reference tables, paste CSV/TSV, prepare data and publish models.
Preparation forms cover selection, renaming, casts, replacement, filtering,
calculated columns, deduplication, append, single-key joins and grouping.
Readable formulas and field insertion use the same typed expression tree as
the API. Each step can be previewed independently of later steps; undo and
unsaved-change protection keep draft changes recoverable during editing.

Model authoring includes dataset selection, directed relationships, shared
dimensions, aggregate measures and formulas over measures. An unsaved
definition can be previewed with grouping and a shared typed filter before
saving or publishing. Numeric, boolean and exact decimal money results retain
their types. Publication validates relationship cardinality even for ungrouped
queries. English and German cover the workspace, including responsive layouts.

Reference imports and edits publish complete snapshots through bounded transport
pages. The editor can declare units, currency columns, exact decimal precision
and nullable values; monetary amounts require a non-null currency identity.
Incompatible field types stay disabled until their currency/precision metadata
is explicitly removed, so an edit cannot silently turn money into a scalar.

[#464](https://github.com/netrics-so/netrics/issues/464) adds editing of existing
preparation steps, safe removal/reordering, multiple join keys, multiple renamed
columns and aggregate filters. Changes preview every output before applying;
undo restores the prior graph. Sources, merges, shared branches and public outputs
constrain which moves/removals are safe, with explanations. Appending a step or
removing a final unary operation preserves the public prepared-dataset identity.
A published model keeps its pinned preparation definitions until the customer
previews it and chooses **Publish updated inputs**, creating a new model release.

Append can explicitly match independently authored columns with different field
IDs. `columnMappings` maps each input node's source-field IDs to output-field IDs;
a mapped input projects only the confirmed columns, including required currency
companions. The form proposes matches by name and requires an explicit matching
choice. Omitted mappings keep the existing union-by-ID behavior. Missing values
remain null; schema/unit/currency incompatibilities still fail validation.
Persistent version history and rollback controls remain tracked in
[#442](https://github.com/netrics-so/netrics/issues/442).

## Published measures on dashboards

Studio includes a **Measure** widget with value, table, bar and time-series
views. Bind it to a published model, select named measures and shared grouping
dimensions, and optionally apply an additional typed formula filter. Boolean
values remain boolean; exact money strings never pass through floating-point
formatting. Minor-unit currencies use their ISO exponent. Unsafe chart
magnitudes use a readable table instead of silently rounding the shown value.

Dashboard settings define shared typed filters, their model/dimension mappings,
defaults and optional fixed scopes. Viewers search available dimension values,
select multiple values, choose date/numeric ranges, or reset to the saved
defaults. Viewer choices are conjoined with fixed scope and widget predicates.
Every affected model needs a mapping. Independent widgets require an explicit
exclusion and explanation; fixed scopes cannot be excluded. Older observation
widgets require explicit exclusions before a shared filter can be saved.

`dashboards/published-models` exposes the published measure/dimension catalog
without raw source fields or drafts. `dashboards/data/preview` evaluates unsaved
widget bindings against published models only, and `dashboards/:id/data`
evaluates saved bindings. Workspace authorization and forced RLS apply to each
path. One dashboard request uses a repeatable-read transaction, with individual
widget failures isolated by savepoints. Responses include release/generation
identities, applied predicates, scope, source refresh time when known, expiry,
warnings and explicit exclusions. Source refresh time describes ingestion, not
the provider's reporting coverage or delay.

Semantic queries support ordered result pages with `limit` and `offset`, up to
1,000 groups per response. This bounds one response rather than the number of
groups in a model. Each request pins its own current generations; clients that
page a changing model must compare provenance and restart if it changes. An
immutable cursor spanning several requests remains future work. Multi-select
filters use typed list membership without growing a deep expression tree.

Device schemas 2/3 include server-computed measure results. The shared native
and browser renderers support values, tables and charts without calculating
measures on the device; native cached payloads preserve decimal strings,
publication/source identities and scope. Expired results are hidden offline.
Semantic dashboards bypass the legacy device TTL cache so model publication,
source corrections and retention changes are checked on each payload request.
Existing observation dashboards keep their existing cache and payload behavior.
Older native builds keep their existing unknown-widget fallback and need an
update to display the new measure type.

Chart-driven filter interactions, saving a compare widget as a reusable measure,
advanced device-specific scope controls and remaining authoring/history work
stay in [#443](https://github.com/netrics-so/netrics/issues/443) and the other
milestone 11 gates. This first dashboard slice does not close that entire gate.

The current executor evaluates typed JSONB rows in memory and materializes
prepared outputs in JSONB. Removing policy ceilings does not yet provide a
streaming or SQL execution path. Representative-volume checks and a scalable
execution/storage path remain release work; this implementation does not claim
a tested unbounded workload. Rolling/previous-period calculations, explicit
rollback/history controls, advanced authoring controls, dashboard interactions
remain tracked in milestone 11.

## Editable app portfolio templates

[#462](https://github.com/netrics-so/netrics/issues/462) adds an account chooser,
searchable app selection, explicit cross-store product links and a review step at
`/workspaces/:id/dashboards/stores`. Matching names are suggestions that require
confirmation. A customer can create a portfolio or a dashboard fixed to one
app/product. The starting date filter covers all retained history.

Installation creates ordinary manual tables (Products and Confirmed app mapping),
preparations, three published models, three table widgets and six shared filters.
Rename a product once in Products; change a listing's product ID in the mapping
table. Future apps retain their source identity until explicitly linked. Resource
names are exposed as a tenant-scoped `resources:<connectionId>` dataset whose
content fingerprint invalidates dependent outputs when names change. It is current
metadata, not a retained historical resource-name snapshot. It is excluded from
report freshness timestamps; retained report/reference generations determine those.

Apple first-download units and Google daily user installs stay separated by store.
Proceeds include signed refunds, fees and adjustments, with currencies kept apart.
Ratings use the latest snapshot per listing and rating country; linking products
never combines listing scores. Measures can declare required dimensions: group by
those dimensions or fix each to a single value in a conjunctive filter. Formula
measures inherit the requirements of their dependencies. `OR` and multi-value
filters do not satisfy a single-value requirement. Stable identity values are kept
separate from optional dimension display labels in queries, filter choices and
native payloads.

Each affected widget includes connection health and, in the workspace browser,
a link to resolve missing access, reauthorization, failed sync or paused app
selection. Retained history remains queryable after authorization is revoked;
source health describes collection, not permission to read retained workspace data.
A filter exclusion is shown when that filter is active.

Installation is atomic and keyed by a workspace/request UUID and normalized
request hash. Retry returns the installed IDs without duplicating records or
replacing customer edits; a changed request with the same UUID is rejected. Policy
failures roll back datasets, definitions and dashboards. Migration 0057 adds a
forced-RLS installation ledger and is exercised on populated 0056 data.

Reference tables can be edited through Data & measures. Reading pins a retained
generation and pages through every record, rather than treating the preview as the
whole table. Saving stages bounded transport pages and publishes one complete
snapshot. Concurrent edits require the current generation; retries cannot publish
duplicates. Cancelled staged edits do not publish rows or reserve the next editor's
definition permanently. Staging data follows dataset retention/maintenance policy;
there is no separate cancel-upload garbage collector yet. Empty text, null, false,
zero and exact decimal strings remain distinct. The UI renders 50 rows at a time
but currently holds the whole editable table in browser memory. Source and query
budgets still apply; paging does not claim warehouse-scale execution.

## Non-store campaign example

[#465](https://github.com/netrics-so/netrics/issues/465) supplies a persisted
advertising + website proof and [six CSV imports with a customer walkthrough](./examples/campaign-dashboard.md).
Different source identities require confirmed campaign links. Independently authored
columns are explicitly matched before append. Independent fact aggregation keeps
ad spend and website revenue correct, including shared campaign/market/day filters,
fixed scope, exact money, boolean measures, corrections and shared publication.
Unsupported keyword-level revenue and ambiguous/fanout joins are rejected. These
synthetic imports prove reuse of the same engine; they do not implement a new
advertising connector or replace real-account hosted/self-hosted acceptance.

## Measured workload boundaries

[#466](https://github.com/netrics-so/netrics/issues/466) adds an opt-in persisted
workload check and [measured local results with remaining scaling work](./data-scale-validation.md).
It covers 5,001 source records, 1,300 resource identities and a separate 100,001-row
in-memory query. The legacy observation catalog now uses the configured row policy
instead of a fixed 1,000-entry ceiling; individual observation reads fetch their
specific scoped descriptor. These checks establish correctness at the measured
sizes. Provider report staging, full-copy generation storage, concurrent execution
and scalable catalog/reference editing remain open before claiming larger capacity.
