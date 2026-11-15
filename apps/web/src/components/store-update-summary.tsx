"use client";

import type { StoreTemplateUpdateSummary } from "@netrics/contracts";

import { useT } from "@/lib/i18n/client";
import { summaryParts } from "@/lib/store-updates";

/**
 * What a store-template update changes (11E), in one line: "2 measures
 * changed, 1 added · 3 steps changed · 1 widget removed", then how many
 * items wait for the customer's choice.
 */
export function StoreUpdateSummary({
  summary,
}: {
  summary: StoreTemplateUpdateSummary;
}) {
  const t = useT("storeUpdate");
  const kinds = summaryParts(summary).map(({ kind, parts }) =>
    parts
      .map(([change, count], index) =>
        index === 0
          ? t(`summary.${kind}.${change}`, { count })
          : t(`summary.${change}`, { count }),
      )
      .join(", "),
  );
  const asked = [
    ...(summary.conflicts > 0
      ? [t("summary.conflicts", { count: summary.conflicts })]
      : []),
    ...(summary.removals > 0
      ? [t("summary.removals", { count: summary.removals })]
      : []),
  ];
  const text = [...kinds, ...asked].join(" · ");
  return (
    <span className="store-update-summary">{text || t("summary.none")}</span>
  );
}
