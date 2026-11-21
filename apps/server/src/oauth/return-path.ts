// Where an OAuth flow may send the browser back to (ADR 0012): an allowlist
// of web app routes, matched whole, inside the workspace the authorization
// belongs to. No query, fragment, encoded characters or dot segments, so a
// return path can never become another origin ("//evil", "/\evil") or a
// different page than the one named.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** App routes an OAuth flow may return to; group 1 is the workspace id. */
const RETURN_ROUTES: readonly RegExp[] = [
  new RegExp(`^/workspaces/(${UUID})$`),
  new RegExp(`^/workspaces/(${UUID})/connections/new$`),
  new RegExp(`^/workspaces/(${UUID})/connections/${UUID}$`),
  // The custom API builder (#805): a draft's sign-in returns to it.
  new RegExp(`^/workspaces/(${UUID})/custom-apis/new$`),
  new RegExp(`^/workspaces/(${UUID})/custom-apis/${UUID}$`),
];

const BUILDER_ROUTE = new RegExp(
  `^/workspaces/${UUID}/custom-apis/(?:new|${UUID})$`,
);

/** Whether `path` is a custom API builder page (it reopens a draft). */
export function isBuilderReturnPath(path: string): boolean {
  return BUILDER_ROUTE.test(path);
}

/** Whether `path` is an allowed return path for this workspace. */
export function isAllowedReturnPath(
  path: string,
  workspaceId: string,
): boolean {
  for (const route of RETURN_ROUTES) {
    const match = route.exec(path);
    if (match) {
      return match[1] === workspaceId.toLowerCase();
    }
  }
  return false;
}

/** Where a flow returns when the caller names no path. */
export function defaultReturnPath(
  workspaceId: string,
  connectionId: string | null,
): string {
  return connectionId
    ? `/workspaces/${workspaceId}/connections/${connectionId}`
    : `/workspaces/${workspaceId}/connections/new`;
}

/** The return path with the flow's outcome in its query. */
export function withOutcome(
  path: string,
  params: Record<string, string>,
): string {
  return `${path}?${new URLSearchParams(params).toString()}`;
}
