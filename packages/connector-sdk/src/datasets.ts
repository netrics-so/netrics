import { z } from "zod";
import { utf8ByteLength } from "./utf8.js";

/** Bounded portable dataset transport. No source values appear in errors. */
export const DATASET_LIMITS = {
  fields: 100,
  datasets: 20,
  pageRows: 1_000,
  pageBytes: 1_048_576,
  rowBytes: 65_536,
  keyBytes: 1_024,
  previewRows: 100,
  retentionDays: 30,
} as const;

const id = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,99}$/)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
  );
export const datasetFieldTypeSchema = z.enum([
  "string",
  "boolean",
  "integer",
  "number",
  "decimal",
  "date",
  "timestamp",
  "json",
]);
export const datasetFieldSchema = z.strictObject({
  id,
  name: z.string().min(1).max(100),
  type: datasetFieldTypeSchema,
  nullable: z.boolean(),
  classification: z.enum(["public", "internal", "personal"]),
  /** null explicitly keeps data until deleted; omitted inherits dataset retention. */
  retentionDays: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  unit: z.string().min(1).max(100).optional(),
  currencyField: id.optional(),
  scale: z.number().int().min(0).max(18).optional(),
});
export const sourceDatasetSchema = z
  .strictObject({
    key: id,
    name: z.string().min(1).max(100),
    version: z.number().int().positive(),
    fields: z.array(datasetFieldSchema).min(1).max(DATASET_LIMITS.fields),
    keyFields: z.array(id).min(1).max(10),
    grain: z.string().min(1).max(300),
    mode: z.enum(["upsert", "append", "replace_window", "snapshot"]),
    reportingField: id.optional(),
    reportingTimeZone: z.string().min(1).max(100).optional(),
    retentionDays: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .default(DATASET_LIMITS.retentionDays),
  })
  .superRefine((schema, ctx) => {
    const fields = new Map(schema.fields.map((f) => [f.id, f]));
    const problem = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (fields.size !== schema.fields.length)
      problem("Field IDs must be unique");
    if (new Set(schema.keyFields).size !== schema.keyFields.length)
      problem("Key fields must be unique");
    for (const key of schema.keyFields) {
      const field = fields.get(key);
      if (!field || field.nullable || field.type === "json")
        problem("Keys require non-null scalar fields");
    }
    if (schema.reportingField) {
      const field = fields.get(schema.reportingField);
      if (
        !field ||
        field.nullable ||
        !["date", "timestamp"].includes(field.type)
      )
        problem("Reporting field must be a non-null date or timestamp");
    }
    if (schema.mode === "replace_window" && !schema.reportingField)
      problem("Window replacement requires a reporting field");
    if (schema.reportingTimeZone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: schema.reportingTimeZone });
      } catch {
        problem("Invalid reporting timezone");
      }
    }
    for (const field of schema.fields) {
      if (
        field.currencyField ||
        field.unit === "currency" ||
        field.unit === "currency_minor"
      ) {
        const currency = fields.get(field.currencyField ?? "");
        if (
          !["decimal", "integer"].includes(field.type) ||
          !currency ||
          currency.type !== "string" ||
          currency.nullable
        )
          problem(
            "Money requires exact numeric values and a non-null currency field",
          );
      }
      if (
        field.scale !== undefined &&
        !["decimal", "integer"].includes(field.type)
      )
        problem("Scale requires an exact numeric field");
      if (
        field.classification === "personal" &&
        field.retentionDays === undefined
      )
        problem("Personal fields require an explicit retention policy");
    }
  });
export type SourceDatasetDefinition = z.infer<typeof sourceDatasetSchema>;
export type DatasetField = z.infer<typeof datasetFieldSchema>;
export type DatasetRecord = {
  values: Record<string, unknown>;
  deleted?: boolean;
};
/**
 * Bounded JSON data: at most 10,000 nodes, nesting depth 8, finite numbers,
 * plain objects and arrays (own enumerable members). Recursive, so that a
 * value allocates nothing: the depth bound keeps the recursion shallow (#528).
 */
