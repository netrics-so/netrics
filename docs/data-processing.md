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

SDK 0.2.12 adds optional `receivedDatasets` to a final (`done`) sync result:
the declared source datasets the run checked completely, with or without rows.
One that has no rows stored is then received and empty instead of pending: the
host stores an empty generation, again on each such run so its refresh time
follows the checks. It never replaces stored rows, and a dataset whose history
was published and is gone stays `data_source_history_unavailable`. Google Play
declares its rating rows, which exist only for months with a readable rating
report, so an account without any no longer keeps the ratings model pending
([#666](https://github.com/netrics-so/netrics/issues/666)); a month whose
report is not published, not permitted or unreadable still emits only its
availability row and never replaces that month's stored rows.

Google continuations read the needed parsed page instead of downloading and
parsing each report again. Each turn still discovers current reports and checks
object-level access to the pinned generations. Corrections or expired staging
restart the pending partition. Since #519 the initial read streams the report
into the stage page by page, within the existing HTTP and decompression
safeguards (64 MiB per report); this does not establish support for
arbitrarily large provider files.

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

Stage admission refusal makes Google Play continue without a stage, reading
the report again for up to eight pages of one app per turn (#519); the raw
import still has to fit `maxWorkspaceBytes`. This is an explicit change
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
the next tick. Prune takes and checks expired records in deadline order
(`ORDER BY expires_at` with a limit), so it reads the record expiry index
whether few or most records have expired and whichever plan PostgreSQL caches,
instead of scanning the whole table (#524). Each hourly maintenance task (dataset history, finished jobs,
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
Republishing a model adopts newer preparation definitions it reads directly.
A published preparation pins the preparations it reads in the same way, and a
model reading it inherits those pins. Publishing a published preparation or
model again, even unchanged, adopts the newer published versions of what it
reads as a new version (release) and changes nothing when they are current.
Publishing again builds the definition first, so inputs that are broken,
pending or over a limit now fail it where it used to change nothing. A
restored version keeps the inputs it was restored with: publishing it again
changes nothing, and only an edit (a new draft) or "adopt latest inputs"
re-pins it.

A store-template update therefore drafts, besides the records the template
changes, every template preparation and model that reads a drafted
preparation, listed after their inputs. A draft published before the
update's versions of its inputs pins their earlier versions: the update shows
it as "needs publishing again" (not published), its dashboard copy is not
ready and an update without dashboards stays open until it is published
again. Only the update's own versions count: once every draft is published
after them, an update without dashboards is closed, and publishing one of
its inputs again later (for any reason) never reopens it. An update whose
plan changes nothing (only the customer's own changes, which it keeps) is
not offered. A failed build
leaves its previous publication active. A previously successful query can
fall back to its complete retained source vector after a processing/schema
failure, with `stale: true`, the error code and a warning. Fallback re-authorizes
every source and cannot restore removed or expired data. Legacy observation
snapshots cannot be reconstructed after their values change.

### Time grains for grouped dates and timestamps

A query can group a date or timestamp dimension into calendar buckets
(ADR 0028): `groupByGrain` names, per grouped dimension, `day`, `week` (ISO,
Monday) or `month`.

```json
{
  "measureIds": ["photos"],
  "groupBy": ["taken"],
  "groupByGrain": { "taken": "day" }
}
```

The group's value is the bucket's first day as a date (`2026-11-02`), so
groups sort, page and read like any date; `limit`, `offset` and an order by
a measure apply to the buckets. A timestamp's day is its day in the
workspace time zone; a date is never shifted. Filters compare the
dimension's own values. A grain on any other type, on a dimension that is
not grouped by, or on the date a rolling or period-offset measure runs on
is refused, and a week or month does not satisfy a measure's
`requiredDimensions`. `day` on a date changes nothing and is not stored.
Measure widgets store the same field in their binding; Studio offers it next
to a grouped time dimension, limited to what the widget's measures allow
(each catalog measure lists its `fixedGrainDimensions`). A timestamp newly
ticked there starts per day, where the measures allow it; that is Studio's
starting choice only, and a binding without the field stays a group per
instant.

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
downloads require store. Since template version 3, the proceeds preparations
leave out rows without proceeds (free units, empty report rows), so a currency
without proceeds in the period has no row, and a row without a currency (ISO
4217 `XXX`) is labelled "No currency" / "Ohne Währung". One "App labels"
preparation reads the combined downloads data (the selected apps with
downloads or installs) and gives each app one label: where apps of different
stores share a display name, each app that lives in one store reads "Name ·
Store"; a product linked across stores keeps its name. Each metric's labelled
preparation adds that label, and all three models and the app filter show
it, so an app reads the same in every widget. Labels read the downloads data
only, so a pending or failing proceeds or ratings source never holds up or
fails the downloads model; an app with proceeds or ratings but no downloads
keeps its plain name in every model, even where another store has an app of
that name. Existing
installs get version 3 through the template update.
Ratings use the latest snapshot per listing and rating country; linking products
never combines listing scores. Measures can declare required dimensions: group by
those dimensions or fix each to a single value in a conjunctive filter. Formula
measures inherit the requirements of their dependencies. `OR` and multi-value
filters do not satisfy a single-value requirement. Stable identity values are kept
separate from optional dimension display labels in queries, filter choices and
native payloads. A typed filter may name either: a string compared with a
labelled dimension (`=`, `!=`, `in`) that is not one of its values but is one of
its labels stands for the values shown with that label, so `[Store] = "Google
Play"` matches what the preview shows. A value spelled like another value's
label keeps its meaning, and `appliedFilter` reports the resolved values.

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

### App identity

[#708](https://github.com/netrics-so/netrics/issues/708) gives each product
of an install an icon, paid or free, and an optional website, set under "App
identity" on the screen that changes the install's apps
(`GET`/`PUT .../dashboard-templates/stores/installs/:requestId/products`). The
products resolve exactly as the template's preparations resolve each row: an
app's product is its mapping row's product ID, else its app key; the name is
the product's Products row, else its first app's name, else the app ID. Every
app of the install's connections is listed, discovered or only named by the
synced reports (no cut-off; past the query row limit of the deployment's data
policy and the workspace's overrides the read answers 413). Unsaved identity
changes are saved or discarded, in the page, before a scope change applies,
and the identity is read-only while it applies and opens the update.

- **Icon:** the stored resource icon of the product's first App Store app,
  else Play app, that has one, resolved when read. The daily icon refresh
  replaces it in place; "Use app icon" fetches it the first time.
- **Paid or free:** `auto` (default), `paid` or `free`. Auto is paid while
  one of the product's apps had proceeds in the last 90 days: an App Store
  sales row with units × developer proceeds per unit above zero, or a Play
  earnings row with a positive amount (charges; fees and refunds are
  negative), read when the products are read. Nothing is stored for auto, so
  it follows new reports.

The Products and mapping tables and the synced reports are read through the
same data reader as dashboards, with the resolved policy's row budget,
retention ceiling and stored expiry. "Use app icon" is offered for discovered
apps only; an app only the reports or the mapping name has no icon to fetch.

- **Website:** a project of a Vercel Web Analytics connection of the same
  workspace, checked when saved.

A product ID longer than 500 characters, or empty, is valid in the tables
but cannot have settings: it is listed as not editable, and saving it
answers 400 `store_product_id_too_long`.

The settings are rows of `data_template_products` (migration 0079, forced
RLS), not fields of the Products table: apps without a product have no row
there, a website typed into that freely editable table could not be checked
against the workspace, and new fields would change every install's table. A
product without a row has the defaults, so existing installs need no update.
A composite foreign key binds the website connection to the row's workspace;
deleting the connection clears only the link.

### App slides (template version 4)

[#709](https://github.com/netrics-so/netrics/issues/709) makes the App
portfolio an overview plus one slide per app, for screens that advance on
their own (auto advance is on).

- **Overview** (first slide): version 3's tables (downloads by app and
  store, proceeds by app and currency, ratings), plus revenue by app in the
  workspace's display currency for each App Store connection (a connection
  `table` of `proceeds`; models do not convert currencies) and website
  visitors for each Vercel connection an app links: at most two of each and
  three in all, so the overview's tables fit two rows of at most three,
  each the four columns a table needs. A connection table's title is the
  longest of its wordings that stays readable in every format at every
  theme font scale (with several App Store connections, the connection's
  name), and it lists three rows.
- **One slide per app**, scoped to it (the slide's `app` scope, #707), with
  the app's icon as the slide's logo. Paid: revenue and downloads (connection
  metrics of the app's App Store app over the last 30 days, with sparkline
  and change: the trend), the website's visitors (`vercel.visitors` of the
  linked project), ratings with their count (a measure table) and the latest
  review. Free: the same without revenue. No linked website: no visitors
  widget. An app without an App Store app (Google Play only) shows its
  installs and proceeds per currency as measures and has no review. A
  product in both stores shows its App Store app's numbers, titled "· App
  Store"; the overview has both stores.
- **Which app**: the latest review, revenue and downloads read the
  product's first listed App Store app (from the mapping), not the slide
  scope, which names a product. Connection widgets cannot apply model
  filters; they exclude each shared filter with a reason.
- **Limits**: apps are ordered by name; the first get a slide while the
  dashboard stays within 12 slides and 48 data widgets (the overview
  included). The install answers the others as `omittedApps` and the setup
  names them; they appear on the overview only. Only apps a connection lists
  get a slide. A dashboard fixed to one app keeps version 3's single slide.

The identity is read when an install or update is built, never per device
payload, and stored with the install's inputs (`apps`: name, paid or free,
icon, App Store app, stores, website). An app added or removed, paid or
free changed, a new icon or website, or a renamed product makes the install
offer a template update (same version) whose plan shows the slide changes;
customised dashboards follow the usual three-way rules, and nothing changes
on screens before the updated copy is swapped in. The install list says
`newerVersion` while a record is not built from the latest version (an
update applied but not swapped in, closed or swapped back): the apps
cannot change before that update, as for any version update; an update
that only follows changed apps leaves them editable. A scope change fetches
the missing icons of the apps it would show. The comparison is with
the apps the active dashboard was built from (stored with its template
record), so an update closed before its swap, or swapped back, is offered
again. The daily icon refresh replaces an icon in that baseline too, by
the new icon of the same app: a product in both stores whose Play icon was
refreshed is offered its App Store icon once that arrives (#734). A slide's name is the product's name, else (an empty name is valid
in the Products table) its first app's name, else that app's id. An icon
the daily refresh replaced after an update was applied is the product's
current icon when the updated copy is made. A scope change builds
from the current identity too. Before an install, a plan or an apply,
icons the apps lack are fetched through the resource-icon path ("Use app
icon"); an icon that cannot be fetched leaves the slide without a logo.
Version 3 installs get version 4 through the template update.

### Tables that fit their tiles (template version 5)

[#768](https://github.com/netrics-so/netrics/issues/768): version 4's
overview asked for up to twenty rows in a four-row tile, and screens cut
rows and footer lines. Measure tables now fit their tiles, on the web and
in netrics TV alike (`measureTableRowsShown`, ported to NetricsKit and
checked against the same test vectors): the title (two lines at most), the
column heads and the rows, wrapped in even columns, take the room the
footer lines leave ("N of M groups", the slide's app, the freshness line or
the oldest source refresh, notices). Rows give way first, so the footer is
never cut, and "Showing N of M groups" counts the rows on screen. The
result follows from the payload and the tile's size alone, so nothing is
measured after drawing; scroll views, whose cards grow with their content,
show every row.

Column heads keep their words whole on web screens and in netrics TV
([#780](https://github.com/netrics-so/netrics/issues/780)): where a head
has a word wider than an even share of the table ("Downloads" at font scale
1.3 in a third of a screen) and every head's widest word fits side by side,
that column is as wide as the word needs and the others share the rest
(`measureTableColumnWidths`, the `wholeHeadWords` input of the fit). The
rows are counted with those widths. Where the words cannot all fit, the
shares stay even and a word breaks, as before; nothing is cut. Scroll
cards keep their own columns. Both renderers are checked against the same
test vectors (`measureColumnWidths`, `measureRowsShownWholeHeads`).

The readability check estimates the same layout with sample lines: fewer
rows than the `limit` is `rows_cut` as info; not even one row (or no room
for the footer) is `rows_cut` as attention.

Version 5 keeps version 4's single overview. Its model tables ask for their
top twenty (a measure widget's `order` ranks groups by one measure before
the limit: downloads by downloads, ratings by rating count; proceeds keep
their app and currency order, as amounts in different currencies do not
rank) and screens show what fits. The overview's ratings show the rating
and its count, as on the app slides: six columns leave no row in a third of
the width. A Google Play app's proceeds table sits beside its ratings,
where a row fits at every theme font scale. The tables show short column
heads under their titles (a measure widget's `labels`: "Downloads",
"Proceeds", "App", "Country", "Ratings"), and the App Store sources name
their store "App Store", so every table holds a row in every format at
every theme font scale.

The fit counts text with measured glyph widths per renderer
(`MEASURE_GLYPH_EMS`: IBM Plex Sans on the web, the system font with
tabular digits on netrics TV, regular and semibold; the readability check
counts the wider), draws row lines inside the rows, and keeps a screen
pixel of rounding room per line and per column. netrics TV draws the
tile's texts at the line heights the fit counts, and its footer lines
never shrink.

On iPad and iPhone netrics TV draws a unit at less than a point, so its
text is smaller than a TV's 24 pt and more, and the system font is wider
there: its optical size changes between 28 pt and 17 pt, and below 17 pt
every glyph is tracked wider ("Habit Tracker" by 7 % at 12 pt). The fit
takes the points a unit is drawn at (`points`) and counts the system font
as it draws at that size: a second table at 17 pt (`tvSmall`) and a short
table of blend and tracking by size (`MEASURE_TV_SMALL_SIZES`), measured
with Core Text ([#780](https://github.com/netrics-so/netrics/issues/780)).
From 24 pt, and without `points`, the widths are the TV's as before. Web
screens draw IBM Plex Sans, whose glyphs are as wide in em at every size,
so a phone's browser needs none of this.

A version 4 install sees "… · App Store" on its screens
once the update's data drafts are published, before the dashboard copy is
swapped in.

Version 4 installs get version 5 through the reviewed template update.

### Both stores on a linked product's slide (template version 6)

[#784](https://github.com/netrics-so/netrics/issues/784): a product in both
stores showed only its App Store app's numbers on its slide. From version
6 its slide shows both stores:

- **Downloads**: a total with a line per store ("635", "App Store 412",
  "Google Play 223"): the downloads model in a value view grouped by store.
  A measure value view with a grouping shows its total and its groups; the
  server adds the total (`totals`) for a sum or count over a complete
  result, one per currency, and screens show the groups alone where a
  total makes no sense. The total shrinks (84 down to 36 units) before a
  group's line gives way (`measureSplitLayout`, on the web and netrics TV,
  with shared test vectors); the readability check counts its lines.
  It reads the last 30 days of the workspace, like the App Store widgets
  (a measure widget's own `period`, on the model's reporting-date
  dimension; the date filter does not change it and says so), titled
  "Downloads, last 30 days". Paired screens that do not draw the split
  (netrics TV up to 0.3.2) get the total alone: a client that draws it
  asks with `GET /v1/device/dashboard?features=measure_split`; for every
  other one the payload makes such a widget an ungrouped value of its
  total, under another version (ETag).
- **Revenue** (paid): the App Store's revenue in the display currency over
  the last 30 days, as before, and beside the ratings Google Play's
  proceeds per currency (a measure table of the proceeds model for the
  Google Play store). Models do not convert currencies, so the two are not
  added up.
- **Ratings** per store listing and the App Store's latest review, as
  before.

A paid product's slide has the ratings (listing, country and star, without
the count) five columns wide over Google Play's proceeds, the total with
its split over the latest review in the middle, and the App Store's
revenue and the website's visitors on the right; a free product's has the
total over the latest review and its visitors over ratings eight columns
wide. Both stores' listings fit at every theme font scale, and every
metric tile keeps its freshness line: metric widgets give the freshness
line room before the trend, the period line or the sparkline. A total in several
currencies wraps between its amounts instead of letting group lines go.
The Google Play proceeds' freshness names Google Play only: a widget's own
fixed store or app counts as its scope. A single-store app keeps version 5's slide; a free product has
no revenue widgets. The freshness line of a tile that combines both stores lists
each store's day and next time (ADR 0025 sections 7 and 8). Version 5
installs get version 6 through the reviewed template update; only the
linked products' slides change.

### The overview's name and its websites (template version 7)

[#779](https://github.com/netrics-so/netrics/issues/779): the overview slide
carried the template's name, which is also the dashboard's default name.
The header leaves out a slide name equal to the dashboard's (#622), but a
dashboard with another name (a renamed one, or an updated copy, "App
portfolio (updated)") read "… App portfolio" beside it. From version 7 the
overview slide is named "Overview" / "Übersicht" where app slides follow
it; an only slide keeps the template's name.

[#787](https://github.com/netrics-so/netrics/issues/787): the overview's
"Website visitors, last 30 days" table ranked every project of the Vercel
connection, whether an app links it or not. From version 7 it lists the
projects the install's apps link in that connection, as the app slides show
them: a table widget's `groupKeys` limits its rows to those values of the
grouped dimension (the breakdown query's `groups`; "Others" then adds up
the rest of these, not of the connection). Its value column reads "30-day
total" / "Summe 30 Tage" (a table's `valueLabel`) instead of the metric's
name, "Daily visitors", beside a sum over thirty days. Both options are
set by the template; the Studio keeps them while a table is edited and
drops `groupKeys` when its grouping changes, and both when its metric
does.

A website linked or unlinked later changes the list through the usual
template update of changed apps. The overview's layout is version 6's: up
to six tiles in two rows on one page at 16:9 (and 21:9); 4:3 and the
portrait formats page it. Version 6 installs get version 7 through the
reviewed template update (the overview slide and its visitors tables;
no data record changes), and the website links, which are the products'
(`data_template_products`), stay as they are.

## Developer Portfolio template

[#876](https://github.com/netrics-so/netrics/issues/876) (milestone 13.1): a
second template installed and updated like the App Portfolio
(`.../dashboard-templates/developer`, template id `developer_portfolio`,
version 1). It reads any subset of Railway, Vercel, Hetzner Cloud, HTTP
checks, PostHog, Search Console, App Store Connect and Google Play
connections; a source left out leaves its preparations, model and widgets
out, and an install with only Railway, or only App Store, is a complete
dashboard.

**Projects.** Every resource of a source belongs to a workspace project
through the install's links table (a manual dataset, `app_key` =
`<connectionId>:<resourceId>` → `product_id` = the project id), named by
its projects table (`product_id` → `product_name`): the App Portfolio's
table columns, so its store preparations read the same tables. The install
seeds the projects table with the workspace's projects (not archived) and
the links table with every resource of a connection that is in a project
(the connection's project), then the request's explicit links. A resource
without a link is its own entry, as an app without a product is. The
tables are the customer's: a link added, changed or removed, or a project
renamed, is offered as a template update (as changed apps are), whose plan
shows the slide changes. A one-flow "add a product" comes with #879.

**Families.** Four families of ordinary preparations, each a preparation per
source (its rows in common columns, joined to the links and projects
tables), one append with two sources or more, and a model:

| Family     | Sources (dataset)                                                                                                             | Measures                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `state`    | Railway `service_states`, Vercel `production_deployments`, Hetzner `servers`, HTTP `checks`                                   | `items` (count); dimensions item, item with project, state, since, rolled back |
| `deploys`  | Railway `deployments`, Vercel `deployments` (target `production`)                                                             | `deploys`, `failed_deploys`, `last_deploy`, `last_status`                      |
| `costs`    | Railway `project_usage` (`cost_usd`), Vercel `billing_charges` (`effective_cost`), Hetzner `cost_items` (`monthly_net`)       | `cost`, per currency                                                           |
| `audience` | Vercel `vercel.visitors`, Search Console `google-search-console.clicks`, PostHog `posthog.dau` / `posthog.mau` (observations) | `visitors`, `clicks`, `dau`, `mau`                                             |

App Store Connect and Google Play reuse the App Portfolio's records
(version 7, frozen as `storeTemplateV7`): their downloads, proceeds and
ratings models, whose `app` dimension is the linked project.

Owner decisions (2026-11-24): cost is the calendar month, effective and
net of VAT (Railway as computed, not the billing period's estimate;
Vercel's effective cost; Hetzner's net monthly price as of the last sync);
models never convert currencies, so `cost` is read per currency and a
table's total is one per currency. Days are UTC for every source, PostHog
included. A Vercel project whose production points at an older build than
the newest ready one is "up · rolled back" (the state widget's flag).
`dau` and `mau` are each project's newest day, summed over projects, never
over days.

**Dashboard.** The overview: the state list over every item named with its
project (problems first, with the count of what is not up), deploys today
per provider, spend this month per provider and currency, active users per
project and, with a store, downloads per project. Then one slide per
project with a linked resource, scoped to it (`project`), in name order:
downloads, revenue and ratings (stores), usage (visitors, clicks, daily
users over 30 days), latest deploys, spend this month, and the state list,
as far as its links fill them. The dashboard's filters (project, provider,
day) map to every model; widgets with a period of their own exclude the
day filter, the state lists exclude it too. Projects past the Studio's
limits (12 slides, 48 data widgets) show in the overview only and are
named by the install (`omittedProjects`).

**Install and update.** One serializable transaction under the install lock
(#604, #660) with one batch data service (#668), as the App Portfolio's
(`developer-template-install.test.ts` keeps it under 20 statements per
record and reads each table once). Updates use the App Portfolio's engine
(`store-template-updates.ts` with a template family): the same plan, apply,
copy, swap and swap back, under the template's own routes and web pages.

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
