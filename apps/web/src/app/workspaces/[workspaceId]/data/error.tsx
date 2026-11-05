"use client";
import { useT } from "@/lib/i18n/client";
export default function DataError({ reset }: { reset: () => void }) {
  const t = useT("data");
  return (
    <div className="area-page">
      <h1>{t("title")}</h1>
      <p role="alert">{t("errors.generic")}</p>
      <button type="button" onClick={reset}>
        {t("retry")}
      </button>
    </div>
  );
}
