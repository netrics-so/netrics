"use client";

import { useState, type FormEvent } from "react";

import { requestPasswordReset } from "@/lib/auth";
import {
  RESET_LINK_LIFETIME,
  resetPasswordRedirect,
} from "@/lib/password-reset";

export function ForgotPasswordForm() {
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
        authError.status === 429
          ? "Too many requests. Wait a few minutes and try again."
          : "We could not send the email. Try again later.",
      );
      return;
    }
    // The same answer whether or not an account exists for the address.
    setSent(true);
  }

  if (sent) {
    return (
      <div className="notice" role="status">
        If an account exists for that address, we sent a link to reset the
        password. It is valid for {RESET_LINK_LIFETIME}.
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="email">Email</label>
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
        {pending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
