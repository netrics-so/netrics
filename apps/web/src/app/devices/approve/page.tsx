import Link from "next/link";
import { redirect } from "next/navigation";

import { can } from "@netrics/domain";

import { ApproveDeviceForm, type ApprovableWorkspace } from "./approve-form";
import { listDashboards, listWorkspaces } from "@/lib/api";
import { getSessionUser } from "@/lib/session";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

interface ApproveDevicePageProps {
  searchParams: Promise<{ code?: string | string[] }>;
}

/**
 * Where a TV sends people to approve its pairing code (ADR 0010). The TV's
 * QR code and the hosted netrics.tv/link address land here with ?code=.
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

  return (
    <>
      <h1>Connect a TV</h1>
      <p className="subtitle">
        Enter the code shown on the TV and choose what it should show.
      </p>
      {approvable.length === 0 ? (
        <div className="card">
          <p>
            Only workspace owners and admins can connect TVs. Ask one of them to
            enter the code, or to make you an admin.
          </p>
          <p className="muted">
            <Link href="/">Back</Link>
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
