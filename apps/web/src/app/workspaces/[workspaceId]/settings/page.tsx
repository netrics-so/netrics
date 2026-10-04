import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LOCALE_NAMES, can } from "@netrics/domain";

import { DisplayCurrencyForm } from "./display-currency-form";
import { MembersManager } from "./members-manager";
import { RenameWorkspaceForm } from "./rename-workspace-form";
import { ScreenLanguageForm } from "./screen-language-form";
import { TimeZoneForm } from "./time-zone-form";
import {
  getCurrencyConversion,
  getMe,
  getWorkspace,
  listInvitations,
  listMembers,
  listWorkspaces,
} from "@/lib/api";
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

export default async function WorkspaceSettingsPage({
  params,
}: WorkspaceSettingsPageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();

  const [{ workspaces }, workspaceResult, me] = await Promise.all([
    listWorkspaces(cookieHeader),
    getWorkspace(cookieHeader, workspaceId),
    getMe(cookieHeader),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!workspaceResult || !membership || !me) {
    notFound();
  }

  const role = membership.role;
  const [t, roles, screenLanguage] = await Promise.all([
    getT("workspaceSettings"),
    getT("common.roles"),
    getT("workspaceSettings.screenLanguage"),
  ]);
  const canRename = can(role, "workspace:rename");
  const canAddMembers = can(role, "members:add");
  const [{ members }, { invitations }, conversion] = await Promise.all([
    listMembers(cookieHeader, workspaceId),
    canAddMembers
      ? listInvitations(cookieHeader, workspaceId)
      : Promise.resolve({ invitations: [] }),
    canRename ? getCurrencyConversion(cookieHeader, workspaceId) : null,
  ]);

  return (
    <>
      <h1>{t("title", { workspace: workspaceResult.workspace.name })}</h1>
      <p className="subtitle">
        {t.rich("yourRole", {
          role: (
            <span key="role" className="role-badge">
              {roles(role)}
            </span>
          ),
        })}
      </p>
      <p className="muted">
        <Link href={`/workspaces/${workspaceId}`}>{t("backToWorkspace")}</Link>
      </p>

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
      ) : null}

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

      <MembersManager
        workspaceId={workspaceId}
        members={members}
        actorRole={role}
        currentUserId={me.user.id}
        canAdd={canAddMembers}
        invitations={invitations}
      />
    </>
  );
}
