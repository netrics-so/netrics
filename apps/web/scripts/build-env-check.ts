/**
 * Web build guard (#160, ADR 0013): the web build has no environment-specific
 * inputs. Builds apps/web twice from a clean `.next`, once with only the
 * build identity (NEXT_PUBLIC_APP_VERSION, NEXT_PUBLIC_GIT_SHA) and once with
 * sample values for every NETRICS_* variable the web app mentions plus
 * WEB_ORIGIN, and fails if the outputs differ: client bundles, prerendered
 * pages and route handlers, server chunks and manifests. A module-scope
 * `process.env` capture in a client component or a static page, a value
 * inlined through next.config, or a page that turns static and renders
 * configuration all show up as a difference.
 *
 * Run from the repository root after building the web app's workspace
 * dependencies: `pnpm web:build-check`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = path.join(webDir, ".next");

// The build identity: commit-specific, not environment-specific. Fixed here
// so both builds get the same values.
const IDENTITY = {
  NEXT_PUBLIC_APP_VERSION: "0.0.0-build-check",
  NEXT_PUBLIC_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
};

// Inputs that must not change the build. Every NETRICS_* name that appears
// in the web app's source is covered automatically; these are added because
// the hosted environment sets them too.
const EXTRA_VARIABLES = ["WEB_ORIGIN", "NETRICS_APP_ORIGIN", "NETRICS_API_URL"];

// Marks sample values so a leak can be named, not only detected.
const MARKER = "netrics-build-check";

// Build output that is not part of the deployed app (cache, traces) or
// duplicates what is compared (standalone copies server/ and node_modules).
const SKIPPED = new Set(["cache", "trace", "trace-build", "standalone"]);

// Random per build: draft-mode and server-action keys.
const RANDOM_KEYS =
  /(\\?"(?:previewModeId|previewModeSigningKey|previewModeEncryptionKey|encryptionKey)\\?"\s*:\s*\\?")[^"\\]*/g;

function sampleValue(name: string): string {
  const host = `${name.toLowerCase().replaceAll("_", "-")}.${MARKER}.invalid`;
  if (/_(URL|ORIGIN)$/.test(name)) return `https://${host}`;
  if (name.endsWith("_HOST")) return host;
  if (name.endsWith("_HOPS")) return "3";
  if (name.endsWith("_HEADER")) return `x-${MARKER}-client-ip`;
  if (name.endsWith("_LOCALE")) return "de";
  if (name.endsWith("_PROXIES")) return "203.0.113.0/24";
  return `${MARKER}-${name.toLowerCase()}`;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function webVariables(): string[] {
  const names = new Set(EXTRA_VARIABLES);
  for (const file of [
    ...sourceFiles(path.join(webDir, "src")),
    path.join(webDir, "next.config.ts"),
  ]) {
    for (const [name] of readFileSync(file, "utf8").matchAll(
      /\bNETRICS_[A-Z0-9_]*[A-Z0-9]\b/g,
    )) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * The caller's environment without anything that could configure the app,
 * so a developer's shell cannot leak into either build.
 */
function baseEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(NETRICS_|NEXT_PUBLIC_|WEB_ORIGIN$)/.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    ...IDENTITY,
  };
}

type Snapshot = Map<string, Buffer>;

function build(label: string, env: NodeJS.ProcessEnv): Snapshot {
  console.log(`\n== web build: ${label}\n`);
  rmSync(nextDir, { recursive: true, force: true });
  const result = spawnSync("pnpm", ["exec", "next", "build"], {
    cwd: webDir,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`next build (${label}) failed with ${result.status}`);
  }
  const buildId = readFileSync(path.join(nextDir, "BUILD_ID"), "utf8").trim();
  const snapshot: Snapshot = new Map();
  for (const entry of readdirSync(nextDir, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(nextDir, file);
    if (SKIPPED.has(relative.split(path.sep)[0]!) || relative === "BUILD_ID") {
      continue;
    }
    // latin1 maps bytes one to one, so binary files survive the round trip.
    const text = readFileSync(file)
      .toString("latin1")
      .replaceAll(buildId, "<build-id>")
      .replace(RANDOM_KEYS, "$1<random>");
    snapshot.set(
      relative.replaceAll(buildId, "<build-id>"),
      Buffer.from(text, "latin1"),
    );
  }
  return snapshot;
}

function digest(snapshot: Snapshot): string {
  const hash = createHash("sha256");
  for (const file of [...snapshot.keys()].sort()) {
    hash.update(`${file}\0`);
    hash.update(createHash("sha256").update(snapshot.get(file)!).digest());
  }
  return hash.digest("hex");
}

function firstDifference(a: Buffer, b: Buffer): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const excerpt = (buffer: Buffer) =>
    JSON.stringify(buffer.subarray(Math.max(0, i - 80), i + 120).toString());
  return `    baseline:   ${excerpt(a)}\n    configured: ${excerpt(b)}`;
}

function compare(baseline: Snapshot, configured: Snapshot): string[] {
  const problems: string[] = [];
  for (const file of new Set([...baseline.keys(), ...configured.keys()])) {
    const a = baseline.get(file);
    const b = configured.get(file);
    if (!a) problems.push(`  only in the configured build: ${file}`);
    else if (!b) problems.push(`  only in the baseline build: ${file}`);
    else if (!a.equals(b)) {
      problems.push(`  differs: ${file}\n${firstDifference(a, b)}`);
    }
  }
  return problems.sort();
}

function leaks(snapshot: Snapshot, samples: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(samples)) {
    if (!value.includes(MARKER)) continue;
    for (const [file, content] of snapshot) {
      if (content.includes(value)) found.push(`  ${name} in ${file}`);
    }
  }
  return found;
}

const samples = Object.fromEntries(
  webVariables().map((name) => [name, sampleValue(name)]),
);
console.log("Sample configuration for the second build:");
for (const [name, value] of Object.entries(samples)) {
  console.log(`  ${name}=${value}`);
}

const baseline = build("identity only", baseEnv());
const configured = build("identity and sample configuration", {
  ...baseEnv(),
  ...samples,
});

console.log(
  `\nCompared ${baseline.size} files.\n  baseline:   ${digest(baseline)}\n  configured: ${digest(configured)}`,
);
const problems = [
  ...leaks(configured, samples),
  ...compare(baseline, configured),
];
if (problems.length > 0) {
  console.error(
    [
      "",
      "The web build depends on its environment: configuration must be read at",
      "request time, not at build time (ADR 0013, docs/release.md).",
      ...problems,
    ].join("\n"),
  );
  process.exit(1);
}
console.log("The web build has no environment-specific inputs.");
