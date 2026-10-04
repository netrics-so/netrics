import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { LoginForm } from "./login-form";
import { getSetupStatus } from "@/lib/api";
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
  const cookieHeader = (await headers()).get("cookie") ?? "";
  if (await getSessionUser(cookieHeader)) {
    redirect(next);
  }
  const setup = await getSetupStatus();
  if (setup.setupRequired) {
    redirect("/setup");
  }

  const t = await getT("login");
  return (
    <>
      <h1>{t("title")}</h1>
      <p className="subtitle">{t("subtitle")}</p>
      <div className="card">
        <LoginForm next={next} />
      </div>
      <p className="muted">
        <Link href="/forgot-password">{t("forgot")}</Link>
      </p>
      {setup.signup === "open" ? (
        <p className="muted">
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
