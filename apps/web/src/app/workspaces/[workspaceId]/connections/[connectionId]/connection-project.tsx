"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ProjectSelect } from "@/components/project-select";
import { apiErrorMessage, updateConnection } from "@/lib/api";
import { useLocale } from "@/lib/i18n/client";

/**
 * The connection's project (#573), saved on change: the PATCH moves it and
 * nothing else. Archived projects are offered only as the current value;
 * the server refuses moving into one.
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
  const [value, setValue] = useState(projectId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onChange(next: string | null) {
    const previous = value;
    setValue(next);
    setPending(true);
    setError(null);
    try {
      await updateConnection(workspaceId, connectionId, { projectId: next });
      router.refresh();
    } catch (cause) {
      setValue(previous);
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="connection-project">
      <ProjectSelect
        id="connection-project"
        projects={projects}
        value={value}
        disabled={pending}
        onChange={(next) => void onChange(next)}
      />
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
