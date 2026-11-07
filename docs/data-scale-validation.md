# Data workload validation

This records the bounded validation and implementation audit for
[#466](https://github.com/netrics-so/netrics/issues/466) and Google report staging
in [#472](https://github.com/netrics-so/netrics/issues/472), plus the wider scale
acceptance for retained history and concurrent ingestion in
[#501](https://github.com/netrics-so/netrics/issues/501), part of milestone 11.
It establishes correctness at the measured sizes and exposes the next scaling
work. It does not establish a production capacity or a maximum supported account
size.

## Reproduce

From the repository root, with the normal local test PostgreSQL server running:

```sh
NETRICS_DATA_SCALE_CHECK=1 \
NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5433/postgres \
pnpm exec vitest run apps/server/src/data/scale-validation.test.ts \
  --reporter=verbose --silent=false
```

The check uses the existing migration/test-database harness and the application
role. The harness drops its disposable database after the run. It installs no
packages, calls no provider, and leaves existing containers and volumes intact.
Without `NETRICS_DATA_SCALE_CHECK=1` these two workload tests are skipped by the
ordinary test suite. Assertions concern values, identities, publication and
budgets; elapsed times have no pass threshold. Each explicit run prints one
`NETRICS_DATA_SCALE_RESULT` JSON object, including its environment and measurements.

The fixture contains 5,001 exact-money records for 1,300 synthetic app identities.
It publishes the source in six pages, loads every resource name, joins facts to
those names, derives a boolean, groups per app, publishes a model, and queries
numeric and boolean measures. Result pagination returns all 1,300 identities in
pages of 1,000 and 300 with matching provenance while the sources are unchanged.
A one-record correction must change the exact total and source generation without
double-counting. Lowering the workspace row policy to 1,000 rejects the same
source; setting that policy to `null` permits it again.

A separate in-memory query contains 100,001 rows: the default 100,000-row budget
rejects it, explicit uncapped row/operation/output budgets permit it, and a
10-operation budget still rejects execution. This part exercises the query engine;
it does not ingest 100,001 records into PostgreSQL or exercise a real Google file.

## Measured local run (historical, #466)

Recorded on 2026-11-05 after the workload assertions passed. Environment: Apple M3
Max, arm64, 48 GiB RAM, Darwin 27.2.0, Node v25.9.0, PostgreSQL 17.10 in the existing
local Docker setup. Other development processes were running. The repository
then required Node >=24 and now requires Node >=26 (see the #501 section for
Node 26 numbers); these measurements are kept as history. They are not from the
production runtime or a hosted/self-hosted acceptance environment. Free workspace disk before the run was
175 GiB.

| Work                                                              | Elapsed |
| ----------------------------------------------------------------- | ------: |
| Ingest 5,001 records in six transport pages                       |  303 ms |
| Upsert and load 1,300 resource names                              |   90 ms |
| Publish joined/calculated/grouped preparation and model           |  266 ms |
| First model query, with prepared cache available from publication |   51 ms |
| Repeat model query                                                |   45 ms |
| Query first 1,000 app groups                                      |   49 ms |
| Query remaining 300 app groups                                    |   46 ms |
| Publish one corrected row as a new 5,001-record generation        |  196 ms |
| Query after correction, rebuilding dependent prepared output      |  100 ms |
| Uncapped in-memory sum across 100,001 exact decimals              |  146 ms |

The 100,001-row query used 500,007 counted operations and returned `10000.1`.
The persisted workflow returned `500.1 EUR`, then `500.3 EUR` after changing a
single source amount from `0.10` to `0.30`. Every app was mapped and retained its
stable identity independently of its label. Both workload tests passed; the run
including migrations/fixtures took about 3 seconds.

Observed process RSS samples ranged from 210 MiB before initial ingestion to
346 MiB after the final in-memory query. Heap samples ranged from 52 to 132 MiB.
These are before/after samples from a Vitest worker, not isolated allocation costs
or peak-memory measurements. Garbage collection and earlier work affect them.
No throughput or memory extrapolation to larger files, more concurrent customers
or longer retained history follows from this run.

After the one-row correction, PostgreSQL contained two raw generations and
10,002 retained records, plus seven staged input pages. The `data_records` relation
including indexes/TOAST occupied 2,899,968 bytes; `data_pages` occupied 147,456 bytes;
`data_prepared_generations` occupied 131,072 bytes. The whole disposable database
occupied 15,008,271 bytes, including the migrated schema and unrelated catalog
metadata. This demonstrates full-copy amplification: a tiny correction creates
another full source generation.

## Google report staging check

`apps/server/src/sync/staging.test.ts` exercises the actual host staging adapter
under the application database role. Run it with the normal test PostgreSQL
server using:

```sh
NETRICS_TEST_ADMIN_URL=postgres://netrics:netrics@localhost:5433/postgres \
pnpm exec vitest run apps/server/src/sync/staging.test.ts --reporter=verbose --silent=false
```

The larger fixture contains 20,001 install rows (1,698,034 provider CSV bytes)
plus eight financial rows for several apps. A fresh connector instance on every
turn reads 24 parsed pages; the four report objects are each downloaded once.
The local check recorded about two seconds and 10,197,736 staged JSONB bytes.
These numbers describe a synthetic bounded fixture, not production capacity or
peak memory. The test prints `NETRICS_GOOGLE_STAGE_RESULT` on each run.

Further cases cover changed generations, missing/expired stages, object-level
permission loss, scope isolation, altered payloads, digest corruption, database
collation, quota rollback, abort/ended-call revocation, irreversible retention
shortening and batched cleanup. The initial read still buffers and parses the
whole provider report; metadata discovery and object authorization still run on
continuations. A stage expires within 24 hours, so a later continuation may need
a fresh provider read and restart its pending partition. See [ADR 0023](./decisions/0023-connector-dataset-staging.md).

## Wider scale acceptance (#501)

[#501](https://github.com/netrics-so/netrics/issues/501) follows up the "wider
scale acceptance" that #466, #472 and #488 left open. It only measures and adds
no features. Every number below comes from synthetic data in disposable
databases. None of them is a production size or a capacity promise.

### Reproduce the #501 measurements

Three opt-in Vitest files each print one JSON result line. They are skipped in
the ordinary `pnpm test` run. Their assertions check correctness, not time.
`scripts/scale/run.ts` runs a suite several times, each run in a fresh process
on its own disposable database. It appends every result to a JSONL file and
prints each value as median [min–max]:

```sh
node scripts/scale/run.ts history     --runs 3 --out history.jsonl
node scripts/scale/run.ts concurrency --runs 3 --out concurrency.jsonl
node scripts/scale/run.ts play        --runs 3 --out play.jsonl
```

| Suite       | File                                                      | Default sizes (environment variables)                                                                                                                                                |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| history     | `apps/server/src/data/retained-history-scale.test.ts`     | `NETRICS_SCALE_CONNECTIONS` 20 × `NETRICS_SCALE_DATASETS_PER_CONNECTION` 5 × `NETRICS_SCALE_ROWS_PER_DATASET` 20,000; `NETRICS_SCALE_QUERY_ROWS` 10,000, 50,000, 100,000; 10 samples |
| concurrency | `apps/server/src/data/concurrent-ingestion-scale.test.ts` | `NETRICS_SCALE_WORKERS` 8 × 3 refreshes × 10 pages of 1,000 records; 10 × 20,000 retained records; pinned sources of 10,000 and 50,000 rows; bursts of 1, 10, 25, 50                 |
| play        | `apps/server/src/sync/play-memory-scale.test.ts`          | `NETRICS_SCALE_PLAY_SIZES` 8, 16, 32, 63 MiB of inflated earnings CSV; all apps (102) and one selected app                                                                           |

The recorded runs are from 2026-11-07, on an Apple M3 Max (16 cores) with
48 GiB, macOS (Darwin 27.2.0), Node v26.13.0 and PostgreSQL 17.10. PostgreSQL
was the local Docker test server with default settings: `shared_buffers` 128 MB,
`work_mem` 4 MB, `deadlock_timeout` 1 s and `max_connections` 300. One Node
process serves as API, worker and scheduler. The application pool has 4
connections in the history suite and 24 in the concurrency suite. Nothing else
heavy ran at the time. Every suite ran three times, and the tables show the
median and [min–max] of the three runs.

### Synthetic data

The rows look like report lines with ten typed fields: an id, a date spread over
365 days, one of 200 apps, a country, a product, a channel, integer units, a EUR
decimal amount and an order reference. That is about 230 bytes of JSON per
record. Sources are `upsert` datasets, ingested through `ingestDatasetPage` in
pages of 1,000 records, with one workspace transaction per page as in a sync
turn. Models aggregate the raw source directly. Queries go through the data
service (`service.query`) and through the dashboard measure path
(`queryDashboardMeasure`) that screens and Studio use.

### Retained history

The history suite first loads three query targets of 10,000, 50,000 and 100,000
rows. Then it adds 20 connections × 5 datasets × 20,000 rows, each followed by a
one-record correction. One workspace then holds 104 datasets and 4,161,000
retained records, and a neighbour workspace holds 1,000 records. Query latency
is measured three times: before the background history is added, with it, and
after it has been drained.

**Query latency in ms, p50 / p95.** Each value comes from 10 samples taken after
one first query, in each run:

| Source rows | Query                    | Targets only (160 k records)       | With 4.16 M records                 | After drain and VACUUM              |
| ----------: | ------------------------ | ---------------------------------- | ----------------------------------- | ----------------------------------- |
|      10,000 | Model total              | 110 [108–111] / 114 [114–114]      | 121 [120–121] / 128 [125–129]       | 128 [126–131] / 148 [135–151]       |
|      10,000 | Dashboard line, by day   | 112 [111–113] / 121 [115–126]      | 122 [121–125] / 132 [125–133]       | 123 [119–127] / 141 [131–149]       |
|      50,000 | Model total              | 492 [483–494] / 508 [507–508]      | 538 [530–542] / 561 [544–577]       | 560 [546–562] / 587 [580–637]       |
|      50,000 | Dashboard line, by day   | 479 [478–498] / 498 [493–530]      | 514 [509–530] / 555 [545–556]       | 539 [539–545] / 569 [554–591]       |
|     100,000 | Model total              | 986 [967–1014] / 1008 [1004–1034]  | 1038 [1029–1051] / 1174 [1046–1180] | 1080 [1076–1092] / 1124 [1096–1194] |
|     100,000 | Model by day             | 1003 [989–1009] / 1055 [1042–1180] | 1034 [1032–1040] / 1059 [1050–1073] | 1082 [1073–1085] / 1111 [1098–1152] |
|     100,000 | Dashboard value          | 984 [970–1008] / 1082 [998–1111]   | 977 [976–993] / 1006 [992–1036]     | 1032 [1030–1035] / 1090 [1061–1115] |
|     100,000 | Dashboard line, by day   | 991 [982–1002] / 1010 [1009–1062]  | 991 [982–1005] / 1024 [1008–1031]   | 1036 [1031–1046] / 1069 [1066–1077] |
|     100,000 | Model by app and country | 973 [971–998] / 991 [979–1104]     | 981 [980–1001] / 1004 [996–1016]    | 1031 [1024–1033] / 1051 [1041–1172] |

The first query was usually within 10% of the median. The largest gap was 178 ms against a median of 128 ms (10,000 rows, after the drain). Process RSS stayed
between 270 and 800 MiB while querying.

**Ingestion and storage:**

| Measure                                                     | Value                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| Background ingestion of 4,000,000 generated records         | 206 s [200–212], 19,454 records/s [18,861–20,009]         |
| Initial refresh of 20,000 rows (20 pages)                   | p50 1,276 ms [1,249–1,312]                                |
| One-record correction of a 20,000-row dataset (full copy)   | p50 761 ms [751–777]                                      |
| Ingestion of the 100,000-row target (100 pages)             | 7.6–7.7 s                                                 |
| `data_records` with 4,161,000 records                       | 1.81 GB (heap 1.36 GB, indexes 0.44 GB), 435 bytes/record |
| `data_pages` with 2,161,100 staged records (JSONB in TOAST) | 66.6 MB, about 31 bytes per record                        |
| Whole database with 4.16 M records                          | 1.89 GB                                                   |

Raw pages compress well. Most of the retained cost is the record table: about
twice the JSON size of a row once the primary key and the expiry index are
counted. Drained space is reused but not returned. After the drains below, with
1,000 live records left, `data_records` still took 4.76 GB. A plain `VACUUM`
took 7.4 s [6.2–8.5] and does not shrink the files.

**Prune drains under `datasetPruneBudgetMs`.** This follows the scheduler's
loop: call `prune_dataset_history(now, 10000)` until a batch comes back short or
the 10-second budget is spent, then continue on the next tick.

| Backlog                                                                        | Ticks | Total              | Rows/s                    | Call p50 / max (ms)           |
| ------------------------------------------------------------------------------ | ----: | ------------------ | ------------------------- | ----------------------------- |
| 100 superseded generations (2,002,200 records and staged pages), 16 minutes on |     2 | 13.4 s [13.3–14.8] | 149,265 [135,433–150,607] | 63 [59–69] / 442 [398–568]    |
| Whole history after a one-day ceiling (2,160,463 rows), two days on            |     5 | 46.6 s [45.0–50.6] | 46,399 [42,659–48,024]    | 432 [427–466] / 847 [726–951] |

No tick ran more than 0.5 s over its budget (one call). Deleting expired current
records costs about three times as much per row as releasing superseded
generations. It stays bounded, and the backlog flag drains the rest on the
following ticks.

**Policy changes** (`admin_set_data_policy` on the workspace with 4,161,000
records):

- Setting `maxRetentionDays` to 3650, which shortens nothing, took 37.6 s
  [34.2–39.1].
- A later call that changed only `queryRows`, with the ceiling still set, took
  43.4 s [36.9–46.1]. The same change without a ceiling took 4.6 ms.
- Setting a ceiling on the 1,000-record neighbour took 3.4 s [2.7–5.1]. Its
  record update is a sequential scan over every workspace's records.
- The two calls that changed nothing grew the `data_records` heap from 1.36 GB
  to 4.20 GB.
- Shortening to one day with 2.16 M records took 20.0 s [18.2–20.9].

All of these hold the workspace ingestion lock while they run
([#518](https://github.com/netrics-so/netrics/issues/518)).

### Concurrent syncs and policy changes

Eight sync workers each ingest three refreshes of ten 1,000-record pages into
their own dataset. To time the lock wait, each page transaction takes the
workspace ingestion lock (440) first; `ingestDatasetPage` then takes it again
re-entrantly.

| Scenario                               | Records/s              | Page p50 / p95 (ms)                       | Completing page p50 (ms) | Lock wait p95 / max (ms)                  | Page time spent waiting | Deadlocks |
| -------------------------------------- | ---------------------- | ----------------------------------------- | ------------------------ | ----------------------------------------- | ----------------------: | --------- |
| 8 workspaces, one sync each            | 33,331 [33,195–33,639] | 80 [79–80] / 160 [156–164]                | 1,478 [1,378–1,520]      | 11 [11–12] / 35 [34–86]                   |                    1.7% | 0         |
| 1 workspace, 8 connections             | 16,034 [15,953–16,175] | 182 [178–187] / 1,016 [977–1,058]         | 1,820 [1,776–1,842]      | 2,136 [2,118–2,156] / 3,003 [2,977–3,030] |                     85% | 0         |
| 1 workspace, 8 connections, with churn | 2,316 [2,219–2,450]    | 3,218 [3,160–3,291] / 5,381 [5,329–6,253] | 6,226 [6,159–6,370]      | 7,387 [6,888–7,764] / 9,798 [8,239–9,836] |                     97% | 3 [2–5]   |

In the churn scenario the workspace holds 450,000 records. Next to the eight
syncs, four loops run:

- `admin_set_data_policy`, switching `maxRetentionDays` between 3650 and 3651;
- `setConnectionRetention` on one connection;
- the scheduler's prune;
- dashboard-style model queries (10,000 rows, grouped by day) in the service's
  serializable transactions.

| Concurrent operation      | Calls per run | p50 (ms)            | p95 (ms)            | Failures over 3 runs                  |
| ------------------------- | ------------: | ------------------- | ------------------- | ------------------------------------- |
| `admin_set_data_policy`   |         24–25 | 3,542 [3,410–3,560] | 6,402 [6,091–9,343] | 5 of 73 calls lost a deadlock (40P01) |
| `setConnectionRetention`  |         24–25 | 3,440 [3,416–3,492] | 8,331 [7,646–9,836] | none                                  |
| `prune_dataset_history`   |       754–881 | 3.4 [3.3–3.4]       | 91 [89–101]         | 5 of 2,410 calls lost a deadlock      |
| Model query (10,000 rows) |       465–500 | 109 [107–111]       | 138 [134–148]       | none; 0 serialization retries         |

Every deadlock in the server log was `prune_dataset_history` against
`admin_set_data_policy` or `apply_connection_retention`, on `data_records`
([#517](https://github.com/netrics-so/netrics/issues/517)). No sync page
failed, deadlocked or retried. Ingestion did not slow model queries. Each page
transaction sets the ingestion statement timeout (`queryTimeoutMs`, 15 s) before
the lock probe, as `ingestDatasetPage` does. The longest lock wait, 9.8 s under
churn, stayed below it; a longer wait fails the page and the sync retries.

**After #517.** Prune locks every row with `SKIP LOCKED` (records of a
generation whose first record is held are skipped as a whole, probed with
`NOWAIT`), so it never waits for a policy or retention change and leaves held
rows for a later call (migration 0065). The churn scenario, rerun on 2026-11-07
on the same machine and settings (the concurrency suite, three fresh
processes; the prune loop calls `prune_dataset_history_batch` through the
`prune_dataset_history` entry point):

| Concurrent operation      | Calls per run | p50 (ms)            | p95 (ms)            | Failures over 3 runs          |
| ------------------------- | ------------: | ------------------- | ------------------- | ----------------------------- |
| `admin_set_data_policy`   |         25–26 | 3,612 [3,571–4,594] | 6,802 [6,781–7,582] | none                          |
| `setConnectionRetention`  |         25–26 | 3,661 [3,462–4,525] | 7,980 [7,763–8,598] | none                          |
| `prune_dataset_history`   |       354–557 | 7.5 [4.2–211]       | 445 [255–476]       | none                          |
| Model query (10,000 rows) |       397–548 | 112 [110–142]       | 178 [150–191]       | none; 0 serialization retries |

Deadlocks (`pg_stat_database.deadlocks`): 0 in every run, against 2–5 before.
No call of any loop failed and no transaction rolled back. The syncs ran as
before: 2,221 records/s [2,019–2,427], page p50 3,368 ms [3,266–3,905], lock
wait p95 6,590 ms [6,380–7,690]. Prune calls take
longer than the 3.4 ms p50 before. The suite does not record rows per call, so
the cause is not measured; calls that release generations and delete a batch
of their records while the policy loop runs, instead of waiting or losing a
deadlock, would explain it. Before the generation probe, a call passed over every
held record again; with 400,000 held records that took about 250 ms per call
in a separate check, and about 3 ms with the probe.

**Pinned first pages.** Since #505, pinned first pages of one model are
admitted one at a time, through an in-process queue with a wait bounded by
`queryTimeoutMs` (15 s by default). To measure only the queue and the wait, the
session caps were removed (`querySnapshotCount` and
`queryPageSessionsPerCaller` set to `null`). Each burst sends that many
concurrent first pages (limit 100, grouped by day):

| Source rows | Burst | One model: admitted / refused, wall time | Separate models, one workspace: admitted / `version_conflict` | Separate workspaces: admitted / `version_conflict` | Unpinned, one model: wall time |
| ----------: | ----: | ---------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- | ------------------------------ |
|      10,000 |     1 | 1 / 0, 102 ms [95–108]                   | 1 / 0                                                         | 1 / 0                                              | 87 ms [86–101]                 |
|      10,000 |    10 | 10 / 0, 918 ms [894–1,019]               | 3 / 7 in every run                                            | 2–3 / 7–8                                          | 744 ms [742–746]               |
|      10,000 |    25 | 25 / 0, 2.6 s [2.3–2.6]                  | 4–6 / 19–21                                                   | 4 / 21                                             | 1.9 s [1.9–2.0]                |
|      10,000 |    50 | 50 / 0, 5.2 s [5.1–5.3]                  | 7–28 / 22–43                                                  | 7 / 43                                             | 3.8 s [3.8–3.9]                |
|      50,000 |    10 | 10 / 0, 4.0 s [3.9–4.4]                  | 9–10 / 0–1                                                    | not run                                            | 3.7 s [3.7–3.8]                |
|      50,000 |    25 | 25 / 0, 10.0 s [10.0–11.1]               | 18–24 / 1–7                                                   | not run                                            | 9.3 s [9.2–9.4]                |
|      50,000 |    50 | 34–39 / 11–16, 19.7 s [19.4–21.0]        | 23–30 / 5–8, and 15–19 refused                                | not run                                            | 18.4 s [18.4–18.8]             |

For one model this is what #505 intended. There are no errors. Once the queue
is longer than the wait allows, a request gets the documented refusal with its
first page. With separate models, the refusals at 50,000 rows came from waiting
for one of the 24 pool connections. First pages of different models, and of
different workspaces, failed with `version_conflict` (409)
([#516](https://github.com/netrics-so/netrics/issues/516)).

**After #516.** Admission now counts and inserts the session in a short
read-committed step after the page's serializable transaction, under the same
per-model lock, so admissions of different models no longer abort each other.
The same bursts, rerun on 2026-11-07 on the same machine and settings (the
pinned test of the concurrency suite only, three fresh processes):

| Source rows | Burst | One model: admitted / refused, wall time | Separate models, one workspace: admitted / refused, wall time | Separate workspaces: admitted / refused, wall time | Unpinned, one model: wall time |
| ----------: | ----: | ---------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- | ------------------------------ |
|      10,000 |     1 | 1 / 0, 108 ms [105–133]                  | 1 / 0, 97 ms [93–113]                                         | 1 / 0, 108 ms [101–120]                            | 98 ms [92–110]                 |
|      10,000 |    10 | 10 / 0, 1.1 s [1.1–1.1]                  | 10 / 0, 784 ms [782–800]                                      | 10 / 0, 791 ms [775–798]                           | 772 ms [752–776]               |
|      10,000 |    25 | 25 / 0, 2.7 s [2.6–3.0]                  | 25 / 0, 1.9 s [1.9–1.9]                                       | 25 / 0, 1.9 s [1.9–1.9]                            | 1.9 s [1.9–1.9]                |
|      10,000 |    50 | 50 / 0, 5.1 s [4.9–5.5]                  | 50 / 0, 3.8 s [3.8–4.0]                                       | 50 / 0, 3.9 s [3.9–4.0]                            | 3.9 s [3.8–3.9]                |
|      50,000 |    10 | 10 / 0, 4.0 s [4.0–4.6]                  | 10 / 0, 3.7 s [3.7–3.9]                                       | not run                                            | 3.8 s [3.6–3.9]                |
|      50,000 |    25 | 25 / 0, 10.0 s [10.0–11.7]               | 25 / 0, 9.3 s [9.2–9.5]                                       | not run                                            | 9.3 s [9.3–9.6]                |
|      50,000 |    50 | 33–36 / 14–17, 20.8 s [20.6–21.9]        | 48 / 2, 19.3 s [18.6–19.8]                                    | not run                                            | 18.9 s [18.6–19.6]             |

No request failed in any run. First pages of separate models or workspaces
now take about as long as unpinned queries. The two refusals with separate
models at 50,000 rows are waits for one of the 24 pool connections that
exceeded `queryTimeoutMs`, as before.

### Google Play first-read memory

Since #488 a report is parsed row by row. The typed rows of one report task are
still collected, sorted and passed to `datasetStaging.put` as one complete page
set (see [current implementation boundaries](./connectors/google-play.md#current-implementation-boundaries)).
The play suite measures that buffer through the real host staging adapter. The
synthetic earnings archive has the 26 columns of a Play Console earnings
report, in UTF-8, with 100 apps plus the two listed ones. The selected app holds
10% of the lines. Each size and scope runs in its own process. Heap is
`heapUsed + arrayBuffers` above the baseline taken before the sync, sampled
every 5 ms. RSS is the sampled peak.

| Inflated CSV (lines) | Scope    | First read         | Peak heap above baseline | Peak RSS                | Staged JSON         | Each later page turn         |
| -------------------- | -------- | ------------------ | ------------------------ | ----------------------- | ------------------- | ---------------------------- |
| 8 MiB (41,112)       | all apps | 4.7 s [4.5–4.7]    | 173 MiB [163–180]        | 354 MiB [341–370]       | 44.5 MiB, staged    | 41 ms [30–49], no download   |
| 8 MiB (4,112 rows)   | one app  | 0.7 s [0.7–0.8]    | 62 MiB [57–73]           | 233 MiB [229–262]       | 4.5 MiB, staged     | 28 ms, no download           |
| 16 MiB (82,225)      | all apps | 9.1 s [9.0–9.3]    | 261 MiB [250–279]        | 457 MiB [446–477]       | 88.9 MiB, staged    | 44 ms [43–47], no download   |
| 16 MiB (8,223 rows)  | one app  | 1.4 s [1.4–1.4]    | 81 MiB [56–81]           | 249 MiB [241–281]       | 8.9 MiB, staged     | 30 ms, no download           |
| 32 MiB (164,451)     | all apps | 12.5 s [12.5–12.7] | 766 MiB [747–798]        | 1,019 MiB [1,004–1,055] | refused (> 128 MiB) | 8.5 s, whole report re-read  |
| 32 MiB (16,446 rows) | one app  | 2.9 s [2.8–2.9]    | 85 MiB [81–97]           | 279 MiB [277–291]       | 17.9 MiB, staged    | 29 ms, no download           |
| 63 MiB (323,763)     | all apps | 25.3 s [25.2–25.4] | 1,428 MiB [1,422–1,432]  | 1,774 MiB [1,738–1,807] | refused             | 17.5 s, whole report re-read |
| 63 MiB (32,377 rows) | one app  | 5.5 s [5.5–5.5]    | 130 MiB [128–146]        | 321 MiB [320–321]       | 35.1 MiB, staged    | 30 ms, no download           |

Each typed row keeps its normalized fields and all original columns
(`provider_fields`), so it takes about 4.5 KiB of heap. Peak heap is about
22 times the inflated CSV. Staged JSON is about 5.5 times the CSV, so an
all-apps report above about 23 MiB of CSV exceeds the 128 MiB stage limit, which
is the same as the default `maxConnectorStagingBytes`. The report's own
inflation budget is 64 MiB. Once staging is refused, every continuation turn
downloads, inflates and parses the whole report again to emit one page of about
980 rows. A 63 MiB report would take about 330 such turns: about 96 minutes of
CPU and 1.6 GiB of transfer for one report task, each turn holding 1.4 GiB of
heap.

**Decision: the SDK needs streaming staging.** Above about 23 MiB of report
text, the buffer turns a bounded first read into a quadratic re-read and
holds more than a gigabyte per worker. Selected-app syncs and reports below
that size stay bounded and are a confirmed boundary at the measured sizes.
Streaming staging, a staged form that fits the report budget and a fallback
without re-reading are proposed in
[#519](https://github.com/netrics-so/netrics/issues/519) and not built here.

### Confirmed boundaries

At the measured sizes, these are expected behaviour, not defects:

- **Query cost follows the queried generation, not the retained history.** A
  model or dashboard query loads its source generation into the process. That
  costs about 10 µs per row: 110 ms at 10,000 rows and 1.0 s at the default
  `queryRows` of 100,000. Adding 4.16 M records elsewhere in the workspace
  changed latency by 0–10%, and so did draining them again.
- **One server process runs queries one after another.** Fifty concurrent
  unpinned 50,000-row queries took 18.4 s together, the same throughput as in
  sequence. The 15-second `queryTimeoutMs` is a SQL statement timeout, not a
  wall-clock limit, so these queries finished after 18 s. Larger sources or
  concurrent heavy queries need the streaming or SQL execution of "Remaining
  scaling work" item 3.
- **Syncs of one workspace take turns on the ingestion lock (440).** Eight
  concurrent syncs reach 16,000 records/s in one workspace and 33,000 records/s
  in eight workspaces. A page waits up to 3 s for the lock. That is what the
  lock is for: retention and policy reads stay consistent. No page deadlocked
  or failed.
- **A correction copies the whole generation.** Correcting one record of a
  20,000-row source takes 0.76 s, 60% of the initial refresh ("Remaining
  scaling work" item 2).
- **Prune drains keep up.** Within the scheduler's 10-second budget, 2 M
  superseded records were released in two ticks and 2.16 M expired records were
  deleted in five. No tick ran more than 0.5 s over. PostgreSQL reuses the
  freed space but returns it to the file system only after `VACUUM FULL`.
- **Pinned first pages of one model are admitted one at a time** within
  `queryTimeoutMs`. With 50,000-row sources (0.4 s per query), 34–39 of 50
  concurrent first pages were admitted, and the rest were refused with their
  first page. With 10,000-row sources all 50 were admitted within 5.3 s.

### Follow-ups

- [#516](https://github.com/netrics-so/netrics/issues/516) (fixed): concurrent
  pinned first pages of different models or workspaces failed with
  `version_conflict`; see "After #516" above.
- [#517](https://github.com/netrics-so/netrics/issues/517) (fixed):
  `prune_dataset_history` deadlocked with policy and connection-retention
  changes, and the policy change could be the one that failed; see "After
  #517" above.
- [#518](https://github.com/netrics-so/netrics/issues/518):
  every `admin_set_data_policy` call with a retention ceiling rewrites all
  records of the workspace while holding the ingestion lock, and finds them by
  scanning every workspace's records.
- [#519](https://github.com/netrics-so/netrics/issues/519): stream Google Play
  report staging instead of buffering a whole report task.

## Configurable policy versus implementation safeguards

[Data policy](../packages/domain/src/data-policy.ts) is resolved from installation
settings plus workspace overrides. Workspace/generation storage and row quotas,
source/preparation/model counts, prepared-cache quotas and retention ceilings
have nullable limits. There is no fixed app-count quota in store discovery or
selection. Query defaults are 100,000 source rows, 5,000,000 operations, 128 MiB
output and a 15-second SQL statement timeout; these are configurable, including
`null`. The default 100 sync pages per worker turn is a cooperative yield budget,
not a total import limit: the cursor continues in another turn.

Ingestion and query row limits are consistent. Every read of a raw generation
(preview, preparation, publication and model query) loads at most `queryRows`,
so a source generation may hold at most the smaller of `maxGenerationRows` and
`queryRows`; `null` in one defers to the other, and only `null` in both removes
the bound. With the defaults (`maxGenerationRows: null`, `queryRows: 100000`) a
refresh whose staged or published rows exceed 100,000 fails at ingestion with
`dataset_refresh_limit` or `dataset_generation_limit`, and the previous generation
stays current. Previously such a source ingested successfully and then every
preview, publication and query failed with `data_source_row_limit`. The same
bound caps how many prior rows an incremental upsert/append/window refresh loads
into worker memory. Raising `queryRows` for a workspace raises its ingest bound
too. Generations already stored above the bound remain readable only under a
larger `queryRows`; their next incremental refresh is rejected until then.

Some limits bound one message or definition rather than a customer's total data:

| Safeguard                     | Current behavior                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dataset transport             | At most 1,000 records/1 MiB per page, 64 KiB per row, 1 KiB per key; further pages continue the refresh                                                 |
| Manual-table editor transport | At most 1,000 records and about 512 KiB per client batch; pinned read pages and one complete publication                                                |
| Model query response          | At most 1,000 groups per response; `totalRows` and `offset` expose further pages                                                                        |
| Pinned query continuation     | Opt-in sessions retain release/input identities under query-snapshot capacity/lifetime; expiry or unavailable history fails explicitly                  |
| Definition shape              | Bounded AST depth/node count, 100 fields, 100 graph steps, and bounded join/group keys; these are protocol/validation limits, not tier quotas           |
| Connector HTTP response       | Runtime default is 10 MiB per fully buffered response; `EgressOptions.maxResponseBytes` exists, but the Google connector uses the ordinary runtime path |
| Google earnings ZIP           | 64 MiB total decoded CSV bytes by default; encrypted, multipart and ZIP64 archives are rejected; the parser supports stored/deflate members             |
| Parsed connector staging      | 128 MiB serialized JSONB per stage, 1 MiB metadata, normal SDK page/record bounds; at most 24-hour cache lifetime capped by source/tier retention       |

These structural and transport checks cannot all be disabled through the customer
data-policy API. Removing a customer quota therefore does not mean that arbitrary
file sizes or definition shapes are currently supported.

The audit found a separate fixed 1,000-entry limit in the legacy observation
catalog, which could make Data & measures fail for many connections even under an
uncapped policy. The integration change for #466 removes that fixed ceiling,
applies the configured query-row policy and fetches only the requested identity
when reading an observation adapter. Its regression check covers more than 1,000
catalog entries. This was an account-size ceiling, not a necessary page boundary.

Reusing the query-row policy for the source listing made one oversized catalog
fail the whole source picker, and a `null` row policy left the listing unbounded.
The listing now has its own bound. The legacy observation catalog lists at most
10,000 entries (`DATA_SOURCE_CATALOG_ENTRIES`); beyond that the response sets
`truncated: true` instead of failing. Resource-name catalogs are counted rather
than loaded: an entry larger than the workspace `queryRows` is listed with its
`rowCount` and `rowLimitExceeded: true`, and only reading that source reports
`data_source_row_limit`. Listed resource entries carry no generation identity;
preview and queries still fingerprint the names they load.

The older `listNamedResources` helper still returns at most 500 choices in legacy
resource/widget listing paths. The store template options and `resources:` dataset
read the resource table directly and do not use that helper; the measured 1,300
names pass through the latter path. That older UI listing still needs explicit
pagination if it is to offer all resources. The public Google listing cache's
1,000-entry eviction is a cache-capacity choice; eviction does not exclude apps
from discovery or collection.

## Remaining scaling work

1. **Stream report staging, not only report parsing.** Range download and
   incremental parsing are in place (#488). The typed rows of one report task are
   still buffered before `datasetStaging.put`, and above about 23 MiB of report
   text the stage is refused and every page turn reads the report again (see
   "Google Play first-read memory" above;
   [#519](https://github.com/netrics-so/netrics/issues/519)). Preserve
   generation/digest, egress and decompression protections.
2. **Avoid full retained-generation copies for small corrections.** Ingestion
   loads prior rows into a map for upserts/replaced windows, reads staged pages,
   constructs the next complete map and writes all resulting records again.
   Use SQL copy-on-write/delta storage or versioned partitions with explicit
   snapshot semantics. Validate correction/deletion/replay and retention before
   replacing the current complete-generation invariant.
3. **Execute large preparations and queries without materializing every row.**
   The loader reads complete retained sources into memory; preparation steps make
   row copies, and prepared outputs are stored as JSONB. Labels, grouping and
   joins also build in-memory maps. Operation and output checks do not measure
   total concurrent process memory, and SQL `statement_timeout` is not a wall-clock
   deadline for synchronous JavaScript processing. Add streaming/SQL execution,
   cancellation and concurrency controls, then measure concurrent workloads.
4. **Finish large-catalog and editor transport.** Source listing currently issues
   metadata queries per dataset/connection and returns the complete catalog.
   The reference editor pages requests and renders 50 rows, but accumulates the
   whole editable table in browser memory. Add server-backed search/pagination,
   streaming import/export and scalable editing. Paginate the legacy 500-resource
   listing instead of silently restricting its choices.
5. **Retained history and concurrent customers.** Measured in #501 (above) with
   synthetic sources up to 4.16 M retained records, eight concurrent syncs and
   bursts of 50 pinned first pages; [#516](https://github.com/netrics-so/netrics/issues/516)
   and [#517](https://github.com/netrics-so/netrics/issues/517) are fixed.
   Still open: the follow-ups
   [#518](https://github.com/netrics-so/netrics/issues/518) and
   [#519](https://github.com/netrics-so/netrics/issues/519), real-account report
   shapes, and hosted or self-hosted resource sizes, which this repository does
   not record.

Implementation references: [raw generation publication](../packages/database/src/datasets.ts),
[data loading and prepared output caching](../apps/server/src/data/service.ts),
[resource metadata](../packages/database/src/resources.ts),
[Google continuation](../packages/connectors/src/google-play/sync.ts),
[Google ZIP parsing](../packages/connectors/src/google-play/tabular.ts), and
[connector egress](../packages/connector-runtime/src/egress.ts).
