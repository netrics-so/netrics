/**
 * App Store Connect step of the netrics TV release (#434,
 * `.github/workflows/netrics-tv-release.yml`). Dependency-free: Node 24 runs
 * this file as is (type stripping), with the built-in `crypto` for the ES256
 * token and the built-in `fetch`. It talks to the App Store Connect API v1.
 *
 *   node asc-submit.ts version netrics-tv/v1.2.3   prints 1.2.3, or fails
 *   node asc-submit.ts build-number                prints the build number
 *   node asc-submit.ts run --version 1.2.3 --build 20261030.1530 \
 *     [--platforms IOS,TV_OS] [--submit] [--notes-file notes.md] \
 *     [--bundle-id tv.netrics] [--timeout-minutes 60]
 *
 * `run` reads the API key from ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH
 * (the .p8 file). For each platform it waits until the uploaded build is
 * processed (VALID). Without --submit that is all (TestFlight). With
 * --submit it then finds or creates the App Store version, attaches the
 * build, writes the release notes to "What's New" of every localization and
 * submits the version for App Review. Every step is idempotent, so a re-run
 * continues where a failed run stopped. Neither the key nor the token is
 * ever logged.
 */
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const API_BASE = "https://api.appstoreconnect.apple.com";
export const TAG_PREFIX = "netrics-tv/v";
export const PLATFORMS = ["IOS", "TV_OS"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Apple's limit for "What's New" (whatsNew), in characters. */
export const WHATS_NEW_MAX = 4000;

/** Apple allows tokens of at most 20 minutes; a fresh one is made earlier. */
const TOKEN_LIFETIME_SECONDS = 15 * 60;
const TOKEN_REFRESH_MARGIN_SECONDS = 60;

// ---------------------------------------------------------------- pure parts

const NUMBER = "(0|[1-9][0-9]*)";
const TAG_PATTERN = new RegExp(
  `^netrics-tv/v(${NUMBER}\\.${NUMBER}\\.${NUMBER})$`,
);

/**
 * The version of a release tag: `netrics-tv/v1.2.3` is `1.2.3`. Strict
 * semver without pre-release or build suffixes and without leading zeros,
 * because App Store versions are period-separated integers only.
 */
export function parseTag(tag: string): string {
  const match = TAG_PATTERN.exec(tag);
  if (!match?.[1]) {
    throw new Error(
      `"${tag}" is not a netrics TV release tag (${TAG_PREFIX}X.Y.Z, for example ${TAG_PREFIX}1.2.0)`,
    );
  }
  return match[1];
}

/**
 * The build number (CFBundleVersion) of a run: the UTC date and time,
 * `YYYYMMDD.HHMM` with the time as a plain integer (09:05 is `905`), so
 * 2026-10-30 15:30 is `20261030.1530`. It only grows, across runs, re-runs
 * and versions, and both components stay well inside 32 bits. Two runs
 * cannot start the same minute: the workflow runs one release at a time
 * and an archive takes longer than that.
 */
export function buildNumber(date: Date): string {
  const day =
    date.getUTCFullYear() * 10000 +
    (date.getUTCMonth() + 1) * 100 +
    date.getUTCDate();
  return `${day}.${date.getUTCHours() * 100 + date.getUTCMinutes()}`;
}

/** Apple's rule: one to three period-separated non-negative integers. */
export function isValidBuildNumber(value: string): boolean {
  return /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,2}$/.test(value);
}

/**
 * Release notes as App Store "What's New" text: line endings normalised,
 * HTML comments (GitHub's release templates) removed, runs of blank lines
 * collapsed, trimmed, and cut to Apple's 4000 characters at a code point
 * boundary with an ellipsis.
 */
export function whatsNewFromReleaseNotes(body: string): string {
  const text = body
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chars = Array.from(text);
  if (chars.length <= WHATS_NEW_MAX) return text;
  return `${chars
    .slice(0, WHATS_NEW_MAX - 1)
    .join("")
    .trimEnd()}…`;
}

const base64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

