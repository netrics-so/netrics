"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  apiErrorMessage,
  deleteConnection,
  triggerConnectionSync,
} from "@/lib/api";

interface ConnectionActionsProps {
  workspaceId: string;
  connectionId: string;
  connectionName: string;
  canUpdate: boolean;
  canDelete: boolean;
}

export function ConnectionActions({
  workspaceId,
  connectionId,
  connectionName,
  canUpdate,
  canDelete,
}: ConnectionActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSyncNow() {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      await triggerConnectionSync(workspaceId, connectionId);
      setNotice("Sync queued — it will run on the next worker pass.");
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function onDelete() {
    if (
      !window.confirm(
        `Delete connection "${connectionName}"? Its state, observations, and sync history will be removed.`,
      )
    ) {
      return;
    }
    setError(null);
    setPending(true);
    try {
      await deleteConnection(workspaceId, connectionId);
      router.push(`/workspaces/${workspaceId}`);
    } catch (cause) {
      setError(apiErrorMessage(cause));
      setPending(false);
    }
  }

  if (!canUpdate && !canDelete) {
    return null;
  }

  return (
    <>
      <div className="actions">
        {canUpdate ? (
          <button type="button" disabled={pending} onClick={onSyncNow}>
            Sync now
          </button>
        ) : null}
        {canDelete ? (
          <button
            type="button"
            className="danger"
            disabled={pending}
            onClick={onDelete}
          >
            Delete connection
          </button>
        ) : null}
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
