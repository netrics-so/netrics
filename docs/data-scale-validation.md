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

**After #518.** A policy call with a ceiling (and a connection-retention
save) now writes only the rows whose deadline moves, and reaches a
workspace's records through its generations and the record primary key
(migration 0066). The history suite, rerun on 2026-11-07 on the same machine
and settings (three fresh processes). The suite now counts the
`data_records` rows each call updates:

| Call                                                                             | Before #518        | After #518                  | Records updated |
| -------------------------------------------------------------------------------- | ------------------ | --------------------------- | --------------: |
| First `maxRetentionDays: 3650` on the large workspace                            | 37.6 s [34.2–39.1] | 38.6 s [36.1–41.7]          |       4,160,000 |
| `{maxRetentionDays: 3650, queryRows: 100000}` right afterwards                   | 43.4 s [36.9–46.1] | 683 ms [626–692]            |               0 |
| The same call again                                                              | not measured       | 590 ms [580–675]            |               0 |
| `{queryRows: 100000}` without a ceiling                                          | 4.6 ms             | 2.4 ms [1.2–333]            |               0 |
| `maxRetentionDays: 3650` on the 1,000-record neighbour, then the same call again | 3.4 s [2.7–5.1]    | 16.7 ms [15.2–63.2], 5.3 ms |        1,000, 0 |
| `maxRetentionDays: 1`, after the superseded half was drained (2.16 M records)    | 20.0 s [18.2–20.9] | 18.7 s [18.1–19.0]          |       2,160,000 |

- The first ceiling still writes every record: they were all kept until
  deleted, and each one now gets a deadline. A shortening writes each record
  it moves. Both happen in one statement under the ingestion lock, so no
  record stays readable past its new deadline.
- A call that moves nothing writes nothing. It still reads the workspace's
  records once under the lock: about 0.6 s for 4.16 M records, instead of a
  full rewrite of 37–50 s.
- `data_records` heap: 1.36 GB, then 2.78 GB after the first ceiling. It is
  still 2.78 GB (+0.3 MB) after the calls that changed nothing; before, the
  same sequence reached 4.20 GB. One run on `main` with the three large calls
  above reached 5.62 GB.
- Plan of the record update for the neighbour: a nested loop over its
  generations into a `Bitmap Index Scan` on
  `data_records_generation_id_record_key_pk`. Before, it was a `Seq Scan` over
  all 4.16 M records. For the large workspace, which holds 99.9% of the table,
  the planner keeps a hash join over a sequential scan.