/** Header and claims of an App Store Connect API token. */
export function tokenParts(
  keyId: string,
  issuerId: string,
  nowSeconds: number,
): {
  header: { alg: "ES256"; kid: string; typ: "JWT" };
  claims: { iss: string; iat: number; exp: number; aud: string };
} {
  return {
    header: { alg: "ES256", kid: keyId, typ: "JWT" },
    claims: {
      iss: issuerId,
      iat: nowSeconds,
      exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
      aud: "appstoreconnect-v1",
    },
  };
}

/**
 * An ES256 JWT. JOSE wants the raw r||s signature (64 bytes), not the DER
 * that `crypto.sign` returns by default, hence `ieee-p1363`.
 */
export function createToken(
  key: KeyObject,
  keyId: string,
  issuerId: string,
  nowSeconds: number,
): string {
  const { header, claims } = tokenParts(keyId, issuerId, nowSeconds);
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(input), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${base64url(signature)}`;
}

// App Store version states in which the version and its metadata can still
// change (appVersionState; the older appStoreState has the same names).
const EDITABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);
const IN_REVIEW_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW"]);
// READY_FOR_REVIEW: in a review submission that was not submitted yet (a
// failed earlier run); it still takes a build and notes.
const SUBMITTABLE_STATES = new Set([...EDITABLE_STATES, "READY_FOR_REVIEW"]);

interface Resource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<
    string,
    { data?: { id: string; type: string } | null } | undefined
  >;
}

export function versionState(version: Resource): string {
  const state =
    version.attributes?.appVersionState ?? version.attributes?.appStoreState;
  return typeof state === "string" ? state : "UNKNOWN";
}

// ------------------------------------------------------------------- client

export class AscError extends Error {
  readonly status: number;
  readonly errors: { code?: string; title?: string; detail?: string }[];

  constructor(
    method: string,
    path: string,
    status: number,
    errors: { code?: string; title?: string; detail?: string }[],
  ) {
    const details = errors
      .map((e) => [e.code, e.detail ?? e.title].filter(Boolean).join(": "))
      .join("; ");
    super(
      `${method} ${path.split("?")[0]} failed with HTTP ${status}${details ? `: ${details}` : ""}`,
    );
    this.status = status;
    this.errors = errors;
  }
}

export interface ClientOptions {
  keyId: string;
  issuerId: string;
  privateKey: KeyObject;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export class AppStoreConnect {
  readonly #options: Required<ClientOptions>;
  #token: { value: string; exp: number } | undefined;

  constructor(options: ClientOptions) {
    this.#options = {
      fetch: globalThis.fetch,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (line) => console.log(line),
      ...options,
    };
  }

  get log() {
    return this.#options.log;
  }
  get sleep() {
    return this.#options.sleep;
  }
  get now() {
    return this.#options.now;
  }

  #bearer(): string {
    const nowSeconds = Math.floor(this.#options.now() / 1000);
    if (
      !this.#token ||
      this.#token.exp - TOKEN_REFRESH_MARGIN_SECONDS <= nowSeconds
    ) {
      const { keyId, issuerId, privateKey } = this.#options;
      this.#token = {
        value: createToken(privateKey, keyId, issuerId, nowSeconds),
        exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
      };
    }
    return this.#token.value;
  }

  /** One API call; retries rate limits and server errors a few times. */
  async request<T = { data: Resource | Resource[]; included?: Resource[] }>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T | undefined> {
    for (let attempt = 1; ; attempt++) {
      const response = await this.#options.fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#bearer()}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 204) return undefined;
      const text = await response.text();
      if (response.ok) return text ? (JSON.parse(text) as T) : undefined;
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        this.log(
          `  ${method} ${path.split("?")[0]}: HTTP ${response.status}, retrying`,
        );
        await this.sleep(attempt * 5000);
        continue;
      }
      let errors: { code?: string; title?: string; detail?: string }[] = [];
      try {
        errors = (JSON.parse(text) as { errors?: typeof errors }).errors ?? [];
      } catch {
        // Not JSON: the status says enough.
      }
      throw new AscError(method, path, response.status, errors);
    }
  }

  async list(
    path: string,
  ): Promise<{ data: Resource[]; included: Resource[] }> {
    const result = await this.request<{
      data: Resource[];
      included?: Resource[];
    }>("GET", path);
    return { data: result?.data ?? [], included: result?.included ?? [] };
  }
}

const query = (params: Record<string, string>) =>
  new URLSearchParams(params).toString();

// -------------------------------------------------------------------- steps

export async function findApp(
  asc: AppStoreConnect,
  bundleId: string,
): Promise<string> {
  const { data } = await asc.list(
    `/v1/apps?${query({ "filter[bundleId]": bundleId, "fields[apps]": "bundleId,name", limit: "10" })}`,
  );
  // The filter also matches longer identifiers; take the exact one.
  const app = data.find((a) => a.attributes?.bundleId === bundleId);
  if (!app) {
    throw new Error(
      `No App Store Connect app with the bundle ID ${bundleId}. Create the app record first (docs/release.md).`,
    );
  }
  asc.log(`App ${String(app.attributes?.name ?? bundleId)} (${bundleId})`);
  return app.id;
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
}

/** Waits until App Store Connect has processed the uploaded build. */
export async function waitForBuild(
  asc: AppStoreConnect,
  appId: string,
  platform: Platform,
  version: string,
  build: string,
  { timeoutMs, intervalMs }: WaitOptions,
): Promise<string> {
  const path = `/v1/builds?${query({
    "filter[app]": appId,
    "filter[version]": build,
    "filter[preReleaseVersion.version]": version,
    "filter[preReleaseVersion.platform]": platform,
    "fields[builds]": "version,processingState",
    limit: "1",
  })}`;
  const started = asc.now();
  let last = "";
  for (;;) {
    const { data } = await asc.list(path);
    const found = data[0];
    const state = found
      ? String(found.attributes?.processingState ?? "UNKNOWN")
      : "NOT_VISIBLE_YET";
    const minutes = Math.floor((asc.now() - started) / 60000);
    if (state !== last || minutes % 5 === 0) {
      asc.log(
        `  ${platform} build ${version} (${build}): ${state} after ${minutes} min`,
      );
    }
    last = state;
    if (found && state === "VALID") return found.id;
    if (state === "FAILED" || state === "INVALID") {
      throw new Error(
        `${platform} build ${version} (${build}) is ${state}; App Store Connect sends the reasons by e-mail and shows them under TestFlight.`,
      );
    }
    if (asc.now() - started >= timeoutMs) {
      throw new Error(
        `${platform} build ${version} (${build}) is still ${state} after ${Math.round(timeoutMs / 60000)} min; re-run the job to keep waiting.`,
      );
    }
    await asc.sleep(intervalMs);
  }
}

/**
 * The App Store version `version` of a platform: the existing one, else the
 * editable version renamed to it (there is at most one per platform), else
 * a new one.
 */
export async function ensureVersion(
  asc: AppStoreConnect,
  appId: string,
  platform: Platform,
  version: string,
): Promise<{ id: string; state: string }> {
  const { data } = await asc.list(
    `/v1/apps/${appId}/appStoreVersions?${query({
      "filter[platform]": platform,
      "fields[appStoreVersions]":
        "versionString,appVersionState,appStoreState,platform",
      limit: "200",
    })}`,
  );
  const existing = data.find((v) => v.attributes?.versionString === version);
  if (existing) {
    const state = versionState(existing);
    asc.log(`  ${platform} version ${version} exists (${state})`);
    return { id: existing.id, state };
  }
  const editable = data.find((v) => EDITABLE_STATES.has(versionState(v)));
  if (editable) {
    asc.log(
      `  ${platform}: renaming the editable version ${String(editable.attributes?.versionString)} to ${version}`,
    );
    await asc.request("PATCH", `/v1/appStoreVersions/${editable.id}`, {
      data: {
        type: "appStoreVersions",
        id: editable.id,
        attributes: { versionString: version },
      },
    });
    return { id: editable.id, state: versionState(editable) };
  }
  asc.log(`  ${platform}: creating version ${version}`);
  const created = await asc.request<{ data: Resource }>(
    "POST",
    "/v1/appStoreVersions",
    {
      data: {
        type: "appStoreVersions",
        attributes: { platform, versionString: version },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    },
  );
  if (!created) throw new Error("App Store Connect returned no version");
  return { id: created.data.id, state: versionState(created.data) };
}

export async function attachBuild(
  asc: AppStoreConnect,
  versionId: string,
  buildId: string,
): Promise<void> {
  await asc.request(
    "PATCH",
    `/v1/appStoreVersions/${versionId}/relationships/build`,
    { data: { type: "builds", id: buildId } },
  );
}

/**
 * Writes "What's New" to every localization of the version (App Review
 * needs it in each one of an update; netrics TV has en-US and de-DE). The
 * first version of an app has no "What's New": Apple refuses the field, and
 * that is logged, not fatal.
 */
export async function setWhatsNew(
  asc: AppStoreConnect,
  platform: Platform,
  versionId: string,
  whatsNew: string,
): Promise<void> {
  if (!whatsNew) {
    asc.log(`  ${platform}: no release notes, "What's New" left as it is`);
    return;
  }
  const { data } = await asc.list(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?${query({
      "fields[appStoreVersionLocalizations]": "locale,whatsNew",
      limit: "50",
    })}`,
  );
  if (data.length === 0) {
    asc.log(`  ${platform}: the version has no localizations yet`);
  }
  for (const localization of data) {
    const locale = String(localization.attributes?.locale);
    try {
      await asc.request(
        "PATCH",
        `/v1/appStoreVersionLocalizations/${localization.id}`,
        {
          data: {
            type: "appStoreVersionLocalizations",
            id: localization.id,
            attributes: { whatsNew },
          },
        },
      );
      asc.log(`  ${platform}: "What's New" set for ${locale}`);
    } catch (error) {
      if (error instanceof AscError && error.status === 409) {
        asc.log(
          `  ${platform}: "What's New" not accepted for ${locale} (the first version of an app has none): ${error.message}`,
        );
        continue;
      }
      throw error;
    }
  }
}

