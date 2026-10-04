import type { Metadata } from "next";
import Link from "next/link";

import { ForgotPasswordForm } from "./forgot-password-form";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("passwordReset");
  return { title: `${t("forgotTitle")} · netrics` };
}

// Reachable signed out: the only way back in for someone who lost the
// password.
export default async function ForgotPasswordPage() {
  const t = await getT("passwordReset");
  return (
    <>
      <h1>{t("forgotTitle")}</h1>
      <p className="subtitle">{t("forgotSubtitle")}</p>
      <div className="card">
        <ForgotPasswordForm />
      </div>
      <p className="muted">
        {t.rich("remembered", {
          link: (
            <Link key="link" href="/login">
              {t("signIn")}
            </Link>
          ),
        })}
      </p>
    </>
  );
}
