"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { signUp } from "@/lib/auth";
import { authErrorMessage } from "@/lib/auth-errors";
import { useLocale, useT } from "@/lib/i18n/client";

export function SignupForm() {
  const locale = useLocale();
  const t = useT("signup");
  const fields = useT("authFields");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error: authError } = await signUp.email({
      name: String(form.get("name") ?? ""),
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    setPending(false);
    if (authError) {
      setError(authErrorMessage(authError, locale, "signUp"));
      return;
    }
    // Email verification is not enforced yet, so sign-up signs in directly.
    router.push("/");
    router.refresh();
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="name">{fields("name")}</label>
        <input
          id="name"
          name="name"
          type="text"
          required
          autoComplete="name"
          disabled={pending}
        />
      </div>
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
      <div className="field">
        <label htmlFor="password">{fields("password")}</label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          disabled={pending}
        />
      </div>
      {error ? <div className="error">{error}</div> : null}
      <button type="submit" className="primary" disabled={pending}>
        {pending ? t("pending") : t("submit")}
      </button>
    </form>
  );
}
