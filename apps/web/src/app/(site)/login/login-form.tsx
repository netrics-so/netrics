"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { signIn } from "@/lib/auth";
import { authErrorMessage } from "@/lib/auth-errors";
import { useLocale, useT } from "@/lib/i18n/client";

export function LoginForm({ next }: { next: string }) {
  const locale = useLocale();
  const t = useT("login");
  const fields = useT("authFields");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error: authError } = await signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    setPending(false);
    if (authError) {
      setError(authErrorMessage(authError, locale, "signIn"));
      return;
    }
    router.push(next);
    router.refresh();
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
      <div className="field">
        <label htmlFor="password">{fields("password")}</label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
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
