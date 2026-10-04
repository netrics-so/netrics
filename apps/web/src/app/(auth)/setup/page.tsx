import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { SetupForm } from "./setup-form";
import { getSetupStatus } from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("setup");
  return { title: `${t("title")} · netrics` };
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  if (await getSessionUser(cookieHeader)) {
    redirect("/");
  }
  if (!(await getSetupStatus()).setupRequired) {
    redirect("/login");
  }
  const { token } = await searchParams;
  const t = await getT("setup");

  return (
    <>
      <header>
        <h1>{t("title")}</h1>
        <p className="subtitle">{t("subtitle")}</p>
      </header>
      <SetupForm initialToken={typeof token === "string" ? token : ""} />
      <p className="auth-note">{t("tokenHint")}</p>
    </>
  );
}
