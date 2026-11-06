import { z } from "zod";
import {
  DATASET_LIMITS,
  datasetRetentionDays,
  type SourceDatasetDefinition,
} from "@netrics/connector-sdk";

/**
 * Per-connection dataset retention (#492). A connection chooses how long
 * each of its datasets is kept; the workspace maximum (`maxRetentionDays`)
 * still caps every choice and the shortest finite period wins.
 */

/** Datasets with personal fields start with this period on new connections. */
export const PERSONAL_DATA_RETENTION_PRESET_DAYS = 90;

const datasetKeySchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/);

/** Days to keep data after collection, or null to keep it until deleted. */
export const retentionDaysSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();

/** Dataset key → days (null: until deleted). */
export const connectionRetentionChoiceSchema = z
  .record(datasetKeySchema, retentionDaysSchema)
  .refine((choice) => Object.keys(choice).length <= DATASET_LIMITS.datasets, {
    message: "Too many datasets",
  });
export type ConnectionRetentionChoice = z.infer<
  typeof connectionRetentionChoiceSchema
>;

/** How datasets without an explicit choice are kept. */
export const connectionRetentionFallbackSchema = z.enum([
  "preset",
  "connector",
]);
export type ConnectionRetentionFallback = z.infer<
  typeof connectionRetentionFallbackSchema
>;

/**
 * preset: nobody has chosen yet, the presets apply; chosen: a person saved
 * the retention; migrated: recorded from the retention a connection had
 * before per-connection retention existed.
 */
export const connectionRetentionBasisSchema = z.enum([
  "preset",
  "chosen",
  "migrated",
]);
export type ConnectionRetentionBasis = z.infer<
  typeof connectionRetentionBasisSchema
>;

export function datasetHasPersonalFields(
  definition: Pick<SourceDatasetDefinition, "fields">,
): boolean {
  return definition.fields.some((field) => field.classification === "personal");
}

function shorter(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * The period a new connection starts with: 90 days for a dataset with
 * personal fields (or the connector's shorter declaration), else the
 * connector's declared retention.
 */
export function presetRetentionDays(
  definition: SourceDatasetDefinition,
): number | null {
  const declared = datasetRetentionDays(definition);
  return datasetHasPersonalFields(definition)
    ? shorter(declared, PERSONAL_DATA_RETENTION_PRESET_DAYS)
    : declared;
}

export interface ConnectionRetentionSetting {
  choice: ConnectionRetentionChoice;
  fallback: ConnectionRetentionFallback;
}

/**
 * The retention a connection asks for one dataset, before the workspace
 * maximum: its explicit choice, else the fallback rule.
 */
export function chosenRetentionDays(
  definition: SourceDatasetDefinition,
  setting: ConnectionRetentionSetting,
): { days: number | null; source: "chosen" | "preset" | "connector" } {
  if (Object.hasOwn(setting.choice, definition.key))
    return { days: setting.choice[definition.key] ?? null, source: "chosen" };
  return setting.fallback === "connector"
    ? { days: datasetRetentionDays(definition), source: "connector" }
    : { days: presetRetentionDays(definition), source: "preset" };
}

/** The shortest finite of the connection's period and the workspace maximum. */
export function effectiveRetentionDays(
  days: number | null,
  workspaceMaxDays: number | null,
): number | null {
  return shorter(days, workspaceMaxDays);
}

/** A connector dataset as setup shows it, before a connection exists. */
export const connectorDatasetRetentionSchema = z.object({
  key: datasetKeySchema,
  name: z.string().min(1),
  /** Has personal-classified fields. */
  personal: z.boolean(),
  /** The connector's declared retention (shortest dataset/field period). */
  connectorDefaultDays: retentionDaysSchema,
  /** What a new connection starts with. */
  presetDays: retentionDaysSchema,
});
export type ConnectorDatasetRetention = z.infer<
  typeof connectorDatasetRetentionSchema
>;

export function connectorDatasetRetention(
  definition: SourceDatasetDefinition,
): ConnectorDatasetRetention {
  return {
    key: definition.key,
    name: definition.name,
    personal: datasetHasPersonalFields(definition),
    connectorDefaultDays: datasetRetentionDays(definition),
    presetDays: presetRetentionDays(definition),
  };
}

export const connectionDatasetRetentionSchema =
  connectorDatasetRetentionSchema.extend({
    /** What the connection asks for, before the workspace maximum. */
    days: retentionDaysSchema,
    source: z.enum(["chosen", "preset", "connector"]),
    /** What applies: the shorter of `days` and the workspace maximum. */
    effectiveDays: retentionDaysSchema,
    cappedByWorkspace: z.boolean(),
  });
export type ConnectionDatasetRetention = z.infer<
  typeof connectionDatasetRetentionSchema
>;

export const connectionRetentionSchema = z.object({
  datasets: z.array(connectionDatasetRetentionSchema),
  /** The workspace maximum; null when the workspace sets none. */
  workspaceMaxDays: retentionDaysSchema,
  basis: connectionRetentionBasisSchema,
  /** When the retention was chosen or recorded; null while it is the preset. */
  chosenAt: z.iso.datetime().nullable(),
  /** Who chose it; null for presets, migrated records and deleted users. */
  chosenBy: z.object({ id: z.uuid(), name: z.string().min(1) }).nullable(),
});
export type ConnectionRetention = z.infer<typeof connectionRetentionSchema>;

export const connectionRetentionResponseSchema = z.object({
  retention: connectionRetentionSchema,
});
export type ConnectionRetentionResponse = z.infer<
  typeof connectionRetentionResponseSchema
>;

/**
 * Replaces the connection's choice. Datasets left out follow the preset (or,
 * for connections migrated from before #492, the connector default).
 */
export const updateConnectionRetentionRequestSchema = z.object({
  datasets: connectionRetentionChoiceSchema,
});
export type UpdateConnectionRetentionRequest = z.infer<
  typeof updateConnectionRetentionRequestSchema
>;
