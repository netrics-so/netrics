"use client";
import { useId } from "react";
import type { DataField } from "@netrics/domain";
import { useT } from "@/lib/i18n/client";

/** Unit metadata is authored alongside values; money never relies on its label. */
export function ReferenceFieldOptions({
  field,
  fields,
  onChange,
  onCurrency,
  required,
}: {
  field: DataField;
  fields: DataField[];
  required: boolean;
  onChange: (patch: Partial<DataField>) => void;
  onCurrency: (id: string) => void;
}) {
  const t = useT("data"),
    id = useId();
  const exact = field.type === "decimal" || field.type === "integer";
  return (
    <details>
      <summary>{t("fieldOptions")}</summary>
      <label className="field" htmlFor={`${id}-unit`}>
        {t("unit")}
        <input
          id={`${id}-unit`}
          maxLength={100}
          value={field.unit ?? ""}
          onChange={(event) =>
            onChange({ unit: event.target.value || undefined })
          }
        />
      </label>
      <p className="help">{t("unitHint")}</p>
      {exact ? (
        <>
          <label className="field" htmlFor={`${id}-currency`}>
            {t("currencyColumn")}
            <select
              id={`${id}-currency`}
              value={field.currencyField ?? ""}
              onChange={(event) => onCurrency(event.target.value)}
            >
              <option value="">{t("noCurrencyColumn")}</option>
              {fields
                .filter(
                  (candidate) =>
                    candidate.id !== field.id && candidate.type === "string",
                )
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field" htmlFor={`${id}-scale`}>
            {t("decimalScale")}
            <input
              id={`${id}-scale`}
              type="number"
              min={0}
              max={18}
              step={1}
              value={field.scale ?? ""}
              onChange={(event) =>
                onChange({
                  scale:
                    event.target.value === ""
                      ? undefined
                      : event.target.valueAsNumber,
                })
              }
            />
          </label>
        </>
      ) : null}
      <label className="check">
        <input
          type="checkbox"
          checked={!required && field.nullable}
          disabled={required}
          onChange={(event) => onChange({ nullable: event.target.checked })}
        />
        {t("allowMissing")}
      </label>
    </details>
  );
}
