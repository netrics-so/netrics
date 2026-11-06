"use client";
import { useId } from "react";
import type { DataField, AggregateDefinition } from "@netrics/domain";
import { useT } from "@/lib/i18n/client";
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
