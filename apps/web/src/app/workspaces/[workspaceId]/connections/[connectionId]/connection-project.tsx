"use client";

import { useRouter } from "next/navigation";

import { ProjectAssignment } from "@/components/project-select";
import { apiErrorMessage, updateConnection } from "@/lib/api";
import { useLocale } from "@/lib/i18n/client";

/**
 * The connection's project (#573), saved on change: the PATCH moves it and
 * nothing else, and the select says when it is saved (#640). Archived
 * projects are offered only as the current value; the server refuses
 * moving into one.
 */
export function ConnectionProject({
  workspaceId,
  connectionId,
  projectId,
  projects,
}: {
  workspaceId: string;
  connectionId: string;
  projectId: string | null;
  projects: ReadonlyArray<{
    id: string;
    name: string;
    archivedAt: string | null;
  }>;
}) {
  const locale = useLocale();
  const router = useRouter();

  return (
    <div className="connection-project">
      <ProjectAssignment
        id="connection-project"
        projects={projects}
        value={projectId}
        onSave={async (next) => {
          await updateConnection(workspaceId, connectionId, {
            projectId: next,
          });
          router.refresh();
        }}
        describeError={(cause) => apiErrorMessage(cause, locale)}
      />
    </div>
  );
}
