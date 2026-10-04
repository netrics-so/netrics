import type { ConnectionHealth } from "@netrics/contracts";

/**
 * The workspace app shell's map (ADR 0018 section 4, #302): which areas
 * the sidebar lists, where they live, and which one a path belongs to.
 * Only destinations that exist are listed; playlists, schedules, alerts,
 * templates and image libraries join with their features.
 */

export type NavKey =
  | "home"
  | "dashboards"
  | "themes"
  | "sources"
  | "addSource"
  | "screens"
  | "team"
  | "settings";

export type NavSection = "dashboards" | "sources" | "screens";

export interface NavItem {
  key: NavKey;
  href: string;
  /** The group label it is listed under; top-level rows have none. */
  section: NavSection | null;
}

/** What the signed-in member may open (from the role's permissions). */
export interface NavPermissions {
  /** Screens are listed only for roles that may see devices. */
  viewDevices: boolean;
  /** "Add source" only for roles that may create connections. */
  createConnections: boolean;
}

export function workspacePath(workspaceId: string, area = ""): string {
  return `/workspaces/${workspaceId}${area ? `/${area}` : ""}`;
}

/** The sidebar's rows in order. */
export function workspaceNav(
  workspaceId: string,
  permissions: NavPermissions,
): NavItem[] {
  const at = (area: string) => workspacePath(workspaceId, area);
  return [
    { key: "home", href: at(""), section: null },
    { key: "dashboards", href: at("dashboards"), section: "dashboards" },
    { key: "themes", href: at("settings/themes"), section: "dashboards" },
    { key: "sources", href: at("sources"), section: "sources" },
    ...(permissions.createConnections
      ? [
          {
            key: "addSource",
            href: at("connections/new"),
            section: "sources",
          } as const,
        ]
      : []),
    ...(permissions.viewDevices
      ? [{ key: "screens", href: at("screens"), section: "screens" } as const]
      : []),
    { key: "team", href: at("team"), section: null },
    { key: "settings", href: at("settings"), section: null },
  ];
}

/**
 * The area a path belongs to, or null outside this workspace. Pages below
 * an area mark it too: a dashboard and its Studio mark Dashboards, a
 * connection's page marks Sources, a theme marks Themes.
 */
export function activeNavKey(
  pathname: string,
  workspaceId: string,
): NavKey | null {
  const base = workspacePath(workspaceId);
  if (pathname !== base && !pathname.startsWith(`${base}/`)) {
    return null;
  }
  const rest = pathname.slice(base.length).replace(/\/+$/, "");
  const [first = "", second = ""] = rest.split("/").filter(Boolean);
  switch (first) {
    case "":
      return "home";
    case "dashboards":
      return "dashboards";
    case "sources":
      return "sources";
    case "connections":
      return second === "new" ? "addSource" : "sources";
    case "screens":
      return "screens";
    case "team":
      return "team";
    case "settings":
      return second === "themes" ? "themes" : "settings";
    default:
      return null;
  }
}

/** Whether the path is the area's own page, not a page below it. */
export function isNavPage(pathname: string, item: NavItem): boolean {
  return pathname.replace(/\/+$/, "") === item.href;
}

/**
 * How the shell frames a page: the full sidebar, the Studio's icon rail,
 * or no chrome at all for TV mode (it covers the screen).
 */
export type ShellVariant = "full" | "rail" | "none";

export function shellVariant(pathname: string): ShellVariant {
  const path = pathname.replace(/\/+$/, "");
  if (/\/dashboards\/[^/]+\/tv$/.test(path)) {
    return "none";
  }
  if (/\/dashboards\/[^/]+\/studio$/.test(path)) {
    return "rail";
  }
  return "full";
}

/** Connection health states that need someone to act. */
const ATTENTION: ReadonlySet<ConnectionHealth> = new Set([
  "auth_failed",
  "needs_reauthorization",
  "outage",
]);

/**
 * Sources that need attention: failing authentication or an outage, or a
 * setup that was never finished. Never-synced ("pending") ones are on
 * their way and do not count.
 */
export function sourcesNeedingAttention(
  connections: readonly {
    setupPending?: boolean;
    state: { health: ConnectionHealth };
  }[],
): number {
  return connections.filter(
    (connection) =>
      connection.setupPending === true ||
      ATTENTION.has(connection.state.health),
  ).length;
}

/**
 * A TV checks in every five minutes (kiosk heartbeat); seen within three
 * of those it counts as online.
 */
export const ONLINE_WINDOW_MS = 15 * 60 * 1000;

export function isScreenOnline(
  device: { lastSeenAt: string | null; revokedAt: string | null },
  now: number = Date.now(),
): boolean {
  if (device.revokedAt !== null || device.lastSeenAt === null) {
    return false;
  }
  return now - Date.parse(device.lastSeenAt) <= ONLINE_WINDOW_MS;
}
