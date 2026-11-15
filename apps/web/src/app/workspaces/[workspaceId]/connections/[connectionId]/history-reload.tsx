"use client";

import type { ConnectionHistory } from "@netrics/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { apiErrorMessage, requestHistoryReload } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";
import { relativeTime } from "@/lib/relative-time";

interface HistoryReloadProps {
  workspaceId: string;
  connectionId: string;
  connectionName: string;
  history: ConnectionHistory;
}

/**
 * "Reload history" (#617): reads the connector's whole backfill window
 * again, after a confirmation that says what it does and that it takes a
 * while. Disabled while a backfill waits or runs, and until the rate limit
 * allows the next one. Shown to members who can sync the connection.
 */
export function HistoryReload({
  workspaceId,
  connectionId,
  connectionName,
  history,
}: HistoryReloadProps) {
  const locale = useLocale();
  const t = useT("connections.history");
  const common = useT("common");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = history.backfill !== "idle" || queued;
  const limited = history.reloadAvailableAt !== null;

  async function onConfirm() {
    setError(null);
    setPending(true);
    try {
      await requestHistoryReload(workspaceId, connectionId);
      setQueued(true);
      setConfirming(false);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="actions">
        <button
          type="button"
          disabled={busy || limited || pending || confirming}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          {t("reload")}
        </button>
      </div>
      {limited && !busy ? (
        <p className="muted">
          {t("availableAgain", {
            when: relativeTime(history.reloadAvailableAt, locale),
          })}
        </p>
      ) : null}
      {confirming ? (
        <div
          className="confirm-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="history-reload-title"
        >
          <h3 id="history-reload-title">
            {t("confirmTitle", { name: connectionName })}
          </h3>
          <p>{t("confirmBody", { days: history.backfillDays })}</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={pending}
              onClick={onConfirm}
            >
              {pending ? t("reloading") : t("confirm")}
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
      {queued ? (
        <div className="notice" role="status">
          {t("queued")}
        </div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
