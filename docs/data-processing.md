# Data processing implementation

The architecture is [ADR 0022](./decisions/0022-reusable-data-model-and-processing.md).
Implementation is tracked in [#439](https://github.com/netrics-so/netrics/issues/439).
The dataset foundation, processing engine and first data authoring workspace
are implemented in stacked draft pull requests. Dashboard integration and
connector templates remain separate delivery gates.

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

Reference imports currently publish one snapshot per request (up to 10,000
records and the API body budget). Large paged imports, editing existing
reference tables, preparation step editing/reordering, multi-key join forms
and explicit version history/rollback controls remain tracked in
[#442](https://github.com/netrics-so/netrics/issues/442). The engine already
accepts multi-key joins and versioned definitions through the API.

The current executor evaluates typed JSONB rows in memory and materializes
prepared outputs in JSONB. Removing policy ceilings does not yet provide a
streaming or SQL execution path. Representative-volume checks and a scalable
execution/storage path remain release work; this implementation does not claim
a tested unbounded workload. Rolling/previous-period calculations, explicit
rollback/history controls, advanced authoring controls, widget integration
and connector templates remain tracked in milestone 11.
