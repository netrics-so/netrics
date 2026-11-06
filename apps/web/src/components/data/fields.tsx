"use client";
import { useId, useState } from "react";
import type {
  DataField,
  AggregateDefinition,
  ModelDimension,
  ModelMeasure,
  ModelWindowUnit,
} from "@netrics/domain";
import { useT } from "@/lib/i18n/client";
import {
  OFFSET_PRESETS,
  offsetPreset,
  windowLengthMax,
  type WindowedMeasure,
} from "@/lib/model-measures";
export function ColumnSelect({
  label,
  fields,
  value,
  onChange,
  empty = false,
  disabled = false,
}: {
  label: string;
  fields: DataField[];
  value: string;
  onChange: (value: string) => void;
  empty?: boolean;
  disabled?: boolean;
}) {
  const id = useId(),
    t = useT("data");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={!empty}
      >
        <option value="">{t("choose")}</option>
        {fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </div>
  );
}
export function ColumnChecks({
  label,
  fields,
  value,
  onChange,
}: {
  label: string;
  fields: DataField[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="data-checks">
      <legend>{label}</legend>
      {fields.map((field) => (
        <label key={field.id} className="check">
          <input
            type="checkbox"
            checked={value.includes(field.id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...value, field.id]
                  : value.filter((id) => id !== field.id),
              )
            }
          />
          {field.name}
        </label>
      ))}
    </fieldset>
  );
}
export function AggregateFields({
  fields,
  value,
  onChange,
  showName = true,
}: {
  fields: DataField[];
  value: AggregateDefinition;
  onChange: (next: AggregateDefinition) => void;
  showName?: boolean;
}) {
  const t = useT("data"),
    opId = useId(),
    nameId = useId();
  const operations = [
    "sum",
    "count",
    "distinct_count",
    "avg",
    "min",
    "max",
    "last",
    "any",
    "all",
  ] as const;
  return (
    <div className="data-form-grid">
      {showName ? (
        <div className="field">
          <label htmlFor={nameId}>{t("aggregateName")}</label>
          <input
            id={nameId}
            required
            maxLength={100}
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={opId}>{t("aggregate")}</label>
        <select
          id={opId}
          value={value.op}
          onChange={(e) =>
            onChange({
              ...value,
              op: e.target.value as AggregateDefinition["op"],
            })
          }
        >
          {operations.map((op) => (
            <option key={op} value={op}>
              {t(op === "last" ? "lastAggregate" : op)}
            </option>
          ))}
        </select>
      </div>
      <ColumnSelect
        label={t("field")}
        fields={fields}
        value={value.fieldId ?? ""}
        empty={value.op === "count"}
        onChange={(fieldId) =>
          onChange({ ...value, fieldId: fieldId || undefined })
        }
      />
      {value.op === "last" ? (
        <ColumnSelect
          label={t("orderBy")}
          fields={fields.filter(
            (f) => f.type === "date" || f.type === "timestamp",
          )}
          value={value.orderBy ?? ""}
          onChange={(orderBy) => onChange({ ...value, orderBy })}
        />
      ) : null}
    </div>
  );
}
export function WindowedMeasureFields({
  measure,
  baseMeasures,
  timeDimensions,
  onChange,
}: {
  measure: WindowedMeasure;
  baseMeasures: ModelMeasure[];
  timeDimensions: ModelDimension[];
  onChange: (next: WindowedMeasure) => void;
}) {
  const t = useT("data"),
    baseId = useId(),
    timeId = useId(),
    presetId = useId(),
    unitId = useId(),
    lengthId = useId(),
    outputId = useId();
  const preset =
    measure.kind === "period_offset" ? offsetPreset(measure.offset) : null;
  const [customOffset, setCustomOffset] = useState(false);
  const custom = measure.kind === "period_offset" && (customOffset || !preset);
  const span = measure.kind === "rolling" ? measure.window : measure.offset;
  const setSpan = (unit: ModelWindowUnit, length: number) => {
    const next = { unit, length: Math.min(length, windowLengthMax(unit)) };
    onChange(
      measure.kind === "rolling"
        ? { ...measure, window: next }
        : { ...measure, offset: next },
    );
  };
  return (
    <div className="data-form-grid">
      <div className="field">
        <label htmlFor={baseId}>{t("baseMeasure")}</label>
        <select
          id={baseId}
          required
          value={measure.baseMeasureId}
          onChange={(e) =>
            onChange({ ...measure, baseMeasureId: e.target.value })
          }
          aria-describedby={baseId + "-help"}
        >
          <option value="">{t("choose")}</option>
          {baseMeasures.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <p className="help" id={baseId + "-help"}>
          {t(measure.kind === "rolling" ? "rollingHelp" : "offsetHelp")}
        </p>
      </div>
      <div className="field">
        <label htmlFor={timeId}>{t("timeDimension")}</label>
        <select
          id={timeId}
          required
          value={measure.timeDimensionId}
          onChange={(e) =>
            onChange({ ...measure, timeDimensionId: e.target.value })
          }
          aria-describedby={timeId + "-help"}
        >
          <option value="">{t("choose")}</option>
          {timeDimensions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <p className="help" id={timeId + "-help"}>
          {t(timeDimensions.length ? "timeDimensionHelp" : "noTimeDimension")}
        </p>
      </div>
      {measure.kind === "period_offset" ? (
        <div className="field">
          <label htmlFor={presetId}>{t("compareWith")}</label>
          <select
            id={presetId}
            value={custom ? "custom" : (preset ?? "custom")}
            onChange={(e) => {
              const next = OFFSET_PRESETS.find((p) => p.key === e.target.value);
              setCustomOffset(!next);
              if (next)
                onChange({
                  ...measure,
                  offset: { unit: next.unit, length: next.length },
                });
              else if (
                measure.offset.unit === "year" ||
                measure.offset.unit === "range"
              )
                onChange({ ...measure, offset: { unit: "day", length: 1 } });
            }}
          >
            {OFFSET_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {t(`offsetPresets.${p.key}`)}
              </option>
            ))}
            <option value="custom">{t("offsetPresets.custom")}</option>
          </select>
        </div>
      ) : null}
      {measure.kind === "rolling" || custom ? (
        <>
          <div className="field">
            <label htmlFor={lengthId}>
              {t(measure.kind === "rolling" ? "windowLength" : "offsetLength")}
            </label>
            <input
              id={lengthId}
              type="number"
              inputMode="numeric"
              required
              min={1}
              max={windowLengthMax(span.unit)}
              step={1}
              value={span.length}
              onChange={(e) =>
                setSpan(
                  span.unit as ModelWindowUnit,
                  Math.max(1, Math.trunc(Number(e.target.value)) || 1),
                )
              }
            />
          </div>
          <div className="field">
            <label htmlFor={unitId}>{t("windowUnit")}</label>
            <select
              id={unitId}
              value={span.unit}
              onChange={(e) =>
                setSpan(e.target.value as ModelWindowUnit, span.length)
              }
            >
              {(["day", "week", "month"] as const).map((unit) => (
                <option key={unit} value={unit}>
                  {t(`windowUnits.${unit}`, { count: span.length })}
                </option>
              ))}
            </select>
          </div>
        </>
      ) : null}
      {measure.kind === "period_offset" ? (
        <div className="field">
          <label htmlFor={outputId}>{t("offsetOutput")}</label>
          <select
            id={outputId}
            value={measure.output}
            onChange={(e) =>
              onChange({
                ...measure,
                output: e.target.value as typeof measure.output,
              })
            }
          >
            {(["value", "change", "percent_change"] as const).map((output) => (
              <option key={output} value={output}>
                {t(`offsetOutputs.${output}`)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}
