import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { getTheme, listWorkspaces } from "@/lib/api";
import { getLocale, getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";
import { builtinThemeName } from "@/lib/theme-name";

import { ThemeEditor } from "./theme-editor";

export const dynamic = "force-dynamic";

interface ThemePageProps {
  params: Promise<{ workspaceId: string; themeId: string }>;
}

export default async function ThemePage({ params }: ThemePageProps) {
  const { workspaceId, themeId } = await params;
  const { cookieHeader } = await requireSession();
  const { workspaces } = await listWorkspaces(cookieHeader);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership || !can(membership.role, "dashboards:view")) {
    notFound();
  }
  const result = await getTheme(cookieHeader, workspaceId, themeId);
  if (!result) {
    notFound();
  }
  const { theme } = result;
  const [t, locale] = await Promise.all([getT("themes"), getLocale()]);

  return (
    <div className="theme-editor-page">
      <p className="muted">
        <Link href={`/workspaces/${workspaceId}/settings/themes`}>
          {t("allThemes")}
        </Link>
      </p>
      <ThemeEditor
        workspaceId={workspaceId}
        theme={theme}
        baseName={builtinThemeName(theme.base, locale)}
        canEdit={can(membership.role, "dashboards:update")}
      />
    </div>
  );
}
