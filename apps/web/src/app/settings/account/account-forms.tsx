"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
  isLocale,
  type Locale,
} from "@netrics/domain";

import { apiErrorMessage, setMyLocale } from "@/lib/api";
import { changePassword, signOut } from "@/lib/auth";
import { useT } from "@/lib/i18n/client";

/**
 * The user's language (ADR 0016). Saving re-renders the server components,
 * so the page switches language at once.
 */
export function LanguageForm({
  current,
  automaticName,
}: {
  current: Locale | null;
  /** The language "Automatic" resolves to for this request. */
  automaticName: string;
}) {
  const t = useT("account.language");
  const common = useT("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    const value = String(new FormData(event.currentTarget).get("locale"));
    try {
      await setMyLocale(isLocale(value) ? value : null);
      setSaved(true);
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
        <label htmlFor="account-locale">{t("label")}</label>
        <select
          id="account-locale"
          name="locale"
          defaultValue={current ?? ""}
          disabled={pending}
        >
          <option value="">
            {t("automatic", { language: automaticName })}
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
      {saved ? <div className="notice">{t("saved")}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </form>
  );
}

export function ChangePasswordForm() {
  const t = useT("account");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    setError(null);
    setSuccess(false);
    setPending(true);
    const form = new FormData(formEl);
    const { error: authError } = await changePassword({
      currentPassword: String(form.get("currentPassword") ?? ""),
      newPassword: String(form.get("newPassword") ?? ""),
      revokeOtherSessions: true,
    });
    setPending(false);
    if (authError) {
      setError(authError.message ?? t("passwordChangeFailed"));
      return;
    }
    formEl.reset();
    setSuccess(true);
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="currentPassword">{t("currentPassword")}</label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
          disabled={pending}
        />
      </div>
      <div className="field">
        <label htmlFor="newPassword">{t("newPassword")}</label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          disabled={pending}
        />
      </div>
      {error ? <div className="error">{error}</div> : null}
      {success ? <div className="notice">{t("passwordChanged")}</div> : null}
      <button type="submit" disabled={pending}>
        {pending ? t("changing") : t("changePassword")}
      </button>
    </form>
  );
}

export function SignOutButton() {
  const t = useT("account");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    await signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      className="danger"
      disabled={pending}
      onClick={onClick}
    >
      {pending ? t("signingOut") : t("signOut")}
    </button>
  );
}
