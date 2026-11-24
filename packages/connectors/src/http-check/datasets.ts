import type {
  DatasetField,
  DatasetRecord,
  SourceDatasetDefinition,
} from "@netrics/connector-sdk";

import { displayUrl, type HttpCheck } from "./checks.js";
import type { ProbeResult } from "./probe.js";

function field(
  id: string,
  name: string,
  type: DatasetField["type"],
  extra: Partial<DatasetField> = {},
): DatasetField {
  return {
    id,
    name,
    type,
    nullable: false,
    classification: "internal",
    ...extra,
  };
}

/**
 * Every check of the connection as of its last run, replaced as a whole by
 * every run that requested every check (snapshot): the status widget's
 * source for "is it up" (#875).
 */
export const checksDataset: SourceDatasetDefinition = {
  key: "checks",
  name: "HTTP checks",
  version: 1,
  mode: "snapshot",
  keyFields: ["check_id"],
  grain: "One HTTP check, as of its last run",
  retentionDays: 30,
  fields: [
    field("check_id", "Check ID", "string"),
    field("name", "Check", "string"),
    field("url", "URL", "string"),
    field("host", "Host", "string"),
    field("method", "Method", "string"),
    field("expected_status", "Expected status", "string"),
    field("state", "State", "string"),
    field("reason", "Reason", "string", { nullable: true }),
    field("status_code", "Status code", "integer", { nullable: true }),
    field("response_ms", "Response time", "integer", {
      nullable: true,
      unit: "ms",
    }),
    field("checked_at", "Checked", "timestamp"),
    field("last_change_at", "State since", "timestamp", { nullable: true }),
  ],
};

export const HTTP_CHECK_DATASETS = [checksDataset] as const;

export function checkRecord(
  check: HttpCheck,
  result: ProbeResult,
  checkedAt: string,
  lastChangeAt: string | null,
): DatasetRecord {
  return {
    values: {
      check_id: check.id,
      name: check.name,
      url: displayUrl(check.url),
      host: check.host,
      method: check.method,
      expected_status: check.expectedStatus,
      state: result.up ? "up" : "down",
      reason: result.reason,
      status_code: result.status,
      response_ms: result.responseMs,
      checked_at: checkedAt,
      last_change_at: lastChangeAt,
    },
  };
}
