"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { acceptInvitation, apiErrorMessage } from "@/lib/api";
import { signOut, signUp } from "@/lib/auth";
import { authErrorMessage } from "@/lib/auth-errors";
import { useLocale, useT } from "@/lib/i18n/client";

// Must match INVITATION_TOKEN_HEADER in apps/server/src/auth/index.ts.
const INVITATION_TOKEN_HEADER = "x-netrics-invitation-token";

export function InvitationActions({
  token,
  invitedEmail,
  signedInEmail,
}: {
  token: string;
  invitedEmail: string;
  signedInEmail: string | null;
}) {
  const locale = useLocale();
  const t = useT("invite");
  const fields = useT("authFields");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function accept() {
    const { workspaceId } = await acceptInvitation(token);
    router.push(`/workspaces/${workspaceId}`);
    router.refresh();
  }

  async function run(action: () => Promise<void>) {
    setError(null);
    setPending(true);
    try {
      await action();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(false);
    }
  }

  if (signedInEmail && signedInEmail.toLowerCase() !== invitedEmail) {
    return (
      <div className="stack">
        <p>
          {t("wrongAccount", {
            signedIn: signedInEmail,
            invited: invitedEmail,
          })}
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(async () => {
              await signOut();
              router.refresh();
            })
          }
        >
          {t("signOut")}
        </button>
      </div>
    );
  }

  if (signedInEmail) {
    return (
      <div className="stack">
        <button
          type="button"
          className="primary"
          disabled={pending}
          onClick={() => run(accept)}
        >
          {pending ? t("joining") : t("accept")}
        </button>
        {error ? <div className="error">{error}</div> : null}
      </div>
    );
  }

  async function onSignUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      const { error: authError } = await signUp.email({
        name: String(form.get("name") ?? ""),
        email: invitedEmail,
        password: String(form.get("password") ?? ""),
        fetchOptions: { headers: { [INVITATION_TOKEN_HEADER]: token } },
      });
      if (authError) {
        throw new Error(authErrorMessage(authError, locale, "signUp"));
      }
      await accept();
    });
  }

  return (
    <form className="stack" onSubmit={onSignUp}>
      <div className="field">
        <label htmlFor="invite-account-email">{fields("email")}</label>
        <input
          id="invite-account-email"
          type="email"
          value={invitedEmail}
          readOnly
        />
      </div>
      <div className="field">
        <label htmlFor="invite-name">{fields("name")}</label>
        <input
          id="invite-name"
          name="name"
          type="text"
          required
          autoComplete="name"
          disabled={pending}
        />
      </div>
      <div className="field">
        <label htmlFor="invite-password">{fields("password")}</label>
        <input
          id="invite-password"
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
        {pending ? t("creating") : t("createAndJoin")}
      </button>
    </form>
  );
}
