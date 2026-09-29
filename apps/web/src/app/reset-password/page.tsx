import Link from "next/link";

import { ResetPasswordForm } from "./reset-password-form";
import { readResetLink } from "@/lib/password-reset";

export const dynamic = "force-dynamic";

// Reached from the emailed link: the API checks the token and redirects here
// with ?token=… (or ?error=INVALID_TOKEN). Reachable signed out.
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{
    token?: string | string[];
    error?: string | string[];
  }>;
}) {
  const link = readResetLink(await searchParams);

  return (
    <>
      <h1>Choose a new password</h1>
      <p className="subtitle">Set the password for your netrics account</p>
      <div className="card">
        {link.kind === "ready" ? (
          <ResetPasswordForm token={link.token} />
        ) : (
          <div className="error" role="alert">
            <p>
              {link.kind === "invalid"
                ? "This reset link is invalid or has expired."
                : "This page needs the link from the reset email."}
            </p>
            <p>
              <Link href="/forgot-password">Request a new link</Link>
            </p>
          </div>
        )}
      </div>
      <p className="muted">
        <Link href="/login">Back to sign in</Link>
      </p>
    </>
  );
}