/** Submits the version for App Review through a review submission. */
export async function submitForReview(
  asc: AppStoreConnect,
  appId: string,
  platform: Platform,
  versionId: string,
): Promise<void> {
  const { data: open } = await asc.list(
    `/v1/reviewSubmissions?${query({
      "filter[app]": appId,
      "filter[platform]": platform,
      "filter[state]":
        "READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES",
      limit: "10",
    })}`,
  );
  const itemsOf = async (submissionId: string) => {
    const { data } = await asc.list(
      `/v1/reviewSubmissions/${submissionId}/items?${query({
        include: "appStoreVersion",
        limit: "50",
      })}`,
    );
    return data;
  };
  const hasVersion = (items: Resource[]) =>
    items.some((i) => i.relationships?.appStoreVersion?.data?.id === versionId);

  for (const submission of open) {
    const state = String(submission.attributes?.state);
    if (state === "WAITING_FOR_REVIEW" || state === "IN_REVIEW") {
      if (hasVersion(await itemsOf(submission.id))) {
        asc.log(`  ${platform}: already submitted (${state})`);
        return;
      }
      throw new Error(
        `${platform}: another review submission is ${state}; wait for it or cancel it in App Store Connect, then re-run.`,
      );
    }
  }

  let submission = open.find((s) =>
    ["READY_FOR_REVIEW", "UNRESOLVED_ISSUES"].includes(
      String(s.attributes?.state),
    ),
  );
  if (submission) {
    asc.log(`  ${platform}: reusing the open review submission`);
  } else {
    const created = await asc.request<{ data: Resource }>(
      "POST",
      "/v1/reviewSubmissions",
      {
        data: {
          type: "reviewSubmissions",
          attributes: { platform },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      },
    );
    if (!created) throw new Error("App Store Connect returned no submission");
    submission = created.data;
    asc.log(`  ${platform}: review submission created`);
  }

  if (!hasVersion(await itemsOf(submission.id))) {
    await asc.request("POST", "/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: {
            data: { type: "reviewSubmissions", id: submission.id },
          },
          appStoreVersion: {
            data: { type: "appStoreVersions", id: versionId },
          },
        },
      },
    });
    asc.log(`  ${platform}: version added to the submission`);
  }

  await asc.request("PATCH", `/v1/reviewSubmissions/${submission.id}`, {
    data: {
      type: "reviewSubmissions",
      id: submission.id,
      attributes: { submitted: true },
    },
  });
  asc.log(`  ${platform}: submitted for App Review`);
}

