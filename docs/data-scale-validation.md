# Data workload validation

This records the bounded validation and implementation audit for
[#466](https://github.com/netrics-so/netrics/issues/466) and Google report staging
in [#472](https://github.com/netrics-so/netrics/issues/472), part of milestone 11.
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

## Measured local run

Recorded on 2026-11-05 after the workload assertions passed. Environment: Apple M3
Max, arm64, 48 GiB RAM, Darwin 27.2.0, Node v25.9.0, PostgreSQL 17.10 in the existing
local Docker setup. Other development processes were running. The repository
requires Node >=24; these measurements are not from the production runtime or a
hosted/self-hosted acceptance environment. Free workspace disk before the run was
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

## Configurable policy versus implementation safeguards

[Data policy](../packages/domain/src/data-policy.ts) is resolved from installation
settings plus workspace overrides. Workspace/generation storage and row quotas,
source/preparation/model counts, prepared-cache quotas and retention ceilings
have nullable limits. There is no fixed app-count quota in store discovery or
selection. Query defaults are 100,000 source rows, 5,000,000 operations, 128 MiB
output and a 15-second SQL statement timeout; these are configurable, including
`null`. The default 100 sync pages per worker turn is a cooperative yield budget,
not a total import limit: the cursor continues in another turn.

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

The older `listNamedResources` helper still returns at most 500 choices in legacy
resource/widget listing paths. The store template options and `resources:` dataset
read the resource table directly and do not use that helper; the measured 1,300
names pass through the latter path. That older UI listing still needs explicit
pagination if it is to offer all resources. The public Google listing cache's
1,000-entry eviction is a cache-capacity choice; eviction does not exclude apps
from discovery or collection.

## Remaining scaling work

1. **Stream initial provider reads beyond the measured bounded staging path.**
   Google now durably stages parsed per-app pages for pinned report generations,
   avoiding repeated report transfer/decompression/parsing while the stage is live.
   The first read still buffers the complete report/frame under the existing
   10 MiB HTTP, 64 MiB ZIP inflation and 128 MiB stage safeguards. Streaming/range
   download and incremental parsing remain necessary before claiming larger-file
   support. Preserve generation/digest, egress and decompression protections.
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
5. **Measure retained history and concurrent customers.** Extend the fixture to
   representative real report widths, app/month counts, late corrections,
   abandoned staging, retention/deletion backlogs and hosted/self-hosted resource
   sizes. Measure database growth, query latency, transfer volume and peak memory.
   Page limits and nullable quotas alone do not satisfy this acceptance gate.

Implementation references: [raw generation publication](../packages/database/src/datasets.ts),
[data loading and prepared output caching](../apps/server/src/data/service.ts),
[resource metadata](../packages/database/src/resources.ts),
[Google continuation](../packages/connectors/src/google-play/sync.ts),
[Google ZIP parsing](../packages/connectors/src/google-play/tabular.ts), and
[connector egress](../packages/connector-runtime/src/egress.ts).
