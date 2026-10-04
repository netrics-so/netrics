"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
  isLocale,
  type Locale,
} from "@netrics/domain";

import { apiErrorMessage, setWorkspaceScreenLocale } from "@/lib/api";
import { useT } from "@/lib/i18n/client";

/** The language of the workspace's kiosks and Apple TVs (ADR 0016). */
export function ScreenLanguageForm({
  workspaceId,
  current,
  instanceDefaultName,
}: {
  workspaceId: string;
  current: Locale | null;
  /** The instance default's name, what "unset" means for screens. */
  instanceDefaultName: string;
}) {
  const t = useT("workspaceSettings.screenLanguage");
  const common = useT("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const value = String(new FormData(event.currentTarget).get("screenLocale"));
    try {
      await setWorkspaceScreenLocale(
        workspaceId,
        isLocale(value) ? value : null,
      );
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="inline" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="workspace-screen-locale">{t("label")}</label>
        <select
          id="workspace-screen-locale"
          name="screenLocale"
          defaultValue={current ?? ""}
          disabled={pending}
        >
          <option value="">
            {t("automatic", { language: instanceDefaultName })}
          </option>
          {SUPPORTED_LOCALES.map((locale) => (
            <option key={locale} value={locale} lang={locale}>
              {LOCALE_NAMES[locale]}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" disabled={pending}>
        {pending ? common("saving") : common("save")}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </form>
  );
}