export interface RunOptions {
  bundleId: string;
  version: string;
  build: string;
  platforms: Platform[];
  submit: boolean;
  whatsNew: string;
  wait: WaitOptions;
}

/**
 * Waits for every platform's build first, so a failed build of one platform
 * submits neither; then attaches, describes and submits each.
 */
export async function run(
  asc: AppStoreConnect,
  options: RunOptions,
): Promise<void> {
  const { bundleId, version, build, platforms, submit } = options;
  const appId = await findApp(asc, bundleId);

  const builds = new Map<Platform, string>();
  for (const platform of platforms) {
    asc.log(`Waiting for the ${platform} build to be processed`);
    builds.set(
      platform,
      await waitForBuild(asc, appId, platform, version, build, options.wait),
    );
  }
  if (!submit) {
    asc.log(`Builds ${version} (${build}) are processed and in TestFlight.`);
    return;
  }

  for (const platform of platforms) {
    asc.log(`Submitting ${platform} ${version} for App Review`);
    const appStoreVersion = await ensureVersion(asc, appId, platform, version);
    if (IN_REVIEW_STATES.has(appStoreVersion.state)) {
      asc.log(
        `  ${platform}: version is ${appStoreVersion.state}, nothing to do`,
      );
      continue;
    }
    if (!SUBMITTABLE_STATES.has(appStoreVersion.state)) {
      throw new Error(
        `${platform} version ${version} is ${appStoreVersion.state} and can no longer change; release a new version.`,
      );
    }
    await attachBuild(asc, appStoreVersion.id, builds.get(platform) ?? "");
    asc.log(`  ${platform}: build ${build} attached`);
    await setWhatsNew(asc, platform, appStoreVersion.id, options.whatsNew);
    await submitForReview(asc, appId, platform, appStoreVersion.id);
  }
}

