import type { Metadata } from "next";
import Link from "next/link";

import { ResetPasswordForm } from "./reset-password-form";
import { getT } from "@/lib/i18n/server";
import { readResetLink } from "@/lib/password-reset";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("passwordReset");
  return { title: `${t("resetTitle")} · netrics` };
}

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
  const t = await getT("passwordReset");

  return (
    <>
      <h1>{t("resetTitle")}</h1>
      <p className="subtitle">{t("resetSubtitle")}</p>
      <div className="card">
        {link.kind === "ready" ? (
          <ResetPasswordForm token={link.token} />
        ) : (
          <div className="error" role="alert">
            <p>
              {link.kind === "invalid" ? t("invalidLink") : t("missingLink")}
            </p>
            <p>
              <Link href="/forgot-password">{t("requestNew")}</Link>
            </p>
          </div>
        )}
      </div>
      <p className="muted">
        <Link href="/login">{t("backToSignIn")}</Link>
      </p>
    </>
  );
}
