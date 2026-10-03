"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  apiErrorMessage,
  deleteConnection,
  triggerConnectionSync,
} from "@/lib/api";
import { disconnectQuery, providerName } from "@/lib/oauth-connection";

interface ConnectionActionsProps {
  workspaceId: string;
  connectionId: string;
  connectionName: string;
  /** The OAuth provider the connection is authorized at, if any. */
  oauthProvider: string | null;
  canSync: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export function ConnectionActions({
  workspaceId,
  connectionId,
  connectionName,
  oauthProvider,
  canSync,
  canUpdate,
  canDelete,
}: ConnectionActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
    setError(null);
    setPending(true);
    try {
      const result = await deleteConnection(workspaceId, connectionId);
      // The workspace page says what happened at the provider.
      router.push(
        result.revocation
          ? `/workspaces/${workspaceId}?${disconnectQuery(result.revocation)}`
          : `/workspaces/${workspaceId}`,
      );
    } catch (cause) {
      setError(apiErrorMessage(cause));
      setPending(false);
    }
  }

  if (!canUpdate && !canDelete) {
    return null;
  }

  const name = oauthProvider ? providerName(oauthProvider) : null;

  return (
    <>
      <div className="actions">
        {canUpdate && canSync ? (
          <button
            type="button"
            disabled={pending || confirming}
            onClick={onSyncNow}
          >
            Sync now
          </button>
        ) : null}
        {canDelete && !confirming ? (
          <button
            type="button"
            className="danger"
            disabled={pending}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            {name ? "Disconnect" : "Delete connection"}
          </button>
        ) : null}
      </div>
      {confirming ? (
        <div
          className="confirm-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="disconnect-title"
        >
          <h3 id="disconnect-title">
            {name ? "Disconnect" : "Delete"} “{connectionName}”?
          </h3>
          <p>
            Its state, observations and sync history are removed. Dashboard
            tiles that use it show that the connection is gone.
          </p>
          {name ? (
            <p className="muted">
              netrics also removes its access to your {name} account, unless
              other netrics connections still use that account; then the access
              stays until the last one is disconnected.
            </p>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="danger"
              disabled={pending}
              onClick={onDelete}
            >
              {pending ? "Removing…" : name ? "Disconnect" : "Delete"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
