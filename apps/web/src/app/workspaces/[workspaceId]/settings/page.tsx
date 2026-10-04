import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LOCALE_NAMES, can } from "@netrics/domain";

import { DisplayCurrencyForm } from "./display-currency-form";
import { RenameWorkspaceForm } from "./rename-workspace-form";
import { ScreenLanguageForm } from "./screen-language-form";
import { TimeZoneForm } from "./time-zone-form";
import { getCurrencyConversion, getWorkspace, listWorkspaces } from "@/lib/api";
import { instanceDefaultLocale } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

interface WorkspaceSettingsPageProps {
  params: Promise<{ workspaceId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("workspaceSettings");
  return { title: t("metaTitle") };
}

/**
 * The workspace's own settings. Members moved to Team (#302); themes keep
 * their URL below settings and are listed under Dashboards in the sidebar.
 */
export default async function WorkspaceSettingsPage({
  params,
}: WorkspaceSettingsPageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();

  const [{ workspaces }, workspaceResult] = await Promise.all([
    listWorkspaces(cookieHeader),
    getWorkspace(cookieHeader, workspaceId),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!workspaceResult || !membership) {
    notFound();
  }

  const role = membership.role;
  const [t, roles, screenLanguage] = await Promise.all([
    getT("workspaceSettings"),
    getT("common.roles"),
    getT("workspaceSettings.screenLanguage"),
  ]);
  const canRename = can(role, "workspace:rename");
  const conversion = canRename
    ? await getCurrencyConversion(cookieHeader, workspaceId)
    : null;

  return (
    <div className="area-page settings-page">
      <header className="page-header">
        <div>
          <h1>{t("title", { workspace: workspaceResult.workspace.name })}</h1>
          <p className="page-meta">
            {t.rich("yourRole", {
              role: (
                <span key="role" className="role-badge">
                  {roles(role)}
                </span>
              ),
            })}
          </p>
        </div>
      </header>

      {canRename ? (
        <div className="card">
          <h2>{t("workspace.title")}</h2>
          <RenameWorkspaceForm
            workspaceId={workspaceId}
            currentName={workspaceResult.workspace.name}
          />
          <TimeZoneForm
            workspaceId={workspaceId}
            currentTimeZone={workspaceResult.workspace.timeZone}
          />
          <p className="muted">{t("workspace.timeZoneHint")}</p>
          <ScreenLanguageForm
            workspaceId={workspaceId}
            current={workspaceResult.workspace.screenLocale}
            instanceDefaultName={LOCALE_NAMES[instanceDefaultLocale() ?? "en"]}
          />
          <p className="muted">{screenLanguage("hint")}</p>
        </div>
      ) : (
        <p className="muted">{t("readOnly")}</p>
      )}

      {canRename && conversion ? (
        <div className="card">
          <h2>{t("currency.title")}</h2>
          <DisplayCurrencyForm
            workspaceId={workspaceId}
            currentDisplayCurrency={workspaceResult.workspace.displayCurrency}
            options={conversion}
          />
        </div>
      ) : null}

      {can(role, "dashboards:view") ? (
        <div className="card">
          <h2>{t("themes.title")}</h2>
          <p className="muted">{t("themes.hint")}</p>
          <p>
            <Link href={`/workspaces/${workspaceId}/settings/themes`}>
              {t("themes.manage")}
            </Link>
          </p>
        </div>
      ) : null}

      <div className="card" id="members">
        <h2>{t("team.title")}</h2>
        <p className="muted">{t("team.hint")}</p>
        <p>
          <Link href={`/workspaces/${workspaceId}/team`}>
            {t("team.manage")}
          </Link>
        </p>
      </div>
    </div>
  );
}
