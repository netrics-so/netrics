"use client";

import { useState, type FormEvent } from "react";

import { requestPasswordReset } from "@/lib/auth";
import { useT } from "@/lib/i18n/client";
import {
  RESET_LINK_LIFETIME_HOURS,
  resetPasswordRedirect,
} from "@/lib/password-reset";

export function ForgotPasswordForm() {
  const t = useT("passwordReset");
  const fields = useT("authFields");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error: authError } = await requestPasswordReset({
      email: String(form.get("email") ?? "").trim(),
      redirectTo: resetPasswordRedirect(window.location.origin),
    });
    setPending(false);
    if (authError) {
      setError(
        authError.status === 429 ? t("tooManyRequests") : t("sendFailed"),
      );
      return;
    }
    // The same answer whether or not an account exists for the address.
    setSent(true);
  }

  if (sent) {
    return (
      <div className="notice" role="status">
        {t("sent", { hours: RESET_LINK_LIFETIME_HOURS })}
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="email">{fields("email")}</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          disabled={pending}
        />
      </div>
      {error ? <div className="error">{error}</div> : null}
      <button type="submit" className="primary" disabled={pending}>
        {pending ? t("sending") : t("send")}
      </button>
    </form>
  );
}
