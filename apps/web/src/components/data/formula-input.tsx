"use client";
import { formatDataFormula, type DataField } from "@netrics/domain";
import { useT } from "@/lib/i18n/client";

/** The formula textarea with its help text and "Insert a column" buttons. */
export function FormulaInput({
  id,
  value,
  fields,
  onChange,
  describedBy,
}: {
  id: string;
  value: string;
  fields: readonly DataField[];
  onChange: (text: string) => void;
  describedBy?: string;
}) {
  const t = useT("data");
  return (
    <>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        rows={3}
        maxLength={10000}
        placeholder={t("formulaPlaceholder")}
        aria-describedby={[describedBy, id + "-help"].filter(Boolean).join(" ")}
      />
      <p id={id + "-help"} className="help">
        {t("formulaHelp")}
      </p>
      <div className="data-reference-buttons" aria-label={t("insertColumn")}>
        {fields.map((f) => (
          <button
            type="button"
            key={f.id}
            onClick={() =>
              onChange(
                value +
                  formatDataFormula({ kind: "field", fieldId: f.id }, fields),
              )
            }
          >
            {f.name}
          </button>
        ))}
      </div>
    </>
  );
}
