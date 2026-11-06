"use client";
import { useT } from "@/lib/i18n/client";
const labels = [
  "data_source_pending",
  "aggregate_missing_inputs",
  "decimal_rounded",
  "division_by_zero",
  "retained_source_history_incomplete",
  "model_window_history_incomplete",
  "prepared_cache_capacity_reached",
  "using_last_valid_source_snapshot",
] as const;
export function PreviewNotes({ warnings }: { warnings: string[] }) {
  const t = useT("data");
  if (!warnings.length) return null;
  return (
    <aside className="notice" aria-label={t("warnings")}>
      <ul>
        {warnings.map((warning) => {
          const key = labels.find((label) => label === warning) ?? "generic";
          return <li key={warning}>{t(`warningLabels.${key}`)}</li>;
        })}
      </ul>
    </aside>
  );
}
