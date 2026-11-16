"use client";

import { useLocale, useT } from "@/lib/i18n/client";
import { useViewerTimeZone } from "@/lib/viewer-time-zone";

/**
 * "Checked at …": when the server checked, in the viewer's zone (#749),
 * not the server's. The server page passes the instant.
 */
export function RenderedAt({ at }: { at: string }) {
  const t = useT("statusPage");
  const locale = useLocale();
  const timeZone = useViewerTimeZone();
  return (
    <p className="meta">
      {t("renderedAt", {
        time: new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "medium",
          timeZone,
        }).format(new Date(at)),
      })}
    </p>
  );
}
