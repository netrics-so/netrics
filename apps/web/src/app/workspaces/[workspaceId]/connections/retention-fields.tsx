"use client";

import type { ConnectorDatasetRetention } from "@netrics/contracts";

import { useT } from "@/lib/i18n/client";

/** Dataset key → days, or null to keep until deleted (#492). */
export type RetentionValues = Record<string, number | null>;

/** The values a new connection starts with: the presets. */
export function presetRetentionValues(
  datasets: readonly ConnectorDatasetRetention[],
): RetentionValues {
  return Object.fromEntries(datasets.map((d) => [d.key, d.presetDays]));
}

/** Whether any dataset would be kept for less time than before. */
export function shortensRetention(
  before: RetentionValues,
  after: RetentionValues,
): boolean {
  return Object.entries(after).some(([key, days]) => {
    const previous = before[key];
    return (
      previous !== undefined &&
      days !== null &&
      (previous === null || days < previous)
    );
  });
}

interface RetentionFieldsProps {
  datasets: readonly ConnectorDatasetRetention[];
  values: RetentionValues;
  onChange: (values: RetentionValues) => void;
  /** The workspace maximum, if any: it caps every value. */
  workspaceMaxDays?: number | null;
  disabled?: boolean;
  idPrefix: string;
}

/**
 * One "Keep data / Days" choice per dataset of a connection, as in the
 * reference-table editor. The workspace maximum still applies on top.
 */
export function RetentionFields({
  datasets,
  values,
  onChange,
  workspaceMaxDays = null,
  disabled = false,
  idPrefix,
}: RetentionFieldsProps) {
  const t = useT("connections.retention");
  return (
    <div className="stack">
      {datasets.map((dataset) => {
        const value = values[dataset.key] ?? null;
        const forever = value === null;
        const id = `${idPrefix}-${dataset.key}`;
        const capped =
          workspaceMaxDays !== null &&
          (value === null || value > workspaceMaxDays);
        return (
          <fieldset key={dataset.key} className="stack retention-dataset">
            <legend>
              <strong>{dataset.name}</strong>
              {dataset.personal ? (
                <>
                  {" "}
                  <span className="muted">· {t("personal")}</span>
                </>
              ) : null}
            </legend>
            <div className="retention-dataset-fields">
              <label className="field" htmlFor={`${id}-mode`}>
                {t("keepData")}
                <select
                  id={`${id}-mode`}
                  value={forever ? "forever" : "days"}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({
                      ...values,
                      [dataset.key]:
                        event.target.value === "forever"
                          ? null
                          : (dataset.presetDays ??
                            dataset.connectorDefaultDays ??
                            90),
                    })
                  }
                >
                  <option value="days">{t("days")}</option>
                  <option value="forever">{t("forever")}</option>
                </select>
              </label>
              {forever ? null : (
                <label className="field" htmlFor={`${id}-days`}>
                  {t("daysLabel")}
                  <input
                    id={`${id}-days`}
                    type="number"
                    min={1}
                    step={1}
                    required
                    value={value}
                    disabled={disabled}
                    onChange={(event) => {
                      const days = Math.floor(Number(event.target.value));
                      onChange({
                        ...values,
                        [dataset.key]:
                          Number.isFinite(days) && days > 0 ? days : 1,
                      });
                    }}
                  />
                </label>
              )}
            </div>
            <p className="page-meta">
              {dataset.personal && dataset.presetDays !== null
                ? t("personalPreset", { days: dataset.presetDays })
                : dataset.connectorDefaultDays === null
                  ? t("connectorDefaultForever")
                  : t("connectorDefault", {
                      days: dataset.connectorDefaultDays,
                    })}
              {capped ? (
                <> {t("cappedByWorkspace", { days: workspaceMaxDays })}</>
              ) : null}
            </p>
          </fieldset>
        );
      })}
    </div>
  );
}
