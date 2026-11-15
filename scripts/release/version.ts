/**
 * The version a main build reports (#646): baked into the images as
 * APP_VERSION / NEXT_PUBLIC_APP_VERSION by `.github/workflows/release.yml`,
 * and shown on /health/live, /healthz, the migrate log and in schema_info.
 *
 * Tagging never rebuilds (docs/release.md), so the build cannot know whether
 * its commit will be tagged. The commit that changes the root package.json
 * version is the one a release tag goes on (promote.yml checks this): it
 * reports `X.Y.Z`. Every later main commit with the same package.json
 * version is not that release, and reports `X.Y.Z+<commit>` (semver build
 * metadata, first 12 characters of the commit).
 *
 * Dependency-free; Node 26 runs this file as is. Needs the parent commit
 * (actions/checkout with fetch-depth: 2):
 *
 *   node scripts/release/version.ts      prints the version of HEAD
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;

export function buildVersion(input: {
  /** package.json version at this commit. */
  version: string;
  /** package.json version at the parent commit. */
  parentVersion: string;
  /** Full commit SHA. */
  commit: string;
}): string {
  if (!RELEASE_VERSION.test(input.version)) {
    throw new Error(
      `package.json version ${JSON.stringify(input.version)} is not X.Y.Z`,
    );
  }
  if (!COMMIT.test(input.commit)) {
    throw new Error(`commit ${JSON.stringify(input.commit)} is not a full SHA`);
  }
  if (input.version !== input.parentVersion) return input.version;
  return `${input.version}+${input.commit.slice(0, 12)}`;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function packageVersion(revision: string): string {
  const json = JSON.parse(git("show", `${revision}:package.json`)) as {
    version?: unknown;
  };
  return typeof json.version === "string" ? json.version : "";
}

function main(): void {
  let parentVersion: string;
  try {
    parentVersion = packageVersion("HEAD^");
  } catch {
    throw new Error(
      "the parent commit is not available; check out with fetch-depth: 2",
    );
  }
  console.log(
    buildVersion({
      version: packageVersion("HEAD"),
      parentVersion,
      commit: git("rev-parse", "HEAD"),
    }),
  );
}

const invokedDirectly =
  import.meta.main ??
  (process.argv[1] !== undefined &&
    pathToFileURL(process.argv[1]).href === import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      process.env.GITHUB_ACTIONS ? `::error::${message}` : `error: ${message}`,
    );
    process.exit(1);
  }
}
