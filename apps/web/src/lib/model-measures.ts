import {
  MODEL_WINDOW_LIMITS,
  type DataField,
  type ModelMeasure,
  type ModelOffsetUnit,
  type SemanticModelDefinition,
} from "@netrics/domain";

export type WindowedMeasure = Extract<
  ModelMeasure,
  { kind: "rolling" | "period_offset" }
>;
export type PeriodOffsetMeasure = Extract<
  ModelMeasure,
  { kind: "period_offset" }
>;

/** Comparison presets in the order the editor offers them. */
export const OFFSET_PRESETS = [
  { key: "previousDay", unit: "day", length: 1 },
  { key: "previousWeek", unit: "week", length: 1 },
  { key: "previousMonth", unit: "month", length: 1 },
  { key: "lastYear", unit: "year", length: 1 },
  { key: "previousPeriod", unit: "range", length: 1 },
] as const satisfies readonly {
  key: string;
  unit: ModelOffsetUnit;
  length: number;
}[];
export type OffsetPreset = (typeof OFFSET_PRESETS)[number]["key"];

export function offsetPreset(offset: {
  unit: ModelOffsetUnit;
  length: number;
}): OffsetPreset | null {
  return (
    OFFSET_PRESETS.find(
      (preset) =>
        preset.unit === offset.unit && preset.length === offset.length,
    )?.key ?? null
  );
}

export function windowLengthMax(unit: keyof typeof MODEL_WINDOW_LIMITS) {
  return MODEL_WINDOW_LIMITS[unit];
}

export function isWindowedMeasure(
  measure: ModelMeasure,
): measure is WindowedMeasure {
  return measure.kind === "rolling" || measure.kind === "period_offset";
}

/** Date dimensions on provider reporting dates; timestamps cannot anchor windows. */
export function timeDimensionCandidates(
  definition: SemanticModelDefinition,
  fieldsFor: (datasetId: string) => DataField[],
) {
  return definition.dimensions.filter(
    (dimension) =>
      dimension.timeAlignment === "reporting_date" &&
      fieldsFor(dimension.datasetId).find((f) => f.id === dimension.fieldId)
        ?.type === "date",
  );
}

/** Measures that reference `id` as the base of a rolling or offset measure. */
export function measureDependents(
  definition: SemanticModelDefinition,
  id: string,
) {
  return definition.measures.filter(
    (measure) => isWindowedMeasure(measure) && measure.baseMeasureId === id,
  );
}

function dependsOn(
  definition: SemanticModelDefinition,
  measure: ModelMeasure,
  id: string,
  seen = new Set<string>(),
): boolean {
  if (!isWindowedMeasure(measure) || seen.has(measure.id)) return false;
  seen.add(measure.id);
  if (measure.baseMeasureId === id) return true;
  const base = definition.measures.find((m) => m.id === measure.baseMeasureId);
  return !!base && dependsOn(definition, base, id, seen);
}

/** Rolling re-aggregates rows, so only aggregates qualify; offsets take any
 * measure that would not loop back through its own base chain. */
export function windowBaseCandidates(
  definition: SemanticModelDefinition,
  measure: WindowedMeasure,
) {
  return definition.measures.filter(
    (candidate) =>
      candidate.id !== measure.id &&
      (measure.kind === "rolling"
        ? candidate.kind === "aggregate"
        : !dependsOn(definition, candidate, measure.id)),
  );
}

/** Replaces a measure's calculation with a windowed one, keeping its identity. */
export function toWindowedMeasure(
  measure: ModelMeasure,
  kind: WindowedMeasure["kind"],
  definition: SemanticModelDefinition,
  fieldsFor: (datasetId: string) => DataField[],
): WindowedMeasure {
  const common = {
    id: measure.id,
    name: measure.name,
    requiredDimensions: measure.requiredDimensions,
    baseMeasureId: isWindowedMeasure(measure) ? measure.baseMeasureId : "",
    timeDimensionId:
      (isWindowedMeasure(measure) ? measure.timeDimensionId : "") ||
      (timeDimensionCandidates(definition, fieldsFor)[0]?.id ?? ""),
  };
  const draft: WindowedMeasure =
    kind === "rolling"
      ? { ...common, kind, window: { unit: "day", length: 7 } }
      : {
          ...common,
          kind,
          offset: { unit: "range", length: 1 },
          output: "value",
        };
  const candidates = windowBaseCandidates(definition, draft);
  if (!candidates.some((c) => c.id === draft.baseMeasureId))
    draft.baseMeasureId = candidates[0]?.id ?? "";
  return draft;
}

/** Change and percent-change siblings of a comparison that do not exist yet. */
export function changeMeasureSiblings(
  definition: SemanticModelDefinition,
  measure: PeriodOffsetMeasure,
  names: { change: string; percent_change: string },
  newId: () => string,
): PeriodOffsetMeasure[] {
  return (["change", "percent_change"] as const)
    .filter(
      (output) =>
        output !== measure.output &&
        !definition.measures.some(
          (m) =>
            m.kind === "period_offset" &&
            m.baseMeasureId === measure.baseMeasureId &&
            m.timeDimensionId === measure.timeDimensionId &&
            m.offset.unit === measure.offset.unit &&
            m.offset.length === measure.offset.length &&
            m.output === output,
        ),
    )
    .map((output) => ({
      id: newId(),
      name: names[output].slice(0, 100),
      kind: "period_offset",
      baseMeasureId: measure.baseMeasureId,
      timeDimensionId: measure.timeDimensionId,
      offset: { ...measure.offset },
      output,
      ...(measure.requiredDimensions?.length
        ? { requiredDimensions: [...measure.requiredDimensions] }
        : {}),
    }));
}
