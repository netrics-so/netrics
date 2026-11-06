"use client";

import Link from "next/link";

import { useT } from "@/lib/i18n/client";

/**
 * Step 3, "Show it on a screen" (#308): how pairing works, then "Connect a
 * TV" (the approval page that takes the TV's code) and the way into the
 * workspace.
 */
export function ScreenStep({
  workspaceId,
  dashboardId,
  kioskUrl,
  canManageDevices,
  suggestSource,
}: {
  workspaceId: string;
  /** The dashboard to open: the demo or the first one; else the list. */
  dashboardId: string | null;
  /** Where a browser on the TV opens netrics, e.g. https://app…/kiosk. */
  kioskUrl: string;
  canManageDevices: boolean;
  /** No real source yet (the user skipped step 2): offer it again. */
  suggestSource: boolean;
}) {
  const t = useT("onboarding.screen");
  const dashboardHref = dashboardId
    ? `/workspaces/${workspaceId}/dashboards/${dashboardId}`
    : `/workspaces/${workspaceId}/dashboards`;
  return (
    <div className="onboarding-panel">
      <header>
        <h1>{t("title")}</h1>
        <p className="subtitle">{t("subtitle")}</p>
      </header>
      {canManageDevices ? (
        <ol className="onboarding-screen-steps">
          <li>
            <span>
              {t.rich("open", {
                url: (
                  <Link key="url" href="/kiosk">
                    {kioskUrl}
                  </Link>
                ),
              })}
            </span>
          </li>
          <li>
            <span>{t("code")}</span>
          </li>
          <li>
            <span>{t("enter")}</span>
          </li>
        </ol>
      ) : (
        <p className="onboarding-explainer">{t("askAdmin")}</p>
      )}
      <div className="onboarding-footer">
        {suggestSource ? (
          <Link href={`/workspaces/${workspaceId}/welcome`} className="button">
            {t("connectSource")}
          </Link>
        ) : null}
        <div className="onboarding-footer-actions">
          <Link
            href={dashboardHref}
            className={canManageDevices ? "button" : "button primary"}
          >
            {t("openDashboard")}
          </Link>
          {canManageDevices ? (
            <Link href="/devices/approve" className="button primary">
              {t("connectTv")}
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
