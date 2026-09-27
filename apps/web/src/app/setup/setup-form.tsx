"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { signUp } from "@/lib/auth";

// Must match SETUP_TOKEN_HEADER in apps/server/src/setup.ts.
const SETUP_TOKEN_HEADER = "x-netrics-setup-token";

export function SetupForm({ initialToken }: { initialToken: string }) {
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
      fetchOptions: {
        headers: { [SETUP_TOKEN_HEADER]: String(form.get("token") ?? "") },
      },
    });
    setPending(false);
    if (authError) {
      setError(
        authError.status === 403
          ? "The setup token is invalid or was already used."
          : (authError.message ?? "Setup failed."),
      );
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="token">Setup token</label>
        <input
          id="token"
          name="token"
          type="password"
          required
          defaultValue={initialToken}
          autoComplete="off"
          disabled={pending}
        />
      </div>
      <div className="field">
        <label htmlFor="name">Name</label>
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
      <div className="field">
        <label htmlFor="password">Password</label>
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
        {pending ? "Setting up…" : "Create owner account"}
      </button>
    </form>
  );
}
