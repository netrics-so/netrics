import type { CustomApiDefinition, CustomApiStream } from "@netrics/contracts";

import { canonicalJson } from "./canonical-json.js";

// Dataset schema versions of a custom API definition's streams (#803). Each
// stream is a source dataset; its version changes when what the dataset
// stores changes (fields and their types, keys, mode, retention, the zone a
// date reporting field is read in), not when only how values are fetched
// changes (names, paths, formats, request, pagination, window).

function streamSignature(
  stream: CustomApiStream,
  document: CustomApiDefinition,
): string {
  const fields = stream.fields
    .map((field) => ({
      id: field.id,
      type: field.type,
      nullable: field.nullable,
      classification: field.classification,
      unit: field.unit,
      currencyField: field.currencyField,
      scale: field.scale,
      role: field.role,
      retentionDays: field.retentionDays,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const reporting = stream.fields.find(
    (field) => field.id === stream.reportingField,
  );
  return canonicalJson({
    fields,
    keyFields: stream.keyFields,
    mode: stream.mode,
    reportingField: stream.reportingField,
    retentionDays: stream.retentionDays,
    reportingTimeZone:
      reporting?.type === "date" ? document.defaults.timeZone : undefined,
  });
}

/**
 * Stream key → dataset version. New stream → 1; unchanged signature →
 * previous; changed signature → previous + 1; removed streams dropped.
 */
export function customApiDatasetVersions(
  previous: {
    document: CustomApiDefinition;
    datasetVersions: Readonly<Record<string, number>>;
  } | null,
  next: CustomApiDefinition,
): Record<string, number> {
  const before = new Map(
    (previous?.document.streams ?? []).map((stream) => [
      stream.key,
      streamSignature(stream, previous!.document),
    ]),
  );
  const versions: Record<string, number> = {};
  for (const stream of next.streams) {
    const signature = before.get(stream.key);
    const version = previous?.datasetVersions[stream.key];
    if (signature === undefined || version === undefined) {
      versions[stream.key] = 1;
    } else {
      versions[stream.key] =
        signature === streamSignature(stream, next) ? version : version + 1;
    }
  }
  return versions;
}
