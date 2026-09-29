"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { resetPassword } from "@/lib/auth";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isInvalidTokenError,
  newPasswordProblem,
  resetErrorMessage,
} from "@/lib/password-reset";

type State = "form" | "done" | "expired";

export function ResetPasswordForm({ token }: { token: string }) {
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
      setError(resetErrorMessage(authError));
      return;
    }
    setState("done");
  }

  if (state === "done") {
    return (
      <div className="notice" role="status">
        Password changed. Other sessions were signed out.{" "}
        <Link href="/login">Sign in</Link> with the new password.
      </div>
    );
  }

  if (state === "expired") {
    return (
      <div className="error" role="alert">
        <p>This reset link is invalid or has expired.</p>
        <p>
          <Link href="/forgot-password">Request a new link</Link>
        </p>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="newPassword">New password</label>
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
          At least {PASSWORD_MIN_LENGTH} characters.
        </p>
      </div>
      <div className="field">
        <label htmlFor="confirmPassword">Confirm new password</label>
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
        {pending ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
