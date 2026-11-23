import type {
  DatasetField,
  DatasetRecord,
  SourceDatasetDefinition,
} from "@netrics/connector-sdk";
import { z } from "zod";

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
 * Deployments, one row each (#871), updated while they change (upsert).
 * Every sync reads each selected project's deployments of the recent days
 * again: a deployment whose state changed (building → ready) is updated,
 * and one the previous sync read in those days that Vercel no longer lists
 * (deleted) is removed with a tombstone. A run publishes the dataset once,
 * whatever the number of projects (review of #889). Rows before the
 * re-read days keep the state they had when last read.
 */
export const deploymentsDataset: SourceDatasetDefinition = {
  key: "deployments",
  name: "Vercel deployments",
  version: 1,
  mode: "upsert",
  keyFields: ["deployment_id"],
  reportingField: "created_at",
  reportingTimeZone: "UTC",
  grain: "One Vercel deployment of a project",
  retentionDays: 400,
  fields: [
    field("deployment_id", "Deployment ID", "string"),
    field("project_id", "Project ID", "string"),
    field("project_name", "Project", "string"),
    field("state", "State", "string"),
    field("failed", "Failed", "boolean"),
    field("target", "Target", "string"),
    field("created_at", "Created", "timestamp"),
    field("building_at", "Build started", "timestamp", { nullable: true }),
    field("ready_at", "Ready", "timestamp", { nullable: true }),
    field("build_duration_seconds", "Build duration", "integer", {
      nullable: true,
      unit: "seconds",
    }),
    field("ready_substate", "Production traffic", "string", {
      nullable: true,
    }),
    field("source", "Source", "string", { nullable: true }),
    field("branch", "Branch", "string", { nullable: true }),
    field("url", "URL", "string", { nullable: true }),
  ],
};

/**
 * The production deployment of every selected project, as of the last sync
 * (snapshot, #871): the newest one (which may still be building, or have
 * failed) and the one serving production traffic. `state` is the status
 * widget's value (#875).
 */
export const productionDeploymentsDataset: SourceDatasetDefinition = {
  key: "production_deployments",
  name: "Vercel production deployments",
  version: 1,
  mode: "snapshot",
  keyFields: ["project_id"],
  grain: "One Vercel project, its production deployment as of the last sync",
  retentionDays: 30,
  fields: [
    field("project_id", "Project ID", "string"),
    field("project_name", "Project", "string"),
    field("web_analytics", "Web Analytics enabled", "boolean"),
    field("state", "State", "string"),
    field("latest_deployment_id", "Latest deployment ID", "string", {
      nullable: true,
    }),
    field("latest_state", "Latest deployment state", "string", {
      nullable: true,
    }),
    field("latest_created_at", "Latest deployment created", "timestamp", {
      nullable: true,
    }),
    field("latest_ready_at", "Latest deployment ready", "timestamp", {
      nullable: true,
    }),
    field("live_deployment_id", "Live deployment ID", "string", {
      nullable: true,
    }),
    field("live_created_at", "Live deployment created", "timestamp", {
      nullable: true,
    }),
    field("live_ready_at", "Live deployment ready", "timestamp", {
      nullable: true,
    }),
    field("live_url", "Live deployment URL", "string", { nullable: true }),
    field("checked_at", "Checked", "timestamp"),
  ],
};

/**
 * Billing charges of the current calendar month (UTC) per team, project
 * and product, from Vercel's FOCUS export (#871), replaced by every sync
 * that reads every team (snapshot). Charges of no single project (seats,
 * the plan) have an empty project ID.
 */
export const billingChargesDataset: SourceDatasetDefinition = {
  key: "billing_charges",
  name: "Vercel charges this month",
  version: 1,
  mode: "snapshot",
  keyFields: ["team_id", "project_id", "sku_id", "charge_category"],
  grain:
    "One Vercel product charged to a team (and project) this calendar month (UTC)",
  retentionDays: 30,
  fields: [
    field("team_id", "Team ID", "string"),
    field("team_name", "Team", "string", { nullable: true }),
    field("project_id", "Project ID", "string"),
    field("project_name", "Project", "string", { nullable: true }),
    field("sku_id", "Product ID", "string"),
    field("service_name", "Product", "string"),
    field("service_category", "Category", "string", { nullable: true }),
    field("charge_category", "Charge type", "string"),
    field("month", "Month", "date"),
    field("as_of", "As of", "timestamp"),
    field("billed_cost", "Billed cost", "decimal", {
      scale: 6,
      currencyField: "currency",
    }),
    field("effective_cost", "Effective cost", "decimal", {
      scale: 6,
      currencyField: "currency",
    }),
    field("consumed_quantity", "Consumed quantity", "number", {
      nullable: true,
    }),
    field("consumed_unit", "Consumed unit", "string", { nullable: true }),
    field("currency", "Currency", "string"),
  ],
};

export const VERCEL_DATASETS = [
  deploymentsDataset,
  productionDeploymentsDataset,
  billingChargesDataset,
] as const;

// ─── Deployments (GET /v7/deployments) ──────────────────────────────────────

/**
 * Deployment states as Vercel documents them (`readyState`). Unknown
 * states are kept as they come: a new state is not a parse failure.
 */
export const DEPLOYMENT_STATES = [
  "QUEUED",
  "INITIALIZING",
  "BUILDING",
  "READY",
  "ERROR",
  "CANCELED",
  "BLOCKED",
  "DELETED",
] as const;

const IN_PROGRESS = new Set(["QUEUED", "INITIALIZING", "BUILDING"]);

export function isInProgress(state: string): boolean {
  return IN_PROGRESS.has(state);
}

export function isFailed(state: string): boolean {
  return state === "ERROR";
}

const STRING_CAP = 500;
const capped = z
  .string()
  .transform((value) => value.slice(0, STRING_CAP))
  .nullish();

export const deploymentSchema = z
  .object({
    uid: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200).optional(),
    created: z.number().finite(),
    readyState: z.string().min(1).max(40).optional(),
    state: z.string().min(1).max(40).optional(),
    target: capped,
    buildingAt: z.number().finite().nullish(),
    ready: z.number().finite().nullish(),
    readySubstate: z.string().max(40).nullish(),
    source: capped,
    url: capped,
    meta: z.record(z.string(), z.unknown()).nullish(),
    customEnvironment: z
      .object({ slug: z.string().max(200).nullish() })
      .loose()
      .nullish(),
  })
  .loose()
  .refine((value) => value.readyState ?? value.state, {
    message: "a deployment has a state",
  });
export type VercelDeployment = z.infer<typeof deploymentSchema>;

/**
 * A page of deployments. Vercel documents `pagination` and its `next` as
 * required (`next` null on the last page): an answer without them cannot
 * say whether the list is complete, and is invalid (review of #889).
 */
export const deploymentsPageSchema = z.object({
  deployments: z.array(deploymentSchema),
  pagination: z.object({ next: z.number().finite().nullable() }).loose(),
});

export function stateOf(deployment: VercelDeployment): string {
  return (deployment.readyState ?? deployment.state)!;
}

/**
 * Where a deployment went: its custom environment's slug, else Vercel's
 * target, "preview" for none.
 */
export function targetOf(deployment: VercelDeployment): string {
  const slug = deployment.customEnvironment?.slug;
  if (slug) return slug;
  return deployment.target && deployment.target !== ""
    ? deployment.target
    : "preview";
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === "number" ? new Date(ms).toISOString() : null;
}

function branchOf(meta: VercelDeployment["meta"]): string | null {
  for (const key of [
    "githubCommitRef",
    "gitlabCommitRef",
    "bitbucketCommitRef",
  ]) {
    const value = meta?.[key];
    if (typeof value === "string" && value !== "") {
      return value.slice(0, STRING_CAP);
    }
  }
  return null;
}

export function deploymentRecord(
  deployment: VercelDeployment,
  project: { id: string; name: string },
): DatasetRecord {
  const state = stateOf(deployment);
  const buildingAt = deployment.buildingAt ?? null;
  const ready = deployment.ready ?? null;
  const duration =
    buildingAt !== null && ready !== null && ready >= buildingAt
      ? Math.round((ready - buildingAt) / 1000)
      : null;
  return {
    values: {
      deployment_id: deployment.uid,
      project_id: project.id,
      project_name: project.name,
      state,
      failed: isFailed(state),
      target: targetOf(deployment),
      created_at: iso(deployment.created),
      building_at: iso(buildingAt),
      ready_at: iso(ready),
      build_duration_seconds: duration,
      ready_substate: deployment.readySubstate ?? null,
      source: deployment.source ?? null,
      branch: branchOf(deployment.meta),
      url: deployment.url ?? null,
    },
  };
}

// ─── Production state ───────────────────────────────────────────────────────

/**
 * The state of a project's production, for status widgets:
 *
 * - "building": its newest production deployment is queued or building;
 * - "up": a production deployment serves traffic, even when a newer one
 *   failed;
 * - "failed": none serves traffic and the newest one failed;
 * - "down": none serves traffic (never deployed, canceled, blocked).
 */
export type ProductionState = "building" | "up" | "failed" | "down";

/**
 * The deployment a project's production target points at
 * (`targets.production` of GET /v9/projects/{id}): the one serving
 * production traffic, also after an instant rollback to an older one
 * (review of #889).
 */
export const liveDeploymentSchema = z
  .object({
    id: z.string().min(1).max(200),
    readyState: z.string().max(40).nullish(),
    createdAt: z.number().finite().nullish(),
    readyAt: z.number().finite().nullish(),
    url: capped,
  })
  .loose();
export type LiveDeployment = z.infer<typeof liveDeploymentSchema>;

export const projectTargetsSchema = z
  .object({
    targets: z.record(z.string(), liveDeploymentSchema.nullish()).nullish(),
  })
  .loose();

/** The newest production build, as the snapshot keeps it. */
export interface LatestDeployment {
  uid: string;
  state: string;
  created: number;
  ready: number | null;
}

export function latestOf(deployment: VercelDeployment): LatestDeployment {
  return {
    uid: deployment.uid,
    state: stateOf(deployment),
    created: deployment.created,
    ready: deployment.ready ?? null,
  };
}

/**
 * `latestState`: the newest production build's state. `liveState`: the
 * state of the deployment production points at; undefined when it points
 * at none, null when Vercel does not say (it serves, so it is ready).
 */
export function productionState(
  latestState: string | undefined,
  liveState: string | null | undefined,
): ProductionState {
  if (latestState !== undefined && isInProgress(latestState)) {
    return "building";
  }
  if (liveState !== undefined && (liveState ?? "READY") === "READY") {
    return "up";
  }
  if (latestState !== undefined && isFailed(latestState)) return "failed";
  return "down";
}

export function productionRecord(
  project: { id: string; name: string; analytics: boolean },
  latest: LatestDeployment | null,
  live: LiveDeployment | null,
  checkedAt: string,
): DatasetRecord {
  return {
    values: {
      project_id: project.id,
      project_name: project.name,
      web_analytics: project.analytics,
      state: productionState(
        latest?.state,
        live ? (live.readyState ?? null) : undefined,
      ),
      latest_deployment_id: latest?.uid ?? null,
      latest_state: latest?.state ?? null,
      latest_created_at: iso(latest?.created),
      latest_ready_at: iso(latest?.ready),
      live_deployment_id: live?.id ?? null,
      live_created_at: iso(live?.createdAt),
      live_ready_at: iso(live?.readyAt),
      live_url: live?.url ?? null,
      checked_at: checkedAt,
    },
  };
}

// ─── Billing (GET /v1/billing/charges, FOCUS 1.3 JSONL) ─────────────────────

export const chargeSchema = z
  .object({
    BilledCost: z.number().finite(),
    EffectiveCost: z.number().finite(),
    BillingCurrency: z.string().regex(/^[A-Z]{3}$/),
    ChargeCategory: z.string().min(1).max(40),
    ChargePeriodStart: z.string().min(1),
    ConsumedQuantity: z.number().finite().nullish(),
    ConsumedUnit: z.string().max(100).nullish(),
    ServiceName: z.string().min(1),
    ServiceCategory: z.string().nullish(),
    SkuId: z.string().min(1),
    SubAccountId: z.string().nullish(),
    SubAccountName: z.string().nullish(),
    Tags: z.record(z.string(), z.unknown()).nullish(),
  })
  .loose();
export type Charge = z.infer<typeof chargeSchema>;

/** A charge's project, from its tags; "" for charges of no project. */
export function chargeProject(charge: Charge): {
  id: string;
  name: string | null;
} {
  const tags = charge.Tags ?? {};
  const id = tags.ProjectId ?? tags.projectId;
  const name = tags.ProjectName ?? tags.projectName;
  return {
    id: typeof id === "string" ? id.slice(0, 200) : "",
    name: typeof name === "string" ? name.slice(0, STRING_CAP) : null,
  };
}

/** A sum of costs as a decimal string with at most six fraction digits. */
export function decimal(value: number): string {
  const fixed = value.toFixed(6);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed === "-0" || trimmed === "" ? "0" : trimmed;
}
