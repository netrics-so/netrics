import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CreateWorkspaceForm } from "./create-workspace-form";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { listWorkspaces } from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { parseOAuthOutcome } from "@/lib/oauth-connection";
import { requireSession } from "@/lib/session";

import "@/app/styles/auth.css";

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
  const query = await searchParams;
  // An OAuth flow that could not name its workspace (expired state, another
  // user's flow) returns here; its message is shown on the workspace page.
  const outcome = parseOAuthOutcome(query.oauth);
  // "New workspace" in the workspace switcher (#302) asks for the form
  // even when the user already has workspaces.
  const creating = query.new !== undefined;

  const first = workspaces[0];
  if (first && !creating) {
    redirect(`/workspaces/${first.id}${outcome ? `?oauth=${outcome}` : ""}`);
  }

  const t = await getT("home");
  return (
    <OnboardingFrame step="workspace">
      <div className="onboarding-panel">
        <header>
          <h1>{first ? t("newTitle") : t("title", { name: user.name })}</h1>
          <p className="subtitle">
            {first ? t("newSubtitle") : t("noWorkspace")}
          </p>
        </header>
        <CreateWorkspaceForm />
      </div>
    </OnboardingFrame>
  );
}
