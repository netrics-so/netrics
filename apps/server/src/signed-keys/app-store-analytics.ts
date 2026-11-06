import type {
  AppStoreAnalyticsAppStatus,
  AppStoreAnalyticsOutcome,
} from "@netrics/contracts";
import { redactCredentialValues } from "@netrics/connector-runtime";
import {
  AppStoreConnectApiError,
  AppStoreConnectRateBudgetError,
  activeRequest,
  createAppStoreConnectClient,
  ensureAnalyticsRequest,
  listAnalyticsRequests,
  listApps,
  type AppStoreApp,
} from "@netrics/connectors";

import {
  APP_STORE_CONNECT_KEYS_URL,
  RATE_LIMITED_MESSAGE,
} from "./providers/app-store-connect.js";
import type { SignedKey, SignedKeyHttp } from "./registry.js";

// "Enable App Store analytics" (ADR 0014, #174). Creating an analytics
// report request needs an Admin key, which netrics never stores: the user
// uploads a temporary Admin team key, this module signs tokens with it in
// memory for the one HTTP request, creates the missing ONGOING requests,
// and drops it. Nothing here persists, enqueues or logs the key; messages
// are redacted of its values and of every token signed with it.

/** Apps one enablement handles at most (one HTTP request of the user). */
export const MAX_ANALYTICS_APPS = 50;

export const ADMIN_ROLE_MESSAGE =
  "This key cannot request App Store analytics: only a team key with the Admin role can, once. The key netrics stores (Sales) cannot. Use a temporary Admin key and revoke it afterwards.";
export const ADMIN_KEY_REFUSED_MESSAGE =
  "App Store Connect refused this key: it was revoked, or the issuer ID, key ID and private key do not belong together.";
const UNREACHABLE_MESSAGE =
  "App Store Connect could not be reached to enable analytics. Try again in a few minutes.";

export type AnalyticsResult<T> =
  { ok: true; value: T } | { ok: false; message: string };

/** The client of one step: tokens minted from the key, all recorded. */
function clientOf(key: SignedKey, http: SignedKeyHttp, tokens: string[]) {
  const token = key.mintToken();
  tokens.push(token);
  return createAppStoreConnectClient(http, token);
}

function redactor(key: SignedKey, tokens: string[]) {
  return (message: string) =>
    redactCredentialValues(redactCredentialValues(message, key.stored()), {
      tokens,
    }).slice(0, 300);
}

function isRateLimited(error: unknown): boolean {
  return (
    error instanceof AppStoreConnectRateBudgetError ||
    (error instanceof AppStoreConnectApiError && error.status === 429)
  );
}

/** The apps the connection reads (its selection, or every app of the team). */
function targetApps(
  apps: AppStoreApp[],
  selection: readonly string[] | undefined,
): Array<{ id: string; name: string | null }> {
  if (selection === undefined) {
    return apps.map((app) => ({ id: app.id, name: app.name }));
  }
  const names = new Map(apps.map((app) => [app.id, app.name]));
  return selection.map((id) => ({ id, name: names.get(id) ?? null }));
}

/**
 * With the temporary Admin key: per app, reuse a running ONGOING request
 * or create one (a 409 counts as existing). A 401 or a missing Admin role
 * stops before anything else is tried.
 */
