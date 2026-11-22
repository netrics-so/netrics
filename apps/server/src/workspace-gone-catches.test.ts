import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// #839: "the workspace is deleted" (WorkspaceDeletedError, SQLSTATE WS001)
// must reach the API's error handler and the worker as it is. A catch that
// turns unknown errors into a result, a redacted error or a log line would
// hide it (a 503 "try again" instead of 404), so every such catch in the
// server starts with rethrowWorkspaceGone(error), or handles the case with
// isWorkspaceDeleted(error). This test finds the catches that do neither.
// A catch that only ever rethrows what it caught needs nothing.

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Files whose catches cannot see a tenant transaction fail. */
const EXEMPT: Record<string, string> = {
  "env.ts": "configuration parsing",
  "credentials.ts": "decryption",
  "healthcheck.ts": "process probe",
  "index.ts": "process start",
  "migrate.ts": "migrations, owner role",
  "reencrypt.ts": "operator command, owner role",
  "auth/index.ts": "sign-in, no workspace",
  "oauth/client.ts": "provider HTTP calls",
  "exchange-rates/job.ts": "installation-level job",
  "signed-keys/keys.ts": "key parsing",
  "signed-keys/registry.ts": "key parsing and provider calls",
  "signed-keys/app-store-analytics.ts": "provider calls",
  "signed-keys/app-store-reviews.ts": "provider calls",
  "scheduler.ts": "scheduler role, no tenant transaction",
  "worker.ts": "ends the job itself (isWorkspaceDeleted)",
  "workspaces/purge.ts": "runs for the deleted workspace",
};

/**
 * Catches that swallow on purpose, per file: the best-effort revocation of
 * an unstored grant never throws over the failure that led to it, and an
 * unreadable envelope is not a database error.
 */
const SWALLOWING: Record<string, number> = { "oauth/flow.ts": 3 };

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === "fixtures" ? [] : sources(full);
    return /\.ts$/.test(entry.name) &&
      !/\.test\.ts$|^test-|test-helpers|test-provider/.test(entry.name)
      ? [full]
      : [];
  });
}

/** The catch blocks of a source that neither guard nor purely rethrow. */
function unguarded(source: string): number[] {
  const lines: number[] = [];
  for (const match of source.matchAll(
    /catch\s*(?:\((\w+)(?::[^)]*)?\))?\s*\{/g,
  )) {
    let end = match.index + match[0].length;
    for (let depth = 1; depth > 0 && end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") depth -= 1;
    }
    const body = source.slice(match.index + match[0].length, end - 1).trim();
    const caught = match[1];
    const rethrows =
      caught !== undefined && new RegExp(`throw\\s+${caught}\\s*;$`).test(body);
    const guarded =
      body.includes("rethrowWorkspaceGone(") ||
      body.includes("isWorkspaceDeleted(");
    if (!rethrows && !guarded)
      lines.push(source.slice(0, match.index).split("\n").length);
  }
  return lines;
}

describe("catches that translate errors", () => {
  it("let a deleted workspace through", () => {
    const found: string[] = [];
    for (const file of sources(ROOT)) {
      const relative = path.relative(ROOT, file).split(path.sep).join("/");
      if (relative in EXEMPT) continue;
      const lines = unguarded(readFileSync(file, "utf8"));
      if (lines.length !== (SWALLOWING[relative] ?? 0))
        found.push(`${relative}: lines ${lines.join(", ")}`);
    }
    expect(found).toEqual([]);
  });

  it("recognises a guarded, a rethrowing and an unguarded catch", () => {
    expect(
      unguarded(`
        try { a(); } catch (error) { rethrowWorkspaceGone(error); return 1; }
        try { b(); } catch (error) { log(error); throw error; }
        try { c(); } catch { return null; }
        try { d(); } catch (error) { if (isWorkspaceDeleted(error)) x(); }
      `),
    ).toEqual([4]);
  });
});
