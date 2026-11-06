"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { ConnectionRetention } from "@netrics/contracts";

import {
  RetentionFields,
  shortensRetention,
  type RetentionValues,
} from "../retention-fields";
import { apiErrorMessage, updateConnectionRetention } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";

interface RetentionSettingsProps {
  workspaceId: string;
  connectionId: string;
  retention: ConnectionRetention;
  canUpdate: boolean;
  /** Shown while an OAuth connection still finishes its setup. */
  setup?: boolean;
}

function valuesOf(retention: ConnectionRetention): RetentionValues {
  return Object.fromEntries(retention.datasets.map((d) => [d.key, d.days]));
}

/**
 * A connection's dataset retention (#492): one choice per dataset, who chose
 * it and when. Saving applies it at once.
 */
export function RetentionSettings({
  workspaceId,
  connectionId,
  retention: initial,
  canUpdate,
  setup = false,
}: RetentionSettingsProps) {
  const locale = useLocale();
  const t = useT("connections.retention");
  const common = useT("common");
  const router = useRouter();
  const [retention, setRetention] = useState(initial);
  const [values, setValues] = useState(() => valuesOf(initial));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const shortens = shortensRetention(valuesOf(retention), values);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const saved = await updateConnectionRetention(workspaceId, connectionId, {
        datasets: values,
      });
      setRetention(saved.retention);
      setValues(valuesOf(saved.retention));
      setNotice(t("saved"));
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  const date = retention.chosenAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
        new Date(retention.chosenAt),
      )
    : null;
  const recorded =
    retention.basis === "preset" || date === null
      ? t("preset")
      : retention.basis === "migrated"
        ? t("migrated", { date })
        : retention.chosenBy
          ? t("chosenBy", { name: retention.chosenBy.name, date })
          : t("chosenOn", { date });

  return (
    <form className="stack" onSubmit={onSubmit}>
      <p className="muted">{setup ? t("setupIntro") : t("intro")}</p>
      <RetentionFields
        idPrefix="retention"
        datasets={retention.datasets}
        values={values}
        workspaceMaxDays={retention.workspaceMaxDays}
        disabled={!canUpdate || pending}
        onChange={setValues}
      />
      {retention.workspaceMaxDays !== null ? (
        <p className="page-meta">
          {t("workspaceMax", { days: retention.workspaceMaxDays })}
        </p>
      ) : null}
      <p className="page-meta" data-testid="retention-recorded">
        {recorded}
      </p>
      {canUpdate ? (
        <>
          {shortens ? (
            <div className="notice" role="note">
              {t("shortenWarning")}
            </div>
          ) : null}
          <div className="actions">
            <button type="submit" className="primary" disabled={pending}>
              {pending ? common("saving") : t("save")}
            </button>
          </div>
        </>
      ) : (
        <p className="muted">{t("readOnly")}</p>
      )}
      {notice ? (
        <div className="notice" role="status">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
