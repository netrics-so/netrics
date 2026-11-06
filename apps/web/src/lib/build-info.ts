/**
 * The web build's identity: release version and commit, the build arguments
 * NEXT_PUBLIC_APP_VERSION and NEXT_PUBLIC_GIT_SHA (the same values the
 * server image gets as APP_VERSION / GIT_SHA). They identify the commit and
 * are not environment-specific (ADR 0013). Read on the server only; unset or
 * empty in a local build, they fall back to the API's own placeholders.
 */
export interface BuildInfo {
  version: string;
  commit: string;
}

export function buildInfo(): BuildInfo {
  return {
    version: process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0-dev",
    commit: process.env.NEXT_PUBLIC_GIT_SHA || "dev",
  };
}
