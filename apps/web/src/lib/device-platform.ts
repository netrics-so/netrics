import type { Device, DevicePlatform } from "@netrics/contracts";

// The device platform in the web app (#406, ADR 0021).

/**
 * A pairing code once it is complete: upper case without spaces and dashes,
 * eight characters, as the server compares it; null before.
 */
export function completePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z0-9]{8}$/.test(code) ? code : null;
}

/**
 * iPads and iPhones know their orientation: the rotation setting applies
 * to Apple TVs and browser kiosks (and devices that report no platform).
 */
export function hasRotationSetting(platform: DevicePlatform | null): boolean {
  return platform !== "ios" && platform !== "ipados";
}

/**
 * Phones and tablets are not expected to be on all the time: the screens
 * list says when they were last opened instead of flagging them offline.
 */
export function isHandheld(platform: Device["platform"]): boolean {
  return platform === "ios" || platform === "ipados";
}

/**
 * The "Connect a TV" page opened from a workspace (and a dashboard): it
 * preselects them instead of the first workspace the person can manage
 * (#835). A TV's QR code opens it with `?code=` alone.
 */
export function connectTvHref(
  workspaceId: string,
  dashboardId?: string | null,
): string {
  const query = new URLSearchParams({ workspace: workspaceId });
  if (dashboardId) query.set("dashboard", dashboardId);
  return `/devices/approve?${query.toString()}`;
}

/**
 * The workspace and dashboard the form starts with: those asked for when
 * the person may pair screens there and the dashboard is offered, else the
 * first workspace and its first dashboard.
 */
export function initialPairingTarget(
  workspaces: ReadonlyArray<{
    id: string;
    dashboards: ReadonlyArray<{ id: string }>;
  }>,
  wanted: {
    workspaceId?: string | undefined;
    dashboardId?: string | undefined;
  },
): { workspaceId: string; dashboardId: string } {
  const workspace =
    workspaces.find((w) => w.id === wanted.workspaceId) ?? workspaces[0]!;
  const dashboard =
    (workspace.id === wanted.workspaceId
      ? workspace.dashboards.find((d) => d.id === wanted.dashboardId)
      : undefined) ?? workspace.dashboards[0];
  return { workspaceId: workspace.id, dashboardId: dashboard?.id ?? "" };
}

/**
 * The approval page's query (#835): the pairing code a TV's QR code
 * brings, and the workspace and dashboard "Connect a TV" was opened from,
 * each one value, cut to its length; `here` is the page again with them,
 * where a sign-in returns to.
 */
export function approveQuery(params: {
  code?: string | string[] | undefined;
  workspace?: string | string[] | undefined;
  dashboard?: string | string[] | undefined;
}): { code: string; workspace: string; dashboard: string; here: string } {
  const one = (value: string | string[] | undefined, length: number) =>
    typeof value === "string" ? value.slice(0, length) : "";
  const code = one(params.code, 20);
  const workspace = one(params.workspace, 64);
  const dashboard = one(params.dashboard, 64);
  const query = new URLSearchParams({
    ...(code ? { code } : {}),
    ...(workspace ? { workspace } : {}),
    ...(dashboard ? { dashboard } : {}),
  }).toString();
  return {
    code,
    workspace,
    dashboard,
    here: `/devices/approve${query ? `?${query}` : ""}`,
  };
}
