# 0026 — Dataset contract v1: the frozen dataset transport for connectors

Status: accepted (2026-11-20; [#800](https://github.com/netrics-so/netrics/issues/800),
milestone 13). Freezes what ADRs 0022, 0023 and 0024 and SDK 0.2.9–0.2.16
defined, and adds the optional field role `image` (SDK 0.2.17). Milestone 12
turns this record into the published SDK reference; until then the SDK
package stays private and nothing is released.

## Context

Typed source datasets (ADR 0022 section 1) are how a connector hands rows to
netrics: it declares datasets in its manifest and returns dataset pages in
its `SyncResult`. The bundled connectors are written in this repository and
change with the host, so the transport could move freely. The `custom-api`
connector (milestone 13) and community connectors (milestone 12) cannot:
a user's definition, or a connector built against an SDK version, must keep
loading and syncing after the host changes. That needs a written contract,
tests that fail when it moves, and a rule for how it may grow.

The custom connector also needs to mark a string field as an image URL, for
the latest-items widget, without a new data type.

## Decision

The dataset transport as it stands in SDK 0.2.17 is **dataset contract v1**.
The rules below are enforced by the code each one names, and pinned by the
fixtures in `packages/connector-sdk/src/contract/fixtures/v1/` (tested by
`dataset-contract-v1.test.ts` in the SDK and by `datasets.test.ts` in the
database package, which registers and ingests every accepted fixture).

### 1. Fields and types

A dataset declares 1–100 fields (`sourceDatasetSchema`, `DATASET_LIMITS.fields`).
A field (`datasetFieldSchema`, a strict object: unknown members are refused)
has exactly these members:

| Member           | Rule                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `id`             | `^[a-z][a-z0-9_.-]{0,99}$`, not `__proto__`, `constructor`, `prototype`; unique in a dataset |
| `name`           | 1–100 characters                                                                             |
| `type`           | one of the eight types below                                                                 |
| `nullable`       | boolean                                                                                      |
| `classification` | `public`, `internal` or `personal`                                                           |
| `retentionDays`  | optional; positive integer, or `null` (keep until deleted); see section 5                    |
| `unit`           | optional, 1–100 characters; `currency` and `currency_minor` mark money                       |
| `currencyField`  | optional; the id of the field holding the ISO 4217 code                                      |
| `scale`          | optional 0–18; only on `decimal` and `integer` fields                                        |
| `role`           | optional; `image` (SDK 0.2.17), see below                                                    |

Value encodings, as `validValue` in `packages/connector-sdk/src/datasets.ts`
checks them for every record:

- `string`: a JSON string. `boolean`: a JSON boolean.
- `integer`: a safe integer. `number`: a finite number.
- `decimal`: a string, `-?(0|[1-9][0-9]*)(\.[0-9]+)?`, at most 38 digits and
  at most `scale` (default 18) fraction digits.
- `date`: `YYYY-MM-DD`. `timestamp`: UTC with `Z`, no offset, at most 9
  fraction digits.
- `json`: bounded JSON data, at most 10,000 nodes and depth 8 (`isDataJson`).
- `null` only in a nullable field.

**Money.** A field with `currencyField`, or with unit `currency` or
`currency_minor`, must be `decimal` or `integer`, and its currency field must
exist, be a `string` and be non-null (`sourceDatasetSchema` refinement).
Every non-deleted record's currency value is three uppercase letters
(`validateDatasetPage`).

**The `image` role.** `role: "image"` says the field's value is an image URL.
Only `string` fields may carry it ("Image fields must be strings"); a key
field or a nullable field may. It is presentation only: it never changes
values, keys, storage, retention or which model bindings are valid, and
version compatibility ignores it (section 6). The API returns it on every
listed field (`dataFieldViewSchema.role` in `packages/contracts`), and the
domain carries it as `DataField.role`. Preparations (`executePreparation` in
`packages/domain/src/data-preparation.ts`, tested in
`data-field-role.test.ts`) keep or drop it as follows:

| Node                                                   | Role on output fields                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `source`                                               | as declared in the dataset                                                                              |
| `select`, `rename`, `filter`, `replace`, `deduplicate` | kept                                                                                                    |
| `append`                                               | kept when every input that has the column has the same role, else dropped (never an error); mapped kept |
| `join`                                                 | kept on left fields and on prefixed right fields                                                        |
| `calculate`                                            | kept on input fields; the new field and its `.currency` companion never have one                        |
| `cast`                                                 | dropped on the cast field                                                                               |
| `group`                                                | kept on key fields; aggregate outputs never have one                                                    |

The SDK (`DATASET_FIELD_ROLES`), the domain (`DataFieldRole`) and the API
contract each name the roles, because packages depend inward only;
`packages/contracts/src/data-processing.test.ts` tests that they agree.

### 2. Keys

`keyFields` lists 1–10 unique fields, each non-null and not `json`
(`sourceDatasetSchema`). The canonical record key is `datasetRecordKey`: the
key values in `keyFields` order, decimals normalised (trailing zeros and `-0`
removed), timestamps padded to nanoseconds, so equal values from different
encodings are one record. The key is at most 1 KiB (`DATASET_LIMITS.keyBytes`).

### 3. Modes

`mode` is one of (`sourceDatasetSchema`, behaviour in
`packages/database/src/datasets.ts`):

- `upsert`: a record replaces the stored record with the same key; a record
  with `deleted: true` carries only the key fields and deletes it. Only
  upsert datasets accept such tombstones (`validateDatasetPage`).
- `append`: events; the key is the event's identity. A re-sent identical
  event is stored once; the same key with other values is refused.
- `replace_window`: each page carries a half-open `window` (`from`,
  `toExclusive`, valid values of the reporting field) and an optional
  `partition` of scalar non-reporting fields. A complete refresh replaces
  exactly the stored records inside the window and partition; every record
  must lie inside both. Pages of other modes carry no window.
- `snapshot`: each complete refresh replaces the whole dataset.

### 4. Reporting field

`reportingField`, when set, names a non-null `date` or `timestamp` field;
`replace_window` requires one. `reportingTimeZone` is an IANA zone
(`Intl.DateTimeFormat` accepts it) that says which day a timestamp belongs
to (`sourceDatasetSchema`).

### 5. Retention

A dataset's `retentionDays` defaults to 30 (`DATASET_LIMITS.retentionDays`);
`null` keeps data until deleted. A field may set its own; a `personal` field
must set one explicitly (a number or `null`). The effective retention is the
smallest finite value of the dataset and its fields (`datasetRetentionDays`).

### 6. Versions

`version` is a positive integer per dataset. A registered version is
immutable: the same version with any other definition fails with
`dataset_schema_version_conflict`, including a different `role`. A new version
must be greater than the latest and `compatible()` with it (otherwise
`dataset_schema_incompatible`):

- dataset and field retention and field classification are unchanged;
- for `snapshot`, nothing else is checked (the next refresh replaces all);
- otherwise `keyFields`, `mode`, `reportingField` and `reportingTimeZone` are
  unchanged; every existing field stays with the same `type`, `unit`, `scale`
  and `currencyField`, and a nullable field stays nullable; added fields are
  nullable.

Names and roles are not compared: a role change in a new version is
compatible. When a connector update adds a dataset or a dataset version, the
host backfills that dataset for existing connections (#617, architecture
"connector updates").

### 7. Pages and checkpoints

A connector returns at most 20 dataset pages per `SyncResult`
(`syncResultSchema`, `DATASET_LIMITS.datasets`). A page
(`datasetPageSchema`, strict) names `datasetKey` and `schemaVersion` (which
must match the definition), a `refreshKey` stable across retries, `pageKey`
and `previousPageKey` chaining the refresh's pages, `complete` on the last
page, and at most 1,000 records, 1 MiB per page and 64 KiB per record. A
record lists exactly the dataset's fields (tombstones: exactly the key
fields). A staged page names both `stagingId` and `stagingPageKey` (ADR 0023,
ADR 0024).

The host stores each page durably before it commits the result's
`nextCursor` as the connection's checkpoint, in one transaction; a retried
page with the same keys is a replay, not a second copy. Rows become visible
only when the refresh's `complete` page arrives and its generation is
published. An incomplete or failed refresh never deletes or replaces stored
rows. `receivedDatasets` on a done result (SDK 0.2.12) marks datasets read
completely without rows; `nextFrom` (SDK 0.2.15) sets the next incremental
window start.

### 8. How v1 may change

Within v1, changes are additive and optional only. Each one bumps the SDK
patch version (0.2.x), adds an accepted fixture (and a rejected one where it
adds a rule), and extends this record. Fixtures are never edited or removed:
a fixture that stops passing is a breaking change. A breaking change is
dataset contract v2, with an ADR of its own and milestone 12's publishing
rules.

## Consequences

- The custom API connector and future community connectors can rely on the
  transport; the fixtures catch an accidental change in review.
- Field and dataset members are frozen by a test that lists them; adding one
  is a deliberate contract change.
- The `image` role costs no migration: roles live in the stored definition
  JSON (`data_schema_versions.definition`).
- Contract v1 is internal until milestone 12 publishes the SDK.
