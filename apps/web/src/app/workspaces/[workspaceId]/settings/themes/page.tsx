import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { ThemePreview } from "@/components/theme-preview";
import { listThemes, listWorkspaces } from "@/lib/api";
import { getLocale, getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";
import { builtinThemeName } from "@/lib/theme-name";

import { CopyBuiltinButton } from "./copy-builtin-button";

export const dynamic = "force-dynamic";

interface ThemesPageProps {
  params: Promise<{ workspaceId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("themes");
  return { title: t("metaTitle") };
}

/** Built-in and custom dashboard themes (#216). */
export default async function ThemesPage({ params }: ThemesPageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();
  const { workspaces } = await listWorkspaces(cookieHeader);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership || !can(membership.role, "dashboards:view")) {
    notFound();
  }
  const canEdit = can(membership.role, "dashboards:update");
  const { builtins, themes } = await listThemes(cookieHeader, workspaceId);
  const takenNames = themes.map((theme) => theme.name);
  const [t, locale] = await Promise.all([getT("themes"), getLocale()]);

  return (
    <div className="themes-page">
      <h1>{t("title")}</h1>
      <p className="subtitle">{t("subtitle")}</p>
      <p className="muted">
        <Link href={`/workspaces/${workspaceId}/settings`}>
          {t("backToSettings")}
        </Link>
      </p>

      <div className="card">
        <h2>{t("custom")}</h2>
        {themes.length === 0 ? (
          <p className="muted">
            {t("noneYet")} {canEdit ? t("copyHint") : null}
          </p>
        ) : (
          <ul className="theme-list">
            {themes.map((theme) => (
              <li key={theme.id}>
                <ThemePreview tokens={theme.tokens} />
                <div className="theme-list-meta">
                  <Link
                    href={`/workspaces/${workspaceId}/settings/themes/${theme.id}`}
                  >
                    {theme.name}
                  </Link>
                  {theme.warnings.length > 0 ? (
                    <span className="contrast-badge warn">
                      {t("belowAa", { count: theme.warnings.length })}
                    </span>
                  ) : (
                    <span className="contrast-badge pass">{t("aa")}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>{t("builtins")}</h2>
        <ul className="theme-list">
          {builtins.map((theme) => (
            <li key={theme.key}>
              <ThemePreview tokens={theme.tokens} />
              <div className="theme-list-meta">
                <span>{builtinThemeName(theme.key, locale)}</span>
                {canEdit ? (
                  <CopyBuiltinButton
                    workspaceId={workspaceId}
                    base={theme.key}
                    baseName={builtinThemeName(theme.key, locale)}
                    takenNames={takenNames}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
