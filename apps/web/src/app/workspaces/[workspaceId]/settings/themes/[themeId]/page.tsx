import Link from "next/link";
import { notFound } from "next/navigation";

import { BUILTIN_THEMES, can } from "@netrics/domain";

import { getTheme, listWorkspaces } from "@/lib/api";
import { requireSession } from "@/lib/session";

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

  return (
    <div className="theme-editor-page">
      <p className="muted">
        <Link href={`/workspaces/${workspaceId}/settings/themes`}>
          All themes
        </Link>
      </p>
      <ThemeEditor
        workspaceId={workspaceId}
        theme={theme}
        baseName={BUILTIN_THEMES[theme.base].name}
        canEdit={can(membership.role, "dashboards:update")}
      />
    </div>
  );
}
