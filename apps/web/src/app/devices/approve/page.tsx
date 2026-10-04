import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { can } from "@netrics/domain";

import { ApproveDeviceForm, type ApprovableWorkspace } from "./approve-form";
import { listDashboards, listWorkspaces } from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { getSessionUser } from "@/lib/session";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("deviceApproval");
  return { title: t("pageTitle") };
}

interface ApproveDevicePageProps {
  searchParams: Promise<{ code?: string | string[] }>;
}

/**
 * Where a TV sends people to approve its pairing code (ADR 0010). The TV's
 * QR code lands here with ?code=; on the hosted service via netrics.tv/<CODE>
 * (see src/proxy.ts).
 */
export default async function ApproveDevicePage({
  searchParams,
}: ApproveDevicePageProps) {
  const raw = (await searchParams).code;
  const code = typeof raw === "string" ? raw.slice(0, 20) : "";
  const here = `/devices/approve${code ? `?code=${encodeURIComponent(code)}` : ""}`;

  const cookieHeader = (await headers()).get("cookie") ?? "";
  const user = await getSessionUser(cookieHeader);
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }

  const { workspaces } = await listWorkspaces(cookieHeader);
  const manageable = workspaces.filter((workspace) =>
    can(workspace.role, "devices:manage"),
  );
  const approvable: ApprovableWorkspace[] = await Promise.all(
    manageable.map(async (workspace) => ({
      id: workspace.id,
      name: workspace.name,
      dashboards: (
        await listDashboards(cookieHeader, workspace.id)
      ).dashboards.map((dashboard) => ({
        id: dashboard.id,
        name: dashboard.name,
      })),
    })),
  );

  const t = await getT("deviceApproval");
  const common = await getT("common");
  return (
    <>
      <h1>{t("title")}</h1>
      <p className="subtitle">{t("subtitle")}</p>
      {approvable.length === 0 ? (
        <div className="card">
          <p>{t("notAllowed")}</p>
          <p className="muted">
            <Link href="/">{common("back")}</Link>
          </p>
        </div>
      ) : (
        <div className="card">
          <ApproveDeviceForm initialCode={code} workspaces={approvable} />
        </div>
      )}
    </>
  );
}
