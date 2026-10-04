import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CreateWorkspaceForm } from "./create-workspace-form";
import { listWorkspaces } from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { parseOAuthOutcome } from "@/lib/oauth-connection";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("home");
  return { title: `${t("pageTitle")} · netrics` };
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { cookieHeader, user } = await requireSession();
  const { workspaces } = await listWorkspaces(cookieHeader);
  // An OAuth flow that could not name its workspace (expired state, another
  // user's flow) returns here; its message is shown on the workspace page.
  const outcome = parseOAuthOutcome((await searchParams).oauth);

  const first = workspaces[0];
  if (first) {
    redirect(`/workspaces/${first.id}${outcome ? `?oauth=${outcome}` : ""}`);
  }

  const t = await getT("home");
  return (
    <>
      <h1>{t("title", { name: user.name })}</h1>
      <p className="subtitle">{t("noWorkspace")}</p>
      <div className="card">
        <CreateWorkspaceForm />
      </div>
    </>
  );
}
