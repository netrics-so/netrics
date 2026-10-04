import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { ScreenStep } from "@/components/onboarding/screen-step";
import { SourceStep } from "@/components/onboarding/source-step";
import {
  listConnections,
  listConnectors,
  listDashboards,
  listWorkspaces,
} from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { hasDemoSource, hasRealSource, onboardingStep } from "@/lib/onboarding";
import { requireSession } from "@/lib/session";

import "@/app/styles/auth.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("onboarding");
  return { title: `${t("pageTitle")} · netrics` };
}

interface WelcomePageProps {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ step?: string | string[] }>;
}

/**
 * Steps 2 and 3 of the first run (#308), right after the workspace is
 * created. Full screen like step 1 (the home page), outside the app shell:
 * this route group has its own tree, so the workspace layout does not wrap
 * it. The step follows from the workspace: no real source yet is step 2,
 * otherwise (or after "Skip") step 3.
 */
export default async function WelcomePage({
  params,
  searchParams,
}: WelcomePageProps) {
  const { workspaceId } = await params;
  const { step: requested } = await searchParams;
  const { cookieHeader } = await requireSession();
  const { workspaces } = await listWorkspaces(cookieHeader);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership) {
    notFound();
  }
  const [{ connections }, { dashboards }] = await Promise.all([
    listConnections(cookieHeader, workspaceId),
    listDashboards(cookieHeader, workspaceId),
  ]);
  const canConnect = can(membership.role, "connections:create");
  const step = onboardingStep({
    hasWorkspace: true,
    connections,
    canConnect,
    requested: typeof requested === "string" ? requested : null,
  });

  if (step === "source") {
    const { connectors } = await listConnectors(cookieHeader);
    return (
      <OnboardingFrame step="source">
        <SourceStep
          workspaceId={workspaceId}
          connectors={connectors}
          hasDemo={hasDemoSource(connections)}
        />
      </OnboardingFrame>
    );
  }

  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "";
  return (
    <OnboardingFrame step="screen">
      <ScreenStep
        workspaceId={workspaceId}
        dashboardId={dashboards[0]?.id ?? null}
        kioskUrl={`${host}/kiosk`}
        canManageDevices={can(membership.role, "devices:manage")}
        suggestSource={canConnect && !hasRealSource(connections)}
      />
    </OnboardingFrame>
  );
}
