import Link from "next/link";

import type { WorkspaceRole } from "@netrics/domain";

import { getT } from "@/lib/i18n/server";

/**
 * Why a viewer sees no buttons to add sources, edit data or change
 * dashboards (#636), where those actions would be: the role, and who can
 * change it (owners and admins, listed on the Team page). Nothing for
 * other roles.
 */
export async function ViewerHint({
  role,
  workspaceId,
}: {
  role: WorkspaceRole;
  workspaceId: string;
}) {
  if (role !== "viewer") return null;
  const t = await getT("workspace.viewerHint");
  return (
    <p className="viewer-hint" role="note">
      {t("text")}{" "}
      <Link href={`/workspaces/${workspaceId}/team`}>{t("team")}</Link>
    </p>
  );
}
