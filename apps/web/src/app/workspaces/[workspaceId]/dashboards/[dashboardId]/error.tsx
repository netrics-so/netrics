"use client";

import Link from "next/link";

import { useT } from "@/lib/i18n/client";

/** A failed page load; individual tiles handle their own errors. */
export default function DashboardError({ reset }: { reset: () => void }) {
  const t = useT("dashboard");
  const common = useT("common");
  return (
    <div className="dashboard-page">
      <div className="error" role="alert">
        {t("loadFailed")}{" "}
        <button type="button" onClick={reset}>
          {common("retry")}
        </button>
      </div>
      <p className="muted">
        <Link href="/">{t("backToWorkspaces")}</Link>
      </p>
    </div>
  );
}
