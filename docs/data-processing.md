# Data processing implementation

The architecture is [ADR 0022](./decisions/0022-reusable-data-model-and-processing.md).
Implementation is tracked in [#439](https://github.com/netrics-so/netrics/issues/439).
The dataset foundation below is the first implementation slice, not the complete
model editor or dashboard query system.

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
expression graphs and semantic queries belong to the next slice.

Legacy observation descriptors from `listObservationDatasets` explicitly mark
their already-aggregated grain. Daily values remain reporting dates; the adapter
does not claim a provider timezone or reconstruct raw transactions. Existing
observation queries and retention remain unchanged.

## Bounds and privacy

Defaults: 100 fields; 1,000 records and 1 MiB per page; 64 KiB per record;
1 KiB per source key; 100 pages/100,000 records per refresh; 128 MiB per
published generation; 256 MiB logical source payload per workspace; 100 preview
rows; and a 15-second database statement timeout. A host can lower the workspace
budget. Quota failures roll back the page and its checkpoint. These are initial
operational bounds, not billing or feature gates.

Default retained-source lifetime is 30 days after collection. Personal fields
require an explicit retention policy of at most 90 days. The shortest field
policy applies to the complete record. Credential envelopes, headers and tokens
never belong in a dataset. JSON depth/size and scalar types are validated before
persistence; errors identify structure or field IDs without echoing values.

Expired rows are excluded at read time. Hourly scheduler maintenance removes
expired rows and pages in bounded batches through `prune_dataset_history`;
the scheduler role has no direct read access to source records. Every source
table uses forced RLS and tenant-aware foreign keys. SQL query predicates also
name the workspace. Published generation metadata may survive expiry so an
expired current dataset cannot fall back to older data.
