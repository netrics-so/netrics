"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { resetPassword } from "@/lib/auth";
import { authErrorMessage } from "@/lib/auth-errors";
import { useLocale, useT } from "@/lib/i18n/client";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isInvalidTokenError,
  newPasswordProblem,
} from "@/lib/password-reset";

type State = "form" | "done" | "expired";

export function ResetPasswordForm({ token }: { token: string }) {
  const locale = useLocale();
  const t = useT("passwordReset");
  const [state, setState] = useState<State>("form");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    const problem = newPasswordProblem(
      newPassword,
      String(form.get("confirmPassword") ?? ""),
      locale,
    );
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    const { error: authError } = await resetPassword({ newPassword, token });
    setPending(false);
    if (authError) {
      if (isInvalidTokenError(authError)) {
        setState("expired");
        return;
      }
      setError(authErrorMessage(authError, locale));
      return;
    }
    setState("done");
  }

  if (state === "done") {
    return (
      <div className="notice" role="status">
        {t.rich("done", {
          link: (
            <Link key="link" href="/login">
              {t("signIn")}
            </Link>
          ),
        })}
      </div>
    );
  }

  if (state === "expired") {
    return (
      <div className="error" role="alert">
        <p>{t("invalidLink")}</p>
        <p>
          <Link href="/forgot-password">{t("requestNew")}</Link>
        </p>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="newPassword">{t("newPassword")}</label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          aria-describedby="newPassword-help"
          disabled={pending}
        />
        <p className="help" id="newPassword-help">
          {t("minLengthHint", { count: PASSWORD_MIN_LENGTH })}
        </p>
      </div>
      <div className="field">
        <label htmlFor="confirmPassword">{t("confirmPassword")}</label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          disabled={pending}
        />
      </div>
      {error ? <div className="error">{error}</div> : null}
      <button type="submit" className="primary" disabled={pending}>
        {pending ? t("saving") : t("submit")}
      </button>
    </form>
  );
}
