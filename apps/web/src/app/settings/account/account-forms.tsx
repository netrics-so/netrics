"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { changePassword, signOut } from "@/lib/auth";

export function ChangePasswordForm() {
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
      setError(authError.message ?? "Could not change password.");
      return;
    }
    formEl.reset();
    setSuccess(true);
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="currentPassword">Current password</label>
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
        <label htmlFor="newPassword">New password</label>
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
      {success ? <div className="notice">Password changed.</div> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}

export function SignOutButton() {
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
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
