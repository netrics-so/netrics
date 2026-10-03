import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { ThemePreview } from "@/components/theme-preview";
import { listThemes, listWorkspaces } from "@/lib/api";
import { requireSession } from "@/lib/session";

import { CopyBuiltinButton } from "./copy-builtin-button";

export const dynamic = "force-dynamic";

interface ThemesPageProps {
  params: Promise<{ workspaceId: string }>;
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

  return (
    <div className="themes-page">
      <h1>Themes</h1>
      <p className="subtitle">
        How dashboards look on TVs and in the browser. Custom themes start as a
        copy of a built-in.
      </p>
      <p className="muted">
        <Link href={`/workspaces/${workspaceId}/settings`}>
          Back to settings
        </Link>
      </p>

      <div className="card">
        <h2>Custom themes</h2>
        {themes.length === 0 ? (
          <p className="muted">
            None yet.{" "}
            {canEdit ? "Copy a built-in below to make your own." : null}
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
                      {theme.warnings.length} below AA
                    </span>
                  ) : (
                    <span className="contrast-badge pass">AA</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Built-in themes</h2>
        <ul className="theme-list">
          {builtins.map((theme) => (
            <li key={theme.key}>
              <ThemePreview tokens={theme.tokens} />
              <div className="theme-list-meta">
                <span>{theme.name}</span>
                {canEdit ? (
                  <CopyBuiltinButton
                    workspaceId={workspaceId}
                    base={theme.key}
                    baseName={theme.name}
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
