import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SignupForm } from "./signup-form";
import { getSetupStatus } from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("signup");
  return { title: `${t("title")} · netrics` };
}

export default async function SignupPage() {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  if (await getSessionUser(cookieHeader)) {
    redirect("/");
  }
  const setup = await getSetupStatus();
  if (setup.setupRequired) {
    redirect("/setup");
  }
  const t = await getT("signup");
  if (setup.signup === "closed") {
    return (
      <>
        <header>
          <h1>{t("closedTitle")}</h1>
          <p className="subtitle">{t("closedText")}</p>
        </header>
        <p className="auth-links">
          {t.rich("haveAccount", {
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

  return (
    <>
      <header>
        <h1>{t("title")}</h1>
        <p className="subtitle">{t("subtitle")}</p>
      </header>
      <SignupForm />
      <p className="auth-links">
        {t.rich("haveAccount", {
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