export async function enableAppStoreAnalytics(input: {
  adminKey: SignedKey;
  http: SignedKeyHttp;
  /** The connection's selected app IDs; undefined: every app. */
  selection: readonly string[] | undefined;
}): Promise<AnalyticsResult<AppStoreAnalyticsOutcome[]>> {
  const { adminKey, http } = input;
  const tokens: string[] = [];
  const redact = redactor(adminKey, tokens);
  const client = clientOf(adminKey, http, tokens);
  const refusal = (error: unknown): string | null => {
    if (error instanceof AppStoreConnectApiError && error.status === 401) {
      return ADMIN_KEY_REFUSED_MESSAGE;
    }
    if (error instanceof AppStoreConnectApiError && error.status === 403) {
      return ADMIN_ROLE_MESSAGE;
    }
    if (isRateLimited(error)) {
      return RATE_LIMITED_MESSAGE;
    }
    return null;
  };

  let apps: AppStoreApp[];
  try {
    apps = await listApps(client);
  } catch (error) {
    return { ok: false, message: refusal(error) ?? UNREACHABLE_MESSAGE };
  }
  const targets = targetApps(apps, input.selection).slice(
    0,
    MAX_ANALYTICS_APPS,
  );
  const outcomes: AppStoreAnalyticsOutcome[] = [];
  for (const app of targets) {
    try {
      const result = await ensureAnalyticsRequest(client, app.id);
      outcomes.push({
        appId: app.id,
        name: app.name,
        outcome: result.status,
        message: null,
      });
    } catch (error) {
      const stop = refusal(error);
      if (
        stop !== null &&
        outcomes.every((entry) => entry.outcome !== "created")
      ) {
        // Nothing was requested yet: the whole step failed.
        return { ok: false, message: stop };
      }
      outcomes.push({
        appId: app.id,
        name: app.name,
        outcome: "failed",
        message:
          stop ??
          redact(
            error instanceof AppStoreConnectApiError
              ? error.message
              : UNREACHABLE_MESSAGE,
          ),
      });
      if (stop !== null) {
        // The rest would fail the same way.
        for (const rest of targets.slice(outcomes.length)) {
          outcomes.push({
            appId: rest.id,
            name: rest.name,
            outcome: "failed",
            message: stop,
          });
        }
        break;
      }
    }
  }
  return { ok: true, value: outcomes };
}

/**
 * The analytics state per app, with the connection's stored key (reading
 * requests works with the Sales role): not requested, stopped, requested
 * (data pending), or available when analytics observations are stored.
 */
export async function appStoreAnalyticsStatus(input: {
  key: SignedKey;
  http: SignedKeyHttp;
  selection: readonly string[] | undefined;
  /** Newest analytics observation per app ID. */
  latest: ReadonlyMap<string, Date>;
}): Promise<AnalyticsResult<AppStoreAnalyticsAppStatus[]>> {
  const { key, http, latest } = input;
  const tokens: string[] = [];
  const redact = redactor(key, tokens);
  const client = clientOf(key, http, tokens);
  let apps: AppStoreApp[];
  try {
    apps = await listApps(client);
  } catch (error) {
    if (error instanceof AppStoreConnectApiError && error.status === 401) {
      return { ok: false, message: key.provider.authFailure.unauthorized };
    }
    return {
      ok: false,
      message: isRateLimited(error)
        ? RATE_LIMITED_MESSAGE
        : "App Store Connect could not be reached to read the analytics status. Try again in a few minutes.",
    };
  }
  const statuses: AppStoreAnalyticsAppStatus[] = [];
  for (const app of targetApps(apps, input.selection).slice(
    0,
    MAX_ANALYTICS_APPS,
  )) {
    const day = latest.get(app.id);
    const latestDay = day ? day.toISOString().slice(0, 10) : null;
    try {
      const requests = await listAnalyticsRequests(client, app.id);
      const running = activeRequest(requests);
      statuses.push({
        appId: app.id,
        name: app.name,
        status: !running
          ? requests.length > 0
            ? "stopped"
            : "not_enabled"
          : latestDay
            ? "available"
            : "requested",
        latestDay,
        message: null,
      });
    } catch (error) {
      statuses.push({
        appId: app.id,
        name: app.name,
        status: "unknown",
        latestDay,
        message: isRateLimited(error)
          ? RATE_LIMITED_MESSAGE
          : redact(
              error instanceof AppStoreConnectApiError
                ? error.message
                : "App Store Connect could not be reached.",
            ),
      });
    }
  }
  return { ok: true, value: statuses };
}

export { APP_STORE_CONNECT_KEYS_URL };
