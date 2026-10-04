import type { DashboardSlide } from "@netrics/contracts";
import { formatsNeedingAttention, type ScreenFormat } from "@netrics/domain";

import { useLocale, useT } from "@/lib/i18n/client";

/** "16x9" as people read it: "16:9". */
export function formatRatio(format: ScreenFormat): string {
  return format.replace("x", ":");
}

/**
 * "3 formats need attention" in the Studio header (ADR 0017 section 6,
 * #280): the formats in which a saved slide has a label or text cut off, a
 * header name that does not fit, or widgets to review. Nothing when every
 * format reads well. The per-format badges come with the format switcher.
 */
export function FormatAttention({
  slides,
}: {
  slides: ReadonlyArray<Pick<DashboardSlide, "formatWarnings">>;
}) {
  const t = useT("studio.readability");
  const locale = useLocale();
  const formats = formatsNeedingAttention(slides);
  if (formats.length === 0) {
    return null;
  }
  const list = new Intl.ListFormat(locale, {
    style: "long",
    type: "conjunction",
  }).format(formats.map(formatRatio));
  const detail = t("formatsAttentionTitle", { formats: list });
  return (
    <span className="studio-state studio-state--attention" title={detail}>
      <span aria-hidden="true">⚠ </span>
      {t("formatsAttention", { count: formats.length })}
      <span className="visually-hidden"> {detail}</span>
    </span>
  );
}