function isDataJson(value: unknown): boolean {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 8) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (
      typeof item !== "object" ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      return false;
    const object = item as Record<string, unknown>;
    for (const key in object)
      if (Object.hasOwn(object, key) && !visit(object[key], depth + 1))
        return false;
    return true;
  };
  return visit(value, 0);
}
const jsonValue = z
  .unknown()
  .refine(isDataJson, { message: "Expected bounded JSON data" });
export const datasetRecordSchema = z.strictObject({
  values: z.record(z.string(), jsonValue),
  deleted: z.boolean().optional(),
});
export const datasetPageSchema = z
  .strictObject({
    datasetKey: id,
    schemaVersion: z.number().int().positive(),
    /** Stable across retries, scoped to the connection and dataset. */
    refreshKey: z.string().min(1).max(200),
    pageKey: z.string().min(1).max(200),
    previousPageKey: z.string().min(1).max(200).nullable(),
    /** Host verifies this identity and preserves its original retention deadline. */
    stagingId: z.uuid().optional(),
    stagingPageKey: z.string().min(1).max(200).optional(),
    records: z.array(datasetRecordSchema).max(DATASET_LIMITS.pageRows),
    complete: z.boolean(),
    /** Half-open reporting interval; partition predicates narrow replacement. */
    window: z
      .strictObject({
        from: z.string().min(1).max(40),
        toExclusive: z.string().min(1).max(40),
        partition: z
          .record(id, z.union([z.string(), z.number().finite(), z.boolean()]))
          .default({}),
      })
      .optional(),
  })
  .refine(
    (page) =>
      (page.stagingId === undefined) === (page.stagingPageKey === undefined),
    { message: "Staged pages require both a stage identity and page key" },
  );
export type DatasetPage = z.infer<typeof datasetPageSchema>;

export function datasetRetentionDays(
  schema: SourceDatasetDefinition,
): number | null {
  const finite = [
    schema.retentionDays,
    ...schema.fields.map((f) => f.retentionDays),
  ].filter((value): value is number => typeof value === "number");
  return finite.length ? Math.min(...finite) : null;
}

const decimal = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
// Built once: a zod schema per validated value was most of the validation's
// garbage (#528).
const isoDate = z.iso.date();
const isoTimestamp = z.iso.datetime({ offset: false });

function validValue(field: DatasetField, value: unknown): boolean {
  if (value === null) return field.nullable;
  switch (field.type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "decimal":
      return (
        typeof value === "string" &&
        decimal.test(value) &&
        value.replace(/[-.]/g, "").length <= 38 &&
        (value.split(".")[1]?.length ?? 0) <= (field.scale ?? 18)
      );
    case "date":
      return typeof value === "string" && isoDate.safeParse(value).success;
    case "timestamp":
      return (
        typeof value === "string" &&
        isoTimestamp.safeParse(value).success &&
        (value.match(/\.([0-9]+)Z$/)?.[1]?.length ?? 0) <= 9
      );
    case "json":
      return isDataJson(value);
  }
}