Drains in the same runs: the expired history (2.16 M rows after the one-day
ceiling) drained in 19.5 s [18.8–19.7] over 2 ticks, against 46.6 s over 5
before #517. The superseded generations (2.0 M rows) took 101.7 s
[100.8–109.3] over 10–11 ticks (call p50 515 ms), against 13.4 s before #517.
A single run on `main` after #517, without this change, took 76.2 s over 8
ticks (call p50 78 ms, p95 888 ms). This slowdown comes from prune itself
(0065), not from the policy change. After its fifth call in a session,
PL/pgSQL caches a generic plan for prune's check for remaining expired
records, `EXISTS (SELECT 1 FROM data_records WHERE expires_at <= p_now)`.
That plan is a sequential scan of the whole table, about 0.5 s per call at
this size. Whether the generic plan wins depends on table statistics, so
runs differ in how many calls pay for it
([#524](https://github.com/netrics-so/netrics/issues/524)).

**After #524.** Prune takes a batch of expired records and checks for
remaining ones in deadline order (`ORDER BY expires_at` with a limit), which
only the expiry index answers without sorting, under any cached plan
(migration 0068). The history suite, rerun on 2026-11-08 on the same machine
and settings (three fresh processes; other idle containers were running, and
unrelated timings such as the policy calls differed from 2026-11-07 by up to
22%):

| Drain                                          | Before #517     | After #523                     | After #524                              |
| ---------------------------------------------- | --------------- | ------------------------------ | --------------------------------------- |
| 100 superseded generations (2,002,200 rows)    | 13.4 s, 2 ticks | 101.7 s, 10–11 ticks (p50 515) | 11.4 s [10.3–11.7], 2 ticks (p50 56)    |
| Whole history after a one-day ceiling (2.16 M) | 46.6 s, 5 ticks | 19.5 s, 2 ticks                | 22.3 s [19.4–23.2], 2–3 ticks (p50 195) |

Call p50 in ms. Superseded generations drain at 175,115 rows/s
[170,612–193,858] again (call p95 67 ms, max 274 ms). Expired history drains
at 96,959 rows/s [93,185–111,127] (call p95 366 ms, max 630 ms). No tick ran
more than 0.15 s over its budget.

Forcing custom plans for the whole function (`plan_cache_mode =
force_custom_plan`) was tried first. It fixed the superseded drain (11.9 s),
but the expired drain took 48.8 s [48.2–57.0] over 5 ticks (call p50 439 ms):
each call re-planned the three statements prune runs for every expired
generation, about 100 here. One run on the same day with generic plans, as
on `main`, took 86.6 s and 19.1 s.

**After #531.** Prune marks an expired generation once it has no records
left (`data_generations.records_pruned`, migration 0069) and no longer looks
up records for marked ones. Records are only written with their generation,
so a generation without records never gets any again. Superseded generations
are deleted once marked, so that statement searches no generation for
records. Before, every call looked up the records of every expired
generation, including current ones, which stay until a newer refresh
replaces them. Until vacuum, each such lookup read the index entries of all
the generation's deleted records. The history suite ran on 2026-11-08 on the
same machine and settings, three fresh processes each, `main` and this
change back to back. Other agents were running tests on the machine at the
same time:

| Drain                                          | `main` (after #524)                     | After #531                             |
| ---------------------------------------------- | --------------------------------------- | -------------------------------------- |
| 100 superseded generations (2,002,200 rows)    | 10.8 s [10.8–11.2], 2 ticks (p50 52)    | 10.8 s [9.9–10.8], 1–2 ticks (p50 52)  |
| Whole history after a one-day ceiling (2.16 M) | 20.5 s [20.1–21.0], 2–3 ticks (p50 185) | 11.2 s [10.0–13.4], 1–2 ticks (p50 94) |

Call p50 in ms. Expired history now drains at 193,332 rows/s
[161,209–216,334] against 105,140 [102,894–107,524] (call p95 175 ms
[113–190] against 347 [301–364]; max 568 against 543). The superseded drain
is unchanged. No tick ran more than 0.5 s over its budget.

A fixture with 100 expired current generations of 20,000 records each
(batch 10,000, one call per transaction) shows where the time went. On
`main`, each call after the drain still made 300 scans of the
`data_records` primary key, reading 66,000 index blocks (about 0.15 s), until
vacuum. Now it makes none (8 ms). The drain itself took 15.2 s instead of
20.6 s (call p50 135 ms against 178, p95 222 against 358). The remaining
cost late in a drain comes from the expiry-ordered record delete and the
per-generation loop deleting from the same generations: the loop's first
lookup in a generation passes the records the other delete removed.

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

**After #518.** The policy loop now writes only the records whose deadline
moves. Between two calls that set 3650, the loop sets 3651, which moves
nothing. A call that sets 3650 again shortens only the records ingested
meanwhile. The churn scenario, rerun on 2026-11-07 on the same machine and
settings (three fresh processes):

| Concurrent operation      | Calls per run | p50 (ms)      | p95 (ms)            | Failures over 3 runs          |
| ------------------------- | ------------: | ------------- | ------------------- | ----------------------------- |
| `admin_set_data_policy`   |         23–24 | 522 [515–569] | 5,502 [3,716–5,619] | none                          |
| `setConnectionRetention`  |         23–25 | 545 [522–592] | 4,429 [4,155–5,416] | none                          |
| `prune_dataset_history`   |       120–128 | 108 [105–110] | 309 [294–310]       | none                          |
| Model query (10,000 rows) |       150–158 | 109 [106–109] | 140 [132–142]       | none; 0 serialization retries |

| Syncs (8 workers, one workspace, with churn) | After #517              | After #518                                |
| -------------------------------------------- | ----------------------- | ----------------------------------------- |
| Records/s                                    | 2,221 [2,019–2,427]     | 7,178 [7,112–7,622]                       |
| Page p50 / p95 (ms)                          | 3,368 [3,266–3,905] / – | 466 [420–490] / 3,748 [3,463–3,787]       |
| Lock wait p95 / max (ms)                     | 6,590 [6,380–7,690] / – | 3,792 [3,513–3,808] / 5,026 [4,897–5,143] |

Deadlocks: 0 in every run, and no transaction rolled back. The scenario
finishes in about 33 s instead of about 108 s, so every loop makes fewer
calls in that time. Policy and connection-retention calls still wait for the
ingestion lock behind the sync pages, so their p95 includes that wait. Prune
calls take about 108 ms because of the generic-plan sequential scan described
under "Retained history" (see "After #524" below).
The two scenarios without churn are unchanged: 33,224 records/s
[33,086–33,680] in eight workspaces, and 16,135 [15,949–16,374] in one.

**After #524.** The churn scenario, rerun on 2026-11-08 on the same machine
and settings (three fresh processes):

| Concurrent operation      | Calls per run | p50 (ms)      | p95 (ms)            | Failures over 3 runs          |
| ------------------------- | ------------: | ------------- | ------------------- | ----------------------------- |
| `admin_set_data_policy`   |         25–26 | 594 [520–619] | 5,010 [4,241–5,493] | none                          |
| `setConnectionRetention`  |            26 | 579 [566–635] | 4,847 [4,425–4,945] | none                          |
| `prune_dataset_history`   |       221–243 | 7.5 [7.4–7.5] | 202 [201–207]       | none                          |
| Model query (10,000 rows) |       162–171 | 108 [108–110] | 147 [133–161]       | none; 0 serialization retries |

Prune calls take 7.5 ms at the median instead of 108 ms, so the loop makes
about twice as many calls in the same time. Deadlocks: 0, and no transaction
rolled back. Syncs: 6,694 records/s [6,445–6,960], page p50 559 ms, lock wait
p95 4,291 ms. The two scenarios without churn, which do not prune, ran 3–4%
slower than on 2026-11-07 (31,958 and 15,564 records/s): the same machine
noise as above.

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

#### After #519

Since [#525](https://github.com/netrics-so/netrics/issues/525) and
[#519](https://github.com/netrics-so/netrics/issues/519)
([ADR 0024](./decisions/0024-streaming-connector-staging.md)) the connector
writes a report task to the stage while it reads the report
(`datasetStaging.begin`, `append`, `commit`). Rows stay in parse order per app,
each app holds at most one pending page, and all pending pages together are
kept under 8 MiB of row JSON by writing the largest one out early. The host
stores pages gzip-compressed and counts those bytes against the stage limit and
`maxConnectorStagingBytes`. A later turn takes consecutive staged pages of its
app, up to about one full page of rows.

Same synthetic archives, environment and method as above (2026-11-07, three
runs each, `node scripts/scale/run.ts play --runs 3`). "Stored stage" is the
compressed page bytes of the stage.

| Inflated CSV (lines) | Scope    | First read         | Peak heap above baseline | Peak RSS          | Stored stage     | Each later page turn                 |
| -------------------- | -------- | ------------------ | ------------------------ | ----------------- | ---------------- | ------------------------------------ |
| 8 MiB (41,112)       | all apps | 2.4 s [2.3–2.4]    | 107 MiB [100–111]        | 308 MiB [295–312] | 2.9 MiB, staged  | 41 ms [28–49], 889 rows, no download |
| 8 MiB (4,112 rows)   | one app  | 0.5 s [0.5–0.5]    | 47 MiB [46–54]           | 226 MiB [224–227] | 0.3 MiB, staged  | 21 ms [19–29], 981 rows, no download |
| 16 MiB (82,225)      | all apps | 4.6 s [4.6–4.6]    | 101 MiB [101–112]        | 294 MiB [290–310] | 5.7 MiB, staged  | 43 ms [28–55], 889 rows, no download |
| 16 MiB (8,223 rows)  | one app  | 0.8 s [0.8–0.8]    | 57 MiB [53–63]           | 241 MiB [232–242] | 0.5 MiB, staged  | 21 ms [20–22], 981 rows, no download |
| 32 MiB (164,451)     | all apps | 9.0 s [9.0–10.3]   | 116 MiB [102–117]        | 328 MiB [327–333] | 11.4 MiB, staged | 41 ms [29–49], 889 rows, no download |
| 32 MiB (16,446 rows) | one app  | 1.6 s [1.6–1.6]    | 64 MiB [63–91]           | 265 MiB [263–286] | 1.1 MiB, staged  | 20 ms [19–23], 981 rows, no download |
| 63 MiB (323,763)     | all apps | 17.8 s [17.6–17.8] | 162 MiB [153–162]        | 374 MiB [361–395] | 22.4 MiB, staged | 46 ms [32–54], 889 rows, no download |
| 63 MiB (32,377 rows) | one app  | 3.1 s [3.1–3.2]    | 96 MiB [73–96]           | 338 MiB [334–343] | 2.2 MiB, staged  | 21 ms [19–23], 981 rows, no download |

Every size is now staged; the 63 MiB all-apps archive takes 22.4 MiB of the
128 MiB stage limit (1,942 pages) instead of being refused, and no later turn
downloads the report again. The first read is 30% faster at 63 MiB and twice as
fast at 8 MiB, because nothing is sorted or held until the end.

The heap column samples `heapUsed + arrayBuffers` every 5 ms, as above. It
includes garbage the collector has not reached yet, and it no longer grows
with the report: 101–162 MiB from 8 to 63 MiB, against 173 MiB to 1.4 GiB
before. Memory that is actually retained is smaller. Rerun with
`NETRICS_SCALE_PLAY_LIVE=1`, which collects garbage before a sample every
100 ms, the 63 MiB all-apps first read retains at most 45 MiB above the
baseline (45 in all three runs; 15 MiB [14–16] for one app). With those
collections, the 5 ms samples peak at 75 MiB and the first read takes 19.6 s.
#519's acceptance (a constant number of pages per app, well under 100 MiB
above baseline) holds for retained memory; the sampled peak, which includes
uncollected garbage, is 162 MiB.

Without a stage (a host without `begin`, or a refused stage), a turn reads the
report again and keeps only its app's rows from the checkpoint, up to eight
pages. A report task then costs about one read per app plus one per eight
pages, instead of one per page (`staging-quota.test.ts` and the connector's
`staging.test.ts` check this).

#### After #528

The first read allocated about 20 GiB for the 63 MiB all-apps archive, most of
it short-lived copies of the same rows. V8's sampling heap profiler over the
turn (`NETRICS_SCALE_PLAY_ALLOC=1`, which keeps collected objects in the
profile) attributed 12.9 GiB to the host preparing staged pages and 7.5 GiB to
reading the CSV. Without changing any output, digest or contract:

- The SDK's page validation built a zod schema for every date and timestamp
  value. It walked each JSON value with a stack of tuples, and walked JSON
  fields twice. It also encoded every row into a buffer only to measure its
  byte length. Schemas are now built once, the JSON check allocates nothing,
  and UTF-8 lengths are counted in place.
- The host's page digest serialization (`stable`) made entry, sort and join
  arrays for every object. It now concatenates, and sorts keys in place. The
  bytes, and so the digests of stored pages, are unchanged.
- The connector's CSV scanner appended every field one character at a time.
  It now slices runs. Row ids are hashed from a column order worked out once
  per file, and dates are checked against one schema.

Tests compare each rewrite with the previous implementation: the digests, the
bounded-JSON check, UTF-8 lengths, CSV cells over random inputs and chunk
splits, and row ids.

Same archives, environment and method; `main` and this change rerun on
2026-11-08 (three runs each):

| Inflated CSV | Scope    | First read on `main` | First read now     | Peak heap on `main` | Peak heap now     |
| ------------ | -------- | -------------------- | ------------------ | ------------------- | ----------------- |
| 8 MiB        | all apps | 2.2 s [2.2–2.2]      | 1.9 s [1.8–1.9]    | 91 MiB [69–105]     | 67 MiB [66–74]    |
| 8 MiB        | one app  | 0.4 s [0.4–0.4]      | 0.4 s [0.3–0.4]    | 50 MiB [50–51]      | 43 MiB [38–44]    |
| 16 MiB       | all apps | 4.4 s [4.4–4.5]      | 3.6 s [3.6–3.6]    | 98 MiB [94–111]     | 72 MiB [67–74]    |
| 16 MiB       | one app  | 0.8 s [0.8–0.8]      | 0.7 s [0.7–0.7]    | 53 MiB [53–69]      | 44 MiB [44–57]    |
| 32 MiB       | all apps | 8.8 s [8.7–8.8]      | 7.1 s [7.1–7.3]    | 111 MiB [111–124]   | 89 MiB [84–90]    |
| 32 MiB       | one app  | 1.6 s [1.6–1.6]      | 1.3 s [1.3–1.3]    | 57 MiB [57–58]      | 47 MiB [44–49]    |
| 63 MiB       | all apps | 17.2 s [17.0–17.6]   | 14.0 s [14.0–14.1] | 136 MiB [135–137]   | 131 MiB [110–137] |
| 63 MiB       | one app  | 3.0 s [3.0–3.1]      | 2.5 s [2.4–2.5]    | 63 MiB [62–65]      | 46 MiB [43–52]    |

For the 63 MiB archive, the profiler's estimate of what the first read
allocates fell from 20.7 GiB [20.6–20.7] to 12.2 GiB [12.2–12.2] with all
apps (preparing pages 7.1 GiB, reading the CSV 4.9 GiB), and from 4.4 GiB to
2.5 GiB for one app. Every first read is 16–20% faster. The stages are the
same: 300, 539, 1,016 and 1,942 pages, with the same stored bytes.

The sampled peak for the 63 MiB all-apps read barely moved (136 to 131 MiB)
and stays above #528's 100 MiB target. What it measures there is garbage
waiting for a collection, not memory the read needs:

- Retained memory is unchanged: 44 MiB in all three runs, against 45 MiB
  [45–46] on `main` (`NETRICS_SCALE_PLAY_LIVE=1`). With those collections,
  the 5 ms samples peak at 77 MiB [76–78].
- The process does not grow by the sampled amount. During the read, RSS
  rises 39 MiB [39–44] above the baseline, against 48 MiB [48–71] on `main`:
  about what is retained. The uncollected garbage reuses heap pages the
  process already holds.
- The smaller archives now stay under 100 MiB (67–89 MiB, against
  91–111 MiB on `main`).

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
- [#518](https://github.com/netrics-so/netrics/issues/518) (fixed):
  every `admin_set_data_policy` call with a retention ceiling rewrote all
  records of the workspace while holding the ingestion lock, and found them by
  scanning every workspace's records; see "After #518" above. A call that
  moves nothing still reads the workspace's records once under the lock.
- [#524](https://github.com/netrics-so/netrics/issues/524) (fixed): after
  five calls in a session, prune's check for remaining expired records could
  switch to a cached generic plan that scans all of `data_records`, about
  0.5 s per call at 4.16 M records; see "After #524" above.
- [#519](https://github.com/netrics-so/netrics/issues/519) (fixed, with
  [#525](https://github.com/netrics-so/netrics/issues/525)): Google Play report
  staging is streamed instead of buffering a whole report task; see "After
  #519" above.
- [#528](https://github.com/netrics-so/netrics/issues/528) (done): the
  first read of a Google Play report allocated about 20 GiB for 63 MiB of CSV
  in short-lived copies; 41% less now, and 16–20% faster. The remaining
  sampled peak is uncollected garbage, not retained memory or RSS; see "After
  #528" above.
- [#531](https://github.com/netrics-so/netrics/issues/531) (fixed): each
  prune call checked every expired generation, current ones included, for
  records. While a drain was deleting records, and until vacuum, that check
  walked primary-key entries of records already deleted (up to 0.67 s in one
  call of a 2 M-record fixture). Prune now marks emptied generations and
  skips them; the expired-history drain took 11.2 s instead of 20.5 s; see
  "After #531" above.

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
