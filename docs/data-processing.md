# Data processing implementation

The architecture is [ADR 0022](./decisions/0022-reusable-data-model-and-processing.md).
Implementation is tracked in [#439](https://github.com/netrics-so/netrics/issues/439).
The dataset foundation, processing engine, data authoring workspace and first
published-measure dashboard bindings are implemented in stacked draft pull
requests. Editable app-store portfolio templates and published-definition
restoration are included; advanced authoring and dashboard interactions remain
separate delivery work.

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

SDK 0.2.10 adds optional `runtime.datasetStaging` for immutable parsed transport
pages. [#472](https://github.com/netrics-so/netrics/issues/472) uses it for Google
Play reports: the host scopes storage to the connection/workspace, validates and
hashes page contents, admits staged bytes under a separate workspace cache
budget and expires them within 24 hours or the shorter source/tier retention. Committing a
staged page verifies its exact rows/window and preserves the original source
collection time and retention deadline. Repeated reads cannot renew retention.
Scheduler maintenance removes expired chunks. See [ADR 0023](./decisions/0023-connector-dataset-staging.md).

SDK 0.2.11 adds optional `datasetStaging.begin`, which writes a stage page by
page: `append` validates, stores and counts each batch against the byte budget,
`commit` makes the stage readable with its final metadata, and `abort` (or the
end of the connector call) discards the draft. `put` remains and writes through
the same steps. Stage pages are stored gzip-compressed, and the stage limit and
`maxConnectorStagingBytes` count the stored compressed bytes. See
[ADR 0024](./decisions/0024-streaming-connector-staging.md).

Google continuations read the needed parsed page instead of downloading and
parsing each report again. Each turn still discovers current reports and checks
object-level access to the pinned generations. Corrections or expired staging
restart the pending partition. The initial download/parse remains buffered under
the existing HTTP and decompression safeguards; this does not establish support
for arbitrarily large provider files.

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
access; available for the refresh behind the current generation). Replay preserves the original collection time and expiry. Published
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
  "maxConnectorStagingBytes": 134217728,
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

[#476](https://github.com/netrics-so/netrics/issues/476) separates raw retention
from the optional connector cache. `maxWorkspaceBytes` now counts retained raw
pages and records only; it no longer includes parsed connector staging.
`maxConnectorStagingBytes` independently caps the aggregate accounted bytes of
live stages in each workspace, with a 128 MiB default. Since
[ADR 0024](./decisions/0024-streaming-connector-staging.md) (#525) these are the
stored gzip-compressed page bytes plus accounting overhead, counted for
committed stages and open drafts, and no longer the serialized JSONB size: the
same setting now admits several times more parsed rows than before. `0` refuses new stages; `null` removes that admission ceiling.
Lowering the cache budget,
including to `0`, leaves already admitted live stages usable until their
existing expiry. Reads and repeated identical writes do not renew retention.
Expired stages stop consuming admission capacity before scheduled pruning.

Stage admission refusal makes Google Play use its buffered ingestion path;
the raw import still has to fit `maxWorkspaceBytes`. This is an explicit change
from the initial shared raw/staging quota. Connector staging and prepared caches
have separate budgets, so total managed storage can exceed the raw storage cap.
Installation defaults and the existing workspace policy API configure these
budgets without an SDK or database schema change. The individual 128 MiB stage,
1 MiB metadata and page/record safeguards remain in force even when the
aggregate cache budget is `null`.

Retained raw storage and source-count policy defaults are uncapped. One source
generation holds at most the smaller of `maxGenerationRows` and `queryRows`, since
no read could load a larger one; see `docs/data-scale-validation.md`. Execution
defaults are 100,000 rows, 5 million operations and 128 MiB of output per evaluation, 15
seconds per database statement and 100 connector pages per sync attempt. All
are configurable, including `null`. They govern an individual execution, not
the amount of retained history. Dataset ingestion applies the statement timeout
only to its own statements and restores the caller's setting afterwards, so
checkpoint and other sync work in the same transaction keep their own bound.
With `queryTimeoutMs: null`, ingestion statements still stop after 5 minutes
(`DATASET_INGEST_TIMEOUT_MS`). Page sessions and ordinary last-valid query
snapshots each default to 100 identities per release and a one-day lifetime.
The additional `queryPageSessionsPerCaller` policy defaults to 10 page sessions
per authenticated user/release; users share that limit across tabs and login
sessions. A positive reduction affects new admission only. `null` removes the
caller limit while the aggregate `querySnapshotCount` still applies; `0` disables
starting and continuing pinned pages without disabling ordinary queries/fallback.
These limits do not reserve slots, and the aggregate pool can still fill.
Setting `querySnapshotCount` or `querySnapshotSeconds` to `0` disables storing
and reusing both snapshot pools, including last-valid fallback.
Prepared cache entries default to one day,
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
until deleted. Personal fields require an explicit retention declaration in the
connector. The shortest finite source/field/tier retention applies to the
complete record. A shorter workspace retention policy immediately reduces
stored deadlines and clears derived caches; increasing it later cannot revive
expired data. After a policy change with `maxRetentionDays`, every deadline is
the earlier of its stored value and the new ceiling, counted in fixed
86,400-second days. Only the records, generations, refreshes and stages whose
deadline moves are written (#518): repeating a ceiling, raising it, or changing
another policy value while a ceiling is set writes no record and keeps derived
caches. The change reaches a workspace's records through its generations and
the record primary key, so it does not read other workspaces' records. It runs
as one statement per table under the workspace ingestion lock, so a deadline
that moves into the past is stored before any reader or later page sees the old
one; a call that moves nothing still reads the workspace's records once under
that lock (about 0.6 s for 4.16 M records in the scale suite), and a call that sets a
first ceiling on records kept until deleted writes each of them. Replay
preserves original collection time and deadlines.
Credentials, headers and tokens never belong in datasets.

### Retention per connection

Each connection chooses how long each of its connector's datasets is kept
(#492), in the setup step and in the connection's "Data retention" settings.
The choice is days after collection or "until deleted", per dataset, and it
replaces the connector's declared dataset and field retention for that
connection:

- A dataset with personal-classified fields starts at 90 days (or the
  connector's shorter declaration). The person can choose a longer period,
  "until deleted", or a shorter one.
- Other datasets start at the connector's declared retention (the shortest
  finite dataset/field `retentionDays`) and can be changed too.
- The workspace maximum (`maxRetentionDays`) still caps every choice; the
  shortest finite period wins. Settings show when that cap applies.
- Saving applies at once, in the same transaction, through
  `apply_connection_retention`: unexpired records and the current generation of
  each dataset, unexpired refreshes and live connector stages take the new
  deadline from their collection time. A shorter period therefore removes
  access immediately and clears derived caches (query snapshots and prepared
  outputs), as the workspace policy does. A longer period only extends data
  that has not expired yet; expired, superseded or released data is never
  revived. Later ingestion and staging use the choice as well. As with the
  workspace policy, only rows whose deadline changes are written, and derived
  caches are cleared only when one did (#518); saving the same choice again
  writes nothing.
- Ingestion, connector staging, connection retention saves and workspace
  policy changes take the same workspace lock before they read or apply
  retention, so a sync page in flight during a change either commits first
  and is shortened, or waits and uses the new values.
- The connection records the choice, who made it and when
  (`connections.retention_*`), and the audit log records
  `connection.retention_updated` with the chosen values. A connection created
  without a choice shows "Preset" until someone saves one.

Connections that existed before per-connection retention keep what they had:
migration `0061_connection_retention` records each registered dataset's
declared retention as an explicit choice, with the migration time and no
person, and datasets they register later follow the connector default instead
of the preset. Personal fields are not cut to 90 days retroactively, and the
migration deletes nothing. New connections get the 90-day preset.

App Store review texts are stored outside the dataset engine and keep their
own fixed bound (90 days, at most 50 per app); per-connection retention does
not cover them.

Expired rows are excluded at read time. Hourly scheduler maintenance removes
expired rows, pages, prepared outputs and query snapshots in batches through
`prune_dataset_history_batch`, repeating bounded batches until one comes back
short or a 10-second budget is spent; a drain that ends with work left resumes
on the next scheduler tick rather than an hour later. Prune never waits for a
row lock (#517): it locks every row it changes or deletes with `SKIP LOCKED`,
so rows that a policy change, a connection-retention change or ingestion holds
are left for a later call. Records of a released generation are taken
generation by generation, and a generation whose first record is held (tried
with `NOWAIT`, which fails at once) is skipped as a whole, so a call does not
pass over every held record again. Prune deletes a stage, refresh or generation only
once a snapshot taken after its lock shows no child rows for the cascade to
lock. A transaction that never waits cannot be part of a deadlock, so prune and
those changes no longer abort each other; a change waits at most for one prune
call. Each call also reports whether rows it would prune remain (skipped or
newly eligible), and a short batch with rows remaining keeps the drain going on
the next tick. Each hourly maintenance task (dataset history, finished jobs,
OAuth authorizations, pending keys, security records, review text) runs on its
own; a failure is logged and the others still run, and a failed dataset drain
is retried on the next tick. The scheduler has no direct read access to source
records. Dataset/model tables use forced RLS and explicit tenant predicates.

Retention bounds the current generation, not every copy of it. Each upsert,
append or replacement refresh publishes a complete new generation, so a
superseded generation is released once nothing can legitimately read it: no
unexpired last-valid query snapshot or pinned page session names it, and its
successor is at least 15 minutes old. That grace covers request transactions
that read a generation before committing the snapshot that pins it. Nothing else
pins raw generations: ingestion reads only the latest one, prepared caches hold
their own output rows and are reachable only through the current input vector,
and published definition history and restore store no generation identities.
A pinned generation stays readable until the last snapshot or session naming it
expires, even with `retentionDays: null`; source retention still ends it sooner.
Maintenance marks a released generation expired (readers that still name it fail
with an explicit expiry error, never a partial read) and then removes its records.
Raw pages of a complete refresh are kept only while its generation is current,
for `replayDatasetRefresh`; an incomplete refresh that a newer published refresh
has made unpublishable also loses its pages. Their metadata rows remain until
source retention so a late retry is still rejected rather than republished.
`maxWorkspaceBytes` counts only current and pinned generations and the pages of
live refreshes. Superseded copies awaiting maintenance do not count, so
frequent refreshes of the same dataset do not accumulate quota usage; physical
storage carries the copies published within the grace period plus one
maintenance interval, and a larger backlog is drained tick by tick instead of
growing unseen.

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
  measures, formulas over measures, and rolling and period-offset measures.
  `preview` uses the draft; `publish` creates an immutable release; `query`
  evaluates the active release.

### Rolling and period-offset measures

A `rolling` measure re-aggregates an aggregate base measure over a window that
ends on each date (`day` 1–366, `week` 1–53 or `month` 1–12). A
`period_offset` measure evaluates any base measure over an earlier interval
(`day`, `week`, `month`, one `year`, or one `range`, the length of the query's
date range) and returns its `value`, the `change` or the `percent_change`. Its
result cells carry `comparedTo` with the inclusive dates that were compared.

```json
{
  "id": "revenue_7d",
  "name": "Revenue, 7 days",
  "kind": "rolling",
  "baseMeasureId": "revenue",
  "timeDimensionId": "day",
  "window": { "unit": "day", "length": 7 }
}
```

Both reference a date dimension with `reporting_date` alignment; timestamps
are refused. Rolling measures and dated offsets require that dimension in
`groupBy`; ungrouped `range`, `month` and `year` offsets require a closed date
range instead. Write the date range as top-level `and` bounds on the time
dimension (`gte`, `gt`, `lte`, `lt`, `eq`); dashboard date filters do this. Rows
before the range are read as lookback and never appear as result rows. Month
and year offsets cap the day at the month end (2024-03-31 minus one month is
2024-02-29). Windows recompute from rows, so averages and distinct counts stay
exact. History that starts after a window's first day yields `partial` with
`model_window_history_incomplete`; history starts at the dataset's earliest
retained row, not per app or other partition, so an app added to a connection
later reads as complete from its first window. Grouped results only have
dates with rows in the range; empty dates get no rolling value. Lookback across nested measures is at most
800 days. Invalid definitions fail publication, and unsupported queries or
dashboard bindings fail, with a `model_window_*` code, for example `model_window_base_aggregate_required`,
`model_window_date_dimension_required`, `model_window_time_grouping_required`,
`model_window_time_filter_unsupported`, `model_window_currency_mismatch` or
`model_window_lookback_limit`. See ADR 0022, "Addendum: rolling and
period-offset measures".

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
choice. Omitted mappings keep the existing union-by-ID behavior. An append cannot read the
same step twice (that would duplicate its rows); the editor refuses a removal
that would produce one. Missing values
remain null; schema/unit/currency incompatibilities still fail validation.
[#470](https://github.com/netrics-so/netrics/issues/470) adds paged published
definition history for preparations and models. **Restore as draft** creates a
new saved draft with optimistic concurrency; active dashboards keep their current
release until preview and explicit publication. Restored definitions preserve
their historical nested preparation versions and model schema bindings. Editors
load metadata under those same pins, including fields/outputs removed from the
latest catalog. Restored joins/appends use that context in source previews too.
**Use latest published inputs** intentionally clears the restored pins and
requires a new preview before publication.

[#480](https://github.com/netrics-so/netrics/issues/480) lets restored models
ignore historical fields they no longer depend on, including unused fields
projected out by nested preparations. Restore, draft preview and publication
check the complete model's dimensions, labels, relationships and aggregates,
including filter/order fields and currency companions. The check follows the
exact pinned preparation versions down to their source fields. Filters, joins,
deduplication and grouping retain the dependencies that determine output rows,
even for `COUNT(*)`; a cast does not hide a used input's changed type merely
because its output type stays the same. Formula references name measures, not
unrelated source columns with the same name.

Draft input metadata remains readable when a used field is incompatible, so an
editor can remove that dependency and preview the repair. Metadata loading still
reauthorizes sources and validates the actual pinned preparations. Preview and
publication reject changed type/unit/currency bindings for fields still in use;
they do not implicitly adopt newer preparation versions. Newly referenced
current fields without a historical binding must pass semantic validation.
Published queries retain their existing full-schema compatibility checks. A
repaired draft changes active dashboards only after explicit publication.

Dependency analysis follows field and row dependencies alongside the canonical
preparation executor using schema-only tables. It neither copies source values
nor changes prepared-cache storage, and requires no database migration.

Restoration reauthorizes and validates currently retained inputs; it cannot
recover removed or expired sources. Source-data corrections continue to apply.
History contains published definitions, not every unpublished draft or old source
values; the current preparation/model name is preserved. Both restore and publish
are audited. Failed restoration leaves the draft unchanged; failed publication
keeps the active release usable.
Other authoring/lifecycle acceptance remains in
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
Saving validates only the filter mappings and measure widgets it adds or
changes (including widgets of a model whose filters changed). A binding left
unchanged after its model was republished does not block unrelated edits; it
reports its problem when queried.

A table, bar or line widget can declare one chart-to-filter interaction
([#490](https://github.com/netrics-so/netrics/issues/490)): its binding names a
shared filter (`interaction: { filterId }`), and a viewer clicking a category,
point or row value sets that filter. A values filter is set to the clicked value
and a range filter to the one-value range `from = to`; a missing value cannot set
a range. Clicking the selected value again restores the saved default (or all
values when the default is that value), the choice shows in the shared filter
bar, and **Reset filters** clears it. The filter applies to every widget mapped to
it, including the one clicked. A declaration is valid only for a filter the widget
follows (not excluded) whose mapping for the widget's model is one of its
groupings; otherwise saving fails with a `dashboard_interaction_*` code, and
Studio lists it as a problem before saving. Removing the filter in Studio removes
the declaration. A click changes only the viewer's filter values; the server
evaluates them like any other choice, under the viewer's authorization and fixed
scopes. The interaction is browser-only: the Studio canvas, the web TV view and
paired screens stay non-interactive, and device payloads never include the
binding, so native and cached clients are unchanged.

A paired screen can have a fixed scope
([#500](https://github.com/netrics-so/netrics/issues/500)): owners and admins
choose, per shared filter of the screen's dashboard, the values or range the
screen may show (Screens → a screen → Fixed scope). It is stored on the device
with the dashboard it was set for and read from the device row, never from the
request; a device cannot send filter values at all. `dashboardModelQuery`, the
one place every dashboard widget query is built (saved data, preview and device
payloads), conjoins it with the saved choice and the dashboard's own fixed scope,
so it can only narrow. Like a dashboard fixed scope it cannot be excluded: a
scope that names an unknown filter, restricts nothing (an empty list or open
range) or meets a widget that excludes the filter fails, on save with a
`device_scope_*` code and, if the dashboard changes later, per widget on the
screen instead of an unscoped result. Older observation, goal and review widgets
cannot follow shared filters: a scope cannot be set while the dashboard has
them, and a scoped screen does not get them. Changing a scoped screen's
dashboard requires a new scope (or removing it) in the same request. The scope
appears in each widget's `scope` labels and in `appliedFilter`, next to the
release and generation identities; the server's payload memo is keyed by it,
and payloads keep their released schemas, so older and offline-cached screens
read them unchanged.

`dashboards/published-models` exposes the published measure/dimension catalog
without raw source fields or drafts. `dashboards/data/preview` evaluates unsaved
widget bindings against published models only, and `dashboards/:id/data`
evaluates saved bindings. Workspace authorization and forced RLS apply to each
path. One dashboard request uses a repeatable-read transaction, with individual
widget failures isolated by savepoints. Reads write only caches (last-valid
snapshots, prepared outputs); when concurrent reads of the same query race on
those writes, the losing read skips caching instead of failing its widget. Responses include release/generation
identities, applied predicates, scope, source refresh time when known, expiry,
warnings and explicit exclusions. Source refresh time describes ingestion, not
the provider's reporting coverage or delay.

Semantic queries support ordered result pages with `limit` and `offset`, up to
1,000 groups per response. This bounds one response rather than the number of
groups in a model. Ordinary offset requests read current generations separately.
[#471](https://github.com/netrics-so/netrics/issues/471) adds opt-in immutable
continuation with `pinPages: true` and `pageToken`: pages retain the original
model release and source/prepared generation identities across corrections and
publication. Each continuation reauthorizes its inputs and fails if pinned
history, caches or metadata fingerprints are unavailable; it never renews the
deadline or silently changes data. Caller-bound sessions use the authenticated
user identity; a different user cannot continue the token. Pinned first-page
requests do not populate ordinary fallback capacity. Ordinary dashboard/device
requests do not allocate page sessions. The caller-bound key namespace requires
older unowned tokens to restart, without a SQL schema migration. See [the API,
capacity and upgrade rules](./data-query-pagination.md).
Multi-select filters use typed list membership without growing a deep expression tree.
Line charts and date-grouped bar charts show the most recent `limit` points,
still in ascending order; `offset` and `totalRows` in the result say how many
earlier points were left out. Tables and other charts show the first groups.

Device schemas 2/3 include server-computed measure results. The shared native
and browser renderers support values, tables and charts without calculating
measures on the device; native cached payloads preserve decimal strings,
publication/source identities and scope. Expired results are hidden offline.
Semantic dashboards bypass the legacy device TTL cache so model publication,
source corrections and retention changes are checked on each payload request.
Existing observation dashboards keep their existing cache and payload behavior.
Older native builds keep their existing unknown-widget fallback and need an
update to display the new measure type.

Saving a compare widget as a reusable measure,
advanced device-specific scope controls and remaining authoring/history work
stay in [#443](https://github.com/netrics-so/netrics/issues/443) and the other
milestone 11 gates. This first dashboard slice does not close that entire gate.

The current executor evaluates typed JSONB rows in memory and materializes
prepared outputs in JSONB. Removing policy ceilings does not yet provide a
streaming or SQL execution path. Representative-volume checks and a scalable
execution/storage path remain release work; this implementation does not claim
a tested unbounded workload. Lifecycle controls and advanced authoring
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
metadata, not a retained historical resource-name snapshot: a last-valid
fallback reads the current catalog with its retained report/reference
generations rather than failing once apps are added or renamed. It is excluded from
report freshness timestamps; retained report/reference generations determine those.

Apple first-download units and Google daily user installs stay separated by store.
Proceeds include signed refunds, fees and adjustments, with currencies kept apart:
new installations declare currency as a required dimension of proceeds, as
downloads require store.
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
sizes. [The Google staging fixture](./data-scale-validation.md#google-report-staging-check)
also covers 20,001 install rows across restarted connector instances. Initial
buffered provider parsing, full-copy generation storage, concurrent execution and
scalable catalog/reference editing remain open before claiming larger capacity.