/** Throws only structural diagnostics; raw values must never enter logs. */
export function validateDatasetPage(
  schema: SourceDatasetDefinition,
  input: unknown,
): DatasetPage {
  const parsed = datasetPageSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid dataset page structure");
  const page = parsed.data;
  if (page.datasetKey !== schema.key || page.schemaVersion !== schema.version)
    throw new Error("Dataset schema identity mismatch");
  if (utf8ByteLength(JSON.stringify(page)) > DATASET_LIMITS.pageBytes)
    throw new Error("Dataset page exceeds byte limit");
  const fields = new Map(schema.fields.map((f) => [f.id, f]));
  if ((schema.mode === "replace_window") !== (page.window !== undefined))
    throw new Error("Dataset replacement window mismatch");
  if (page.window) {
    const field = fields.get(schema.reportingField!)!;
    if (
      !validValue(field, page.window.from) ||
      !validValue(field, page.window.toExclusive) ||
      (field.type === "timestamp"
        ? datasetTimeKey(page.window.from) >=
          datasetTimeKey(page.window.toExclusive)
        : page.window.from >= page.window.toExclusive)
    )
      throw new Error("Invalid dataset replacement window");
    for (const [key, value] of Object.entries(page.window.partition)) {
      const part = fields.get(key);
      if (
        !part ||
        key === schema.reportingField ||
        !validValue(part, value) ||
        part.type === "json"
      )
        throw new Error("Invalid dataset partition");
    }
  }
  for (const row of page.records) {
    if (utf8ByteLength(JSON.stringify(row)) > DATASET_LIMITS.rowBytes)
      throw new Error("Dataset row exceeds byte limit");
    const keys = Object.keys(row.values);
    const expected = row.deleted
      ? schema.keyFields
      : schema.fields.map((f) => f.id);
    if (
      keys.length !== expected.length ||
      expected.some((key) => !Object.hasOwn(row.values, key)) ||
      keys.some((key) => !fields.has(key))
    )
      throw new Error("Dataset row fields do not match schema");
    if (
      utf8ByteLength(datasetRecordKey(schema, row.values)) >
      DATASET_LIMITS.keyBytes
    )
      throw new Error("Dataset key exceeds byte limit");
    for (const key of keys)
      if (!validValue(fields.get(key)!, row.values[key]))
        throw new Error(`Invalid dataset field type: ${key}`);
    if (row.deleted && schema.mode !== "upsert")
      throw new Error("Only upsert datasets can send tombstones");
    if (!row.deleted)
      for (const field of schema.fields) {
        if (
          field.currencyField &&
          !/^[A-Z]{3}$/.test(String(row.values[field.currencyField]))
        )
          throw new Error("Invalid currency field");
      }
    if (page.window && !row.deleted) {
      const time = row.values[schema.reportingField!] as string;
      const instant = fields.get(schema.reportingField!)!.type === "timestamp";
      if (
        (instant
          ? datasetTimeKey(time) < datasetTimeKey(page.window.from)
          : time < page.window.from) ||
        (instant
          ? datasetTimeKey(time) >= datasetTimeKey(page.window.toExclusive)
          : time >= page.window.toExclusive) ||
        !datasetPartitionMatches(schema, row.values, page.window.partition)
      )
        throw new Error("Record outside replacement window");
    }
  }
  return page;
}

/** Exact typed provider key; independent of field labels or object key order. */
export function datasetRecordKey(
  schema: SourceDatasetDefinition,
  values: Record<string, unknown>,
): string {
  return JSON.stringify(
    schema.keyFields.map((key) => {
      let value = values[key];
      if (
        schema.fields.find((field) => field.id === key)?.type === "decimal" &&
        typeof value === "string"
      ) {
        value = value.includes(".")
          ? value.replace(/0+$/, "").replace(/\.$/, "")
          : value;
        if (value === "-0") value = "0";
      }
      if (
        schema.fields.find((field) => field.id === key)?.type === "timestamp" &&
        typeof value === "string"
      )
        value = datasetTimeKey(value);
      return [key, value];
    }),
  );
}

export function datasetPartitionMatches(
  schema: SourceDatasetDefinition,
  values: Record<string, unknown>,
  partition: Record<string, unknown>,
): boolean {
  return Object.entries(partition).every(
    ([key, value]) =>
      datasetRecordKey({ ...schema, keyFields: [key] }, values) ===
      datasetRecordKey({ ...schema, keyFields: [key] }, { [key]: value }),
  );
}

/** Canonical UTC instants with up to nanosecond precision; never truncate source keys. */
export function datasetTimeKey(value: string): string {
  return value.replace(
    /(?:\.([0-9]+))?Z$/,
    (_match, fraction: string | undefined) =>
      "." + (fraction ?? "").padEnd(9, "0") + "Z",
  );
}
