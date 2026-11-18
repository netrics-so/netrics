import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { LoginForm } from "./login-form";
import { getSetupStatus } from "@/lib/api";
import { forwardedHeaders } from "@/lib/api-fetch";
import { getT } from "@/lib/i18n/server";
import { safeNextPath } from "@/lib/next-path";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("login");
  return { title: `${t("title")} · netrics` };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = safeNextPath((await searchParams).next) ?? "/";
  const forwarded = forwardedHeaders(await headers());
  if (await getSessionUser(forwarded)) {
    redirect(next);
  }
  const setup = await getSetupStatus();
  if (setup.setupRequired) {
    redirect("/setup");
  }

  const t = await getT("login");
  return (
    <>
      <header>
        <h1>{t("heading")}</h1>
        <p className="subtitle">{t("subtitle")}</p>
      </header>
      <LoginForm next={next} />
      {setup.signup === "open" ? (
        <p className="auth-links">
          {t.rich("noAccount", {
            link: (
              <Link key="link" href="/signup">
                {t("createOne")}
              </Link>
            ),
          })}
        </p>
      ) : null}
    </>
  );
}
