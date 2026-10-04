"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  apiErrorMessage,
  deleteConnection,
  triggerConnectionSync,
} from "@/lib/api";
import { disconnectQuery, providerName } from "@/lib/oauth-connection";
import { keyRemovedQuery } from "@/lib/signed-key";
import { useLocale, useT } from "@/lib/i18n/client";

interface ConnectionActionsProps {
  workspaceId: string;
  connectionId: string;
  connectionName: string;
  /** The OAuth provider the connection is authorized at, if any. */
  oauthProvider: string | null;
  /** The uploaded key of a signed-key connection (ADR 0014), if any. */
  signedKey?: {
    provider: string;
    providerName: string;
    revokeUrl: string | null;
    keyId: string | null;
  } | null;
  canSync: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export function ConnectionActions({
  workspaceId,
  connectionId,
  connectionName,
  oauthProvider,
  signedKey = null,
  canSync,
  canUpdate,
  canDelete,
}: ConnectionActionsProps) {
  const locale = useLocale();
  const t = useT("connections.actions");
  const common = useT("common");
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
      setNotice(t("syncQueued"));
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  async function onDelete() {
    setError(null);
    setPending(true);
    try {
      const result = await deleteConnection(workspaceId, connectionId);
      // Sources says what happened at the provider, or for an
      // uploaded key that it is still valid there until revoked.
      router.push(
        result.revocation
          ? `/workspaces/${workspaceId}/sources?${disconnectQuery(result.revocation)}`
          : signedKey
            ? `/workspaces/${workspaceId}/sources?${keyRemovedQuery(signedKey.provider)}`
            : `/workspaces/${workspaceId}/sources`,
      );
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
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
            {t("syncNow")}
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
            {name ? t("disconnect") : t("deleteConnection")}
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
            {name
              ? t("confirmDisconnect", { name: connectionName })
              : t("confirmDelete", { name: connectionName })}
          </h3>
          <p>{t("removesData")}</p>
          {name ? (
            <p className="muted">{t("removesAccess", { name })}</p>
          ) : null}
          {signedKey ? (
            <p className="muted">
              {signedKey.keyId
                ? t("deletesKeyCopyId", {
                    name: signedKey.providerName,
                    keyId: signedKey.keyId,
                  })
                : t("deletesKeyCopy", { name: signedKey.providerName })}
              {signedKey.revokeUrl ? (
                <>
                  {" "}
                  <a
                    href={signedKey.revokeUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("apiKeys")} ↗
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="danger"
              disabled={pending}
              onClick={onDelete}
            >
              {pending
                ? common("removing")
                : name
                  ? t("disconnect")
                  : common("delete")}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              {common("cancel")}
            </button>
          </div>
        </div>
      ) : null}
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
