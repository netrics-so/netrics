import type {
  DatasetField,
  DatasetRecord,
  SourceDatasetDefinition,
} from "@netrics/connector-sdk";

import type { RailwayDeployment } from "./queries.js";

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
 * Deployments, one row each, updated while they change (upsert). Rows of
 * the recent days are read again on every sync (see the connector), so a
 * deployment's status follows Railway for a few days; after that the row
 * keeps the status it had then. The current state is `service_states`.
 */
export const deploymentsDataset: SourceDatasetDefinition = {
  key: "deployments",
  name: "Railway deployments",
  version: 1,
  mode: "upsert",
  keyFields: ["deployment_id"],
  grain: "One Railway deployment of a service in an environment",
  retentionDays: 400,
  fields: [
    field("deployment_id", "Deployment ID", "string"),
    field("project_id", "Project ID", "string"),
    field("service_id", "Service ID", "string", { nullable: true }),
    field("service_name", "Service", "string", { nullable: true }),
    field("environment_id", "Environment ID", "string"),
    field("environment_name", "Environment", "string", { nullable: true }),
    field("status", "Status", "string"),
    field("failed", "Failed or crashed", "boolean"),
    field("created_at", "Created", "timestamp"),
    field("status_updated_at", "Status changed", "timestamp", {
      nullable: true,
    }),
    field("finished_at", "Finished", "timestamp", { nullable: true }),
    field("duration_seconds", "Duration", "integer", {
      nullable: true,
      unit: "seconds",
    }),
  ],
};

/**
 * The current state of every service in every (non-ephemeral) environment,
 * replaced as a whole by every sync (snapshot).
 */
export const serviceStatesDataset: SourceDatasetDefinition = {
  key: "service_states",
  name: "Railway service states",
  version: 1,
  mode: "snapshot",
  keyFields: ["service_id", "environment_id"],
  grain: "One Railway service in one environment, as of the last sync",
  retentionDays: 30,
  fields: [
    field("project_id", "Project ID", "string"),
    field("project_name", "Project", "string"),
    field("service_id", "Service ID", "string"),
    field("service_name", "Service", "string"),
    field("environment_id", "Environment ID", "string"),
    field("environment_name", "Environment", "string"),
    field("state", "State", "string"),
    field("active_deployments", "Active deployments", "integer"),
    field("latest_deployment_id", "Latest deployment ID", "string", {
      nullable: true,
    }),
    field("latest_status", "Latest deployment status", "string", {
      nullable: true,
    }),
    field("latest_created_at", "Latest deployment created", "timestamp", {
      nullable: true,
    }),
    field(
      "latest_status_updated_at",
      "Latest deployment status changed",
      "timestamp",
      { nullable: true },
    ),
    field("checked_at", "Checked", "timestamp"),
  ],
};

/**
 * Usage and its estimated list price per project for the current calendar
 * month (UTC), replaced by every sync that reads it (snapshot).
 */
export const projectUsageDataset: SourceDatasetDefinition = {
  key: "project_usage",
  name: "Railway usage this month",
  version: 1,
  mode: "snapshot",
  keyFields: ["project_id"],
  grain: "One Railway project, its usage this calendar month (UTC)",
  retentionDays: 30,
  fields: [
    field("project_id", "Project ID", "string"),
    field("project_name", "Project", "string"),
    field("month", "Month", "date"),
    field("as_of", "As of", "timestamp"),
    field("cpu_vcpu_minutes", "CPU", "number", { unit: "vCPU minutes" }),
    field("memory_gb_minutes", "Memory", "number", { unit: "GB minutes" }),
    field("egress_gb", "Network egress", "number", { unit: "GB" }),
    field("disk_gb_minutes", "Volume storage", "number", {
      unit: "GB minutes",
    }),
    field("cost_usd", "Estimated cost so far", "decimal", {
      scale: 4,
      currencyField: "currency",
    }),
    field(
      "estimated_cost_usd",
      "Estimated cost for the billing period",
      "decimal",
      {
        nullable: true,
        scale: 4,
        currencyField: "currency",
      },
    ),
    field("currency", "Currency", "string"),
  ],
};

export const RAILWAY_DATASETS = [
  deploymentsDataset,
  serviceStatesDataset,
  projectUsageDataset,
] as const;

// ─── Status classes ─────────────────────────────────────────────────────────

/** Statuses of a deployment that is still on its way. */
const IN_PROGRESS = new Set([
  "QUEUED",
  "WAITING",
  "NEEDS_APPROVAL",
  "INITIALIZING",
  "BUILDING",
  "DEPLOYING",
]);
const FAILED = new Set(["FAILED", "CRASHED"]);
/**
 * Statuses whose `statusUpdatedAt` is when the deployment finished. A later
 * status (REMOVED when replaced, CRASHED, SLEEPING) moves `statusUpdatedAt`
 * past the end of the deployment, so it gives no duration.
 */
const FINISHED_AT_STATUS = new Set(["SUCCESS", "FAILED", "SKIPPED"]);

export function isInProgress(status: string): boolean {
  return IN_PROGRESS.has(status);
}

export function isFailed(status: string): boolean {
  return FAILED.has(status);
}

/**
 * The state of a service in an environment, for status widgets:
 *
 * - "building": its latest deployment is queued, building or deploying;
 * - "up": a deployment is running (SUCCESS), even when a newer one failed;
 * - "sleeping": its running deployment sleeps until a request wakes it;
 * - "failed": nothing runs and the latest deployment failed or crashed;
 * - "down": nothing runs (removed, never deployed, skipped).
 */
export type ServiceState = "building" | "up" | "sleeping" | "failed" | "down";

export function serviceState(
  latestStatus: string | null,
  activeStatuses: readonly string[],
): ServiceState {
  if (latestStatus !== null && isInProgress(latestStatus)) return "building";
  if (activeStatuses.includes("SUCCESS")) return "up";
  if (activeStatuses.includes("SLEEPING")) return "sleeping";
  if (activeStatuses.some(isFailed)) return "failed";
  if (latestStatus !== null && isFailed(latestStatus)) return "failed";
  return "down";
}

/** Railway's instants, as the dataset contract wants them (UTC, `Z`). */
export function utc(value: string): string;
export function utc(value: string | null | undefined): string | null;
export function utc(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

export function deploymentRecord(
  deployment: RailwayDeployment,
  names: {
    services: ReadonlyMap<string, string>;
    environments: ReadonlyMap<string, string>;
  },
): DatasetRecord {
  const createdAt = utc(deployment.createdAt);
  const statusUpdatedAt = utc(deployment.statusUpdatedAt);
  const finishedAt =
    statusUpdatedAt !== null && FINISHED_AT_STATUS.has(deployment.status)
      ? statusUpdatedAt
      : null;
  const duration =
    finishedAt !== null
      ? Math.max(
          0,
          Math.round((Date.parse(finishedAt) - Date.parse(createdAt)) / 1000),
        )
      : null;
  const serviceId = deployment.serviceId ?? null;
  return {
    values: {
      deployment_id: deployment.id,
      project_id: deployment.projectId,
      service_id: serviceId,
      service_name:
        serviceId !== null ? (names.services.get(serviceId) ?? null) : null,
      environment_id: deployment.environmentId,
      environment_name:
        names.environments.get(deployment.environmentId) ?? null,
      status: deployment.status,
      failed: isFailed(deployment.status),
      created_at: createdAt,
      status_updated_at: statusUpdatedAt,
      finished_at: finishedAt,
      duration_seconds: duration,
    },
  };
}
