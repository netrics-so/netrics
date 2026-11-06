# 0023 — Durable parsed dataset staging for connector continuations

Status: accepted implementation decision (2026-11-05; #472, milestone 11).
Extends ADR 0022 and the optional typed dataset capability.
Quota separation revised on 2026-11-06 in [#476](https://github.com/netrics-so/netrics/issues/476).

## Context

The Google Play connector pins object generations and resumes dataset pages,
but downloading, inflating and parsing an entire report for every app/page turn
repeats work. An in-process cache would disappear on worker restart and could
mix private data across connections. Connectors must not receive database,
filesystem or unrestricted object-storage handles.

## Decision

SDK 0.2.10 adds optional `runtime.datasetStaging` with `get`, `getPage` and `put`.
The host binds it to the authorized workspace, connection and connector. Keys
cannot select another scope. Existing connectors remain compatible, and a host
without this optional capability uses the connector's buffered fallback.

A stage contains bounded metadata and immutable, schema-validated dataset-page
chunks. The host verifies every page against a dataset declared by the connector
manifest. It stores the header and all chunks in one transaction before making
the stage readable. An identical repeated write is idempotent; different content
under a live key is an error. Header and page digests detect corrupted content;
metadata digest ordering is independent of the database collation.

PostgreSQL stores the initial implementation under forced tenant RLS and
connection/workspace foreign keys. Pages have no UPDATE grant; headers allow
only byte-accounting updates. `maxConnectorStagingBytes` governs the aggregate
accounted bytes of live stages (serialized JSONB plus accounting overhead) in
one workspace, under the same advisory lock used by raw ingestion. It defaults
to 128 MiB; `0` refuses new stages and
`null` removes the aggregate admission ceiling. Lowering this budget, including
to `0`, does not evict or prevent reuse of already admitted live stages. Their
original source-retention and cache deadlines still apply. Expired stages do
not consume admission capacity while awaiting pruning.

This changes the initial shared-quota decision: `maxWorkspaceBytes` now counts
retained raw pages and records only. Optional staging can no longer make an
otherwise admissible raw import exceed that cap by keeping a second parsed
copy. Staging and prepared caches have separate budgets; total managed storage
can therefore exceed `maxWorkspaceBytes`. The host checks actual staged bytes
before publishing a stage, and the Google connector uses buffered ingestion if
admission is refused. Raw ingestion still enforces its own quota.

A single stage remains limited to 128 MiB of serialized JSONB, its metadata to
1 MiB, and each page/record to the
existing SDK wire safeguards. These are bounds for disposable execution storage,
not customer history quotas. Whole initial report parsing remains buffered.

The host expires staging after at most 24 hours, shortened by source and
workspace retention. Financial reports retain personal provider fields, so their
source retention applies to staging too. Reads and repeated writes never renew
a stage's deadline. Shortening workspace retention irreversibly reduces existing
staging deadlines. Scheduler maintenance deletes expired chunks in bounded
batches, then removes empty headers; deleting a connection cascades immediately.

A returned dataset page can carry `stagingId` and `stagingPageKey`. Before
committing it, the host verifies the exact staged dataset/schema, rows, replacement
window and completion state within the bound scope. It reuses the stage's original
source collection time and source retention deadline. The temporary 24-hour cache
TTL does not shorten an otherwise longer source retention period, and resuming
from cached data cannot extend personal-data retention. A staged reference is not
needed to replay an already retained raw refresh.

Staging reads, writes and source admission use the host's current clock, including
after database lock waits. The sync window and run audit retain their original
start time; that timestamp is not a retention clock. Losing disposable staging
between a read and its committed checkpoint is retryable: the checkpoint stays
unchanged, and a fresh attempt rebuilds the pending partition. Corrupted staged
content or an altered existing reference remains a permanent contract failure.

The staging factory receives the connector call's abort signal. The host checks
it around storage transactions and between chunk writes. Timeout, abort or an
ended connector call revokes further staging access; an interrupted transaction
rolls back without publishing a partial stage.

## Google Play use

A stage key includes the parser version, connection configuration/selection
signature, task, app roster and complete report object identities/generations.
The connector parses the relevant report set once, partitions it into per-app
transport pages, and stores the page index without provider records in the
checkpoint. Resumed turns read only the needed parsed page. A new connector or
worker process can use the same durable stage.
When admission is refused, that report task stays buffered through its remaining
app/page continuations, even if cache capacity later becomes available. Changing
storage mode halfway through would abandon its partially committed refresh.

Each turn still lists current report metadata. Before reusing staged private
rows, it authorizes each exact object generation with a metadata-only GET.
Google's [Objects: get contract](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get)
requires `storage.objects.get` for that call and supports generation selection;
only `alt=media` returns report bytes. Permission loss and missing reports update
availability rather than publishing incomplete replacements. Corrections change
the stage key and restart the pending app partition. Expired or missing staging
is rebuilt by a real provider read and restarts that pending partition too.

## Consequences and boundaries

This removes repeated report transfer/decompression/parsing across page and app
continuations while a stage remains live. It adds temporary PostgreSQL storage
and metadata authorization requests. Independent cache admission avoids evicting
an in-progress stage, which would restart the pending partition and could leave
additional incomplete raw refreshes. Operators must account for raw retention,
connector staging and prepared caches when sizing storage. This policy update
does not change the SDK or require a database schema migration.

It does not implement streaming downloads, ZIP64, incremental CSV parsing,
SQL analytical execution, delta source generations
or unlimited provider-file size. The normal 10 MiB buffered HTTP limit and 64 MiB
ZIP inflation safeguard remain. Stage expiry, changed configuration/app roster,
corrections and changed parser versions can require a new complete provider read.
