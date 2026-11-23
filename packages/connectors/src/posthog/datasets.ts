import type {
  DatasetField,
  SourceDatasetDefinition,
} from "@netrics/connector-sdk";

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
 * The most frequent event names per project and UTC day, ranked. Keyed by
 * rank, so a day read again replaces its ranks: an event that falls out of
 * the top leaves no stale row behind (upsert).
 */
export const topEventsDataset: SourceDatasetDefinition = {
  key: "top_events",
  name: "PostHog top events",
  version: 1,
  mode: "upsert",
  keyFields: ["project_id", "day", "rank"],
  grain:
    "One of the most frequent events of a PostHog project on one day (UTC)",
  retentionDays: 400,
  fields: [
    field("project_id", "Project ID", "string"),
    field("project_name", "Project", "string"),
    field("day", "Day", "date"),
    field("rank", "Rank", "integer"),
    field("event", "Event", "string"),
    field("events", "Events", "integer", { unit: "events" }),
  ],
};

/**
 * The results of the saved trends insights a connection names, as PostHog
 * last computed them: one row per series and time bucket (a day, week or
 * month, or "total" for a single-number insight). Replaced as a whole by
 * every sync that read every insight (snapshot).
 */
export const insightResultsDataset: SourceDatasetDefinition = {
  key: "insight_results",
  name: "PostHog insight results",
  version: 1,
  mode: "snapshot",
  keyFields: ["project_id", "insight_id", "series_index", "bucket"],
  grain: "One series of a saved PostHog trends insight in one time bucket",
  retentionDays: 30,
  fields: [
    field("project_id", "Project ID", "string"),
    field("insight_id", "Insight ID", "string"),
    field("insight_name", "Insight", "string"),
    field("series_index", "Series", "integer"),
    field("series_label", "Series label", "string", { nullable: true }),
    field("breakdown_value", "Breakdown value", "string", { nullable: true }),
    field("compare_label", "Comparison", "string", { nullable: true }),
    field("interval", "Interval", "string"),
    field("bucket", "Bucket", "string"),
    field("day", "Bucket start", "date", { nullable: true }),
    field("value", "Value", "number", { nullable: true }),
    field("computed_at", "Computed by PostHog", "timestamp", {
      nullable: true,
    }),
    field("as_of", "Read", "timestamp"),
  ],
};

/**
 * What became of each configured insight on the last sync: read, or why
 * not (not found, not a trends insight, an interval netrics does not read,
 * too large, not selected, refused, not computed yet). Replaced by every
 * sync (snapshot).
 */
export const insightsDataset: SourceDatasetDefinition = {
  key: "insights",
  name: "PostHog saved insights",
  version: 1,
  mode: "snapshot",
  keyFields: ["project_id", "insight_id"],
  grain: "One saved PostHog insight the connection names",
  retentionDays: 30,
  fields: [
    field("project_id", "Project ID", "string"),
    field("insight_id", "Insight ID", "string"),
    field("insight_name", "Insight", "string", { nullable: true }),
    field("status", "Status", "string"),
    field("interval", "Interval", "string", { nullable: true }),
    field("rows", "Rows", "integer"),
    field("computed_at", "Computed by PostHog", "timestamp", {
      nullable: true,
    }),
    field("checked_at", "Checked", "timestamp"),
  ],
};

export const POSTHOG_DATASETS = [
  topEventsDataset,
  insightResultsDataset,
  insightsDataset,
] as const;

/** Statuses of the `insights` dataset. */
export const INSIGHT_STATUSES = [
  "ok",
  "not_found",
  "unsupported",
  "too_large",
  "not_selected",
  "denied",
  "not_ready",
] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

/** PostHog's instants, as the dataset contract wants them (UTC, `Z`). */
export function utc(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