// ---------------------------------------------------------------------- CLI

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "version") {
    console.log(parseTag(rest[0] ?? ""));
    return;
  }
  if (command === "build-number") {
    console.log(buildNumber(new Date()));
    return;
  }
  if (command !== "run") {
    throw new Error(
      "usage: asc-submit.ts version <tag> | build-number | run --version X.Y.Z --build N [--submit]",
    );
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      version: { type: "string" },
      build: { type: "string" },
      platforms: { type: "string", default: PLATFORMS.join(",") },
      submit: { type: "boolean", default: false },
      "notes-file": { type: "string" },
      "bundle-id": { type: "string", default: "tv.netrics" },
      "timeout-minutes": { type: "string", default: "60" },
    },
    strict: true,
  });
  const version = values.version ?? "";
  parseTag(`${TAG_PREFIX}${version}`);
  const build = values.build ?? "";
  if (!isValidBuildNumber(build)) {
    throw new Error(`--build "${build}" is not one to three integers`);
  }
  const platforms = values.platforms.split(",").map((p) => p.trim());
  for (const p of platforms) {
    if (!(PLATFORMS as readonly string[]).includes(p)) {
      throw new Error(`unknown platform ${p} (${PLATFORMS.join(", ")})`);
    }
  }
  const timeoutMinutes = Number(values["timeout-minutes"]);
  if (!(timeoutMinutes > 0)) throw new Error("--timeout-minutes must be > 0");
  const notes = values["notes-file"]
    ? readFileSync(values["notes-file"], "utf8")
    : "";

  const asc = new AppStoreConnect({
    keyId: requireEnv("ASC_KEY_ID"),
    issuerId: requireEnv("ASC_ISSUER_ID"),
    privateKey: createPrivateKey(readFileSync(requireEnv("ASC_KEY_PATH"))),
  });
  await run(asc, {
    bundleId: values["bundle-id"],
    version,
    build,
    platforms: platforms as Platform[],
    submit: values.submit,
    whatsNew: whatsNewFromReleaseNotes(notes),
    wait: { timeoutMs: timeoutMinutes * 60000, intervalMs: 30000 },
  });
}

const invokedDirectly =
  import.meta.main ??
  (process.argv[1] !== undefined &&
    pathToFileURL(process.argv[1]).href === import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      process.env.GITHUB_ACTIONS ? `::error::${message}` : `error: ${message}`,
    );
    process.exit(1);
  });
}
