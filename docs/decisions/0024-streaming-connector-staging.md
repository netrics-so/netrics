# 0024 — Incremental connector dataset staging with compressed pages

Status: accepted implementation decision (2026-11-07;
[#525](https://github.com/netrics-so/netrics/issues/525), part of
[#519](https://github.com/netrics-so/netrics/issues/519), milestone 11).
Revises [ADR 0023](./0023-connector-dataset-staging.md).

## Context

ADR 0023 lets a connector stage parsed report pages once and resume from them.
`datasetStaging.put` takes the complete page set in one call, so a connector
must hold every parsed page of a report task in memory before anything is
stored. The scale acceptance in
[#501](https://github.com/netrics-so/netrics/issues/501) measured what that
costs for Google Play: peak heap about 22 times the inflated CSV, and staged
JSONB about 5.5 times the CSV, so an all-apps report above about 23 MiB of CSV
exceeds the 128 MiB stage limit although the report budget is 64 MiB. Two
thirds of a staged earnings row is the repeated keys and values of
`provider_fields`; gzip reduces a page to about 0.4 times its CSV, while a
columnar JSON form without compression still takes about 2.2 times.

The incremental write must not add contention to the workspace ingestion lock
(440), which sync pages, policy and retention changes already share (#518).

## Decision

**SDK 0.2.11** adds the optional `datasetStaging.begin({ key, datasetKey,
schemaVersion })`. It returns a writer with `append(pages)`, `commit({
metadata })` and `abort()`. The metadata comes at commit because a page index
is only known once the report has been read. `put` stays and is written
through the same steps, with the same results: the stage is readable only once
every page is stored, an identical stage under a live key is returned as is,
and different content under a live key is a conflict. `begin` is optional, so
hosts and connectors written for 0.2.10 keep working; a connector checks for it.

**Drafts.** `begin` inserts a stage header with `committed_at` null. Under the
ingestion lock it reads the policy and the connection's retention and fixes
the collection time and source deadline, as `put` did. A draft's `expires_at`
is at most 15 minutes after `begin`. Readers (`get`, `getPage`, dataset
provenance) and the committed-key uniqueness (a partial unique index) see
committed stages only. A draft belongs to one connector call: a failed append
or commit, `abort`, and the call's abort signal (timeout or end of call) delete
it. An abandoned draft stops counting toward the budget when it expires, and
`prune_dataset_history_batch` (0065, unchanged, never waits for a lock) removes
it like any expired stage.

**Appends** validate each page against the dataset given to `begin`, compress
its JSON text with gzip, and in one transaction add the compressed bytes plus
512 bytes per page to the draft's `byte_size`, check the 128 MiB stage limit
and the workspace's `maxConnectorStagingBytes` over all live stages (committed
and open drafts), and store the pages. A refusal leaves nothing of the draft.
Appends take only a new **workspace staging lock (advisory key 441)**, never
the ingestion lock, so a large first read neither waits for nor holds up sync
pages and retention changes.

**Commit** takes the ingestion lock and then the staging lock (always in this
order; nothing takes 440 while holding 441). It computes the content digest
from the stored page digests exactly as before, so integrity checks are
unchanged. It sets the final deadline to one day after collection at most, and
never past the source deadline that policy and connection-retention changes
keep current on the draft (`admin_set_data_policy` and
`apply_connection_retention` update every stage row, drafts included) or past
the current policy. Its budget check counts committed stages and the stage
itself, not other open drafts, so one of several racing writers can always
finish; the others are refused on their next append or commit.

**Storage.** New pages are stored as gzip-compressed JSON text in
`payload_gzip`; pages written before migration 0067 keep their JSONB payload
and stay readable until they expire. Digests are computed on the page content,
not on its encoding. The application role may update a stage only while it is
a draft, and never to a deadline beyond one day after collection or beyond its
source deadline (a restrictive row policy for `netrics_app`); committed stages
stay immutable to the application, and pages have no UPDATE grant. Forced
tenant RLS on both tables and explicit `workspace_id`, connection and connector
predicates in every statement remain.

**What `maxConnectorStagingBytes` means changes.** It, and the 128 MiB stage
limit, now count stored compressed bytes plus overhead, no longer serialized
JSONB. The default stays 128 MiB, so the same setting admits several times more
parsed rows than before. Operators who sized it to their storage keep that
meaning; operators who used it to bound report size get larger reports staged.

## Google Play use (#519)

The Google Play connector stages a report task through `begin` while it reads
the report. Rows go to their app partition in parse order (object name, archive
member, line); the global sort is gone, and row identity stays the `row_id`
hash with a duplicate ordinal (counted per 96-bit hash prefix). Each app holds
at most one pending page, kept as JSON text. When all pending pages together
exceed 8 MiB, the largest one is written as a shorter page, so memory does not
grow with the number of apps. Page boundaries depend only on the report, and
only an app's final page (possibly empty) is complete. The page index lives in
the stage metadata as one compact string per app, because stage metadata is
bounded JSON. A turn emits consecutive staged pages of its app up to about one
full page of rows (at most 16 pages). Stage keys start with `play-v2`; stages
written by the previous connector are not reused.

Without a stage (a host without `begin`, a refused `begin`, append or commit,
or a task that started without one), the connector no longer holds the whole
task. Each turn reads the report again and keeps only its app's rows from the
checkpoint, up to eight pages, while it counts and digests all of that app's
rows. A report task then costs about one read per app plus one per eight pages,
instead of one read per page, and a turn holds at most eight pages. A task that
starts without a stage keeps that mode through its continuation, as before.

## Consequences and boundaries

A connector can stage a report while reading it and keep only a bounded number
of pages in memory; the Google Play connector does so since #519 (above). Reports within the 64 MiB inflation budget fit a stage at measured
compression ratios. Compression costs CPU on append and on every page read
(each page is at most 1 MiB of JSON). A draft never spans connector calls, so a
first read that takes longer than one call still starts over; the draft TTL
only bounds how long its bytes count after an abnormal end. Open drafts count
toward the workspace budget, so concurrent first reads in one workspace can
refuse each other's appends; the refused one rebuilds on a later turn.
