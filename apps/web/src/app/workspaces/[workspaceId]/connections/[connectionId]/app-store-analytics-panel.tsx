"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import type {
  AppStoreAnalyticsStatusResponse,
  EnableAppStoreAnalyticsResponse,
} from "@netrics/contracts";

import { SignedKeyFields } from "../signed-key-fields";
import {
  apiErrorMessage,
  enableAppStoreAnalytics,
  getAppStoreAnalytics,
} from "@/lib/api";
import {
  ADMIN_KEY_GUIDE,
  adminKeyIdOf,
  analyticsStatusLabel,
  needsEnablement,
  pausedApps,
} from "@/lib/app-store-analytics";
import {
  emptyKeyValues,
  fieldOfMessage,
  keyCredentials,
  missingKeyField,
  type SignedKeyStrategy,
} from "@/lib/signed-key";
import { useLocale } from "@/lib/i18n/client";

interface AppStoreAnalyticsPanelProps {
  workspaceId: string;
  connectionId: string;
  strategy: SignedKeyStrategy;
  /** The stored key's issuer ID: the Admin key must be of the same team. */
  issuerId: string | null;
  canUpdate: boolean;
  /** The stored key was refused: nothing can be read until it is replaced. */
  authFailed: boolean;
}

const OUTCOME_LABELS = {
  created: "Requested now",
  existing: "Already requested",
  failed: "Not requested",
} as const;

/**
 * "Enable App Store analytics" (ADR 0014, #174): the per-app status of the
 * analytics report requests, and the one-time step with a temporary Admin
 * key. The key is read in the browser, sent once, used by the API in memory
 * and never stored; afterwards the user is told to revoke it.
 */
export function AppStoreAnalyticsPanel({
  workspaceId,
  connectionId,
  strategy,
  issuerId,
  canUpdate,
  authFailed,
}: AppStoreAnalyticsPanelProps) {
  const locale = useLocale();
  const initialValues = useCallback(
    () => ({
      ...emptyKeyValues(strategy),
      ...(issuerId ? { issuerId } : {}),
    }),
    [strategy, issuerId],
  );
  const [status, setStatus] = useState<AppStoreAnalyticsStatusResponse | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(initialValues);
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{
    response: EnableAppStoreAnalyticsResponse;
    keyId: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setStatus(await getAppStoreAnalytics(workspaceId, connectionId));
    } catch (cause) {
      setLoadError(apiErrorMessage(cause, locale));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, connectionId]);

  useEffect(() => {
    if (canUpdate && !authFailed) {
      void load();
    }
  }, [canUpdate, authFailed, load]);

  function close() {
    setOpen(false);
    setValues(initialValues());
    setFieldErrors({});
    setError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    const missing = missingKeyField(strategy, values);
    if (missing) {
      setFieldErrors({
        [missing.key]:
          missing.input === "file"
            ? "Choose the .p8 file of the Admin key, or paste it."
            : `${missing.label} is required.`,
      });
      return;
    }
    setPending(true);
    try {
      const response = await enableAppStoreAnalytics(
        workspaceId,
        connectionId,
        { credentials: keyCredentials(strategy, values) },
      );
      setResult({ response, keyId: adminKeyIdOf(values) });
      // The Admin key leaves the browser's memory with the form.
      close();
      await load();
    } catch (cause) {
      const message = apiErrorMessage(cause, locale);
      const field = fieldOfMessage(message, strategy.fields);
      if (field) {
        setFieldErrors({ [field]: message });
      } else {
        setError(message);
      }
    } finally {
      setPending(false);
    }
  }

  const apps = status?.apps ?? [];
  const paused = pausedApps(apps);

  return (
    <div className="card" id="app-store-analytics">
      <h2>App Store analytics</h2>
      <p className="muted">
        Impressions, product page views and downloads by source come from
        Apple&apos;s analytics reports. Apple only generates them after an Admin
        has requested them once per app. The first reports arrive 1–2 days after
        that, and each day is complete about two days later. netrics then reads
        them with the Sales key it stores; sales keep syncing either way.
      </p>

      {!canUpdate ? (
        <p className="muted">
          Ask a workspace owner, admin or editor to enable App Store analytics.
        </p>
      ) : authFailed ? (
        <p className="muted">
          Upload a new App Store Connect key first: the status is read with it.
        </p>
      ) : null}

      {paused.length > 0 ? (
        <div className="error" role="alert">
          <p>
            <strong>App Store analytics paused — enable again.</strong> Apple
            stopped the report request of{" "}
            {paused.map((app) => app.name ?? app.appId).join(", ")} because its
            reports were not read for a long time. Enabling again creates a new
            request; sales are not affected.
          </p>
        </div>
      ) : null}

      {result ? (
        <div className="notice" role="status">
          <p>
            {result.response.apps.some((app) => app.outcome === "created")
              ? "App Store analytics requested. The first reports arrive in 1–2 days."
              : "Nothing new to request."}
          </p>
          <ul className="analytics-outcomes">
            {result.response.apps.map((app) => (
              <li key={app.appId}>
                {app.name ?? app.appId}: {OUTCOME_LABELS[app.outcome]}
                {app.message ? ` — ${app.message}` : ""}
              </li>
            ))}
          </ul>
          <p>
            <strong>
              Now revoke the temporary Admin key
              {result.keyId ? ` ${result.keyId}` : ""} in App Store Connect.
            </strong>{" "}
            netrics did not store it, and nothing needs it any more.{" "}
            <a href={result.response.keysUrl} target="_blank" rel="noreferrer">
              Open App Store Connect API keys ↗
            </a>
          </p>
        </div>
      ) : null}

      {canUpdate && !authFailed ? (
        <>
          {loadError ? (
            <div className="error" role="alert">
              <p>{loadError}</p>
            </div>
          ) : null}
          {status === null && loading ? (
            <p className="muted">Asking App Store Connect…</p>
          ) : apps.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Analytics</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => (
                  <tr key={app.appId}>
                    <td>
                      {app.name ?? app.appId}{" "}
                      <span className="muted">{app.appId}</span>
                    </td>
                    <td>
                      {analyticsStatusLabel(app.status, app.latestDay)}
                      {app.message ? (
                        <div className="muted">{app.message}</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : status ? (
            <p className="muted">This connection reads no apps yet.</p>
          ) : null}

          {open ? (
            <form className="stack" onSubmit={onSubmit}>
              <h3>Enable App Store analytics</h3>
              <p className="muted">
                Requesting analytics reports needs a team key with the Admin
                role, once. Use a temporary one: netrics uses it in memory for
                this request only and never stores it. Revoke it right after.
              </p>
              <SignedKeyFields
                strategy={strategy}
                values={values}
                errors={fieldErrors}
                disabled={pending}
                guideOpen
                guide={ADMIN_KEY_GUIDE}
                idPrefix="admin-"
                onChange={(key, value) => {
                  setValues((current) => ({ ...current, [key]: value }));
                  setFieldErrors((current) => ({
                    ...current,
                    [key]: undefined,
                  }));
                }}
              />
              <div className="actions">
                <button type="submit" className="primary" disabled={pending}>
                  {pending
                    ? "Requesting with App Store Connect…"
                    : "Request analytics reports"}
                </button>
                <button type="button" disabled={pending} onClick={close}>
                  Cancel
                </button>
              </div>
              {error ? (
                <div className="error" role="alert">
                  <p>{error}</p>
                  <p>Nothing was stored.</p>
                </div>
              ) : null}
            </form>
          ) : status && needsEnablement(apps) ? (
            <div className="actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setResult(null);
                  setOpen(true);
                }}
              >
                Enable App Store analytics
              </button>
            </div>
          ) : status ? (
            <div className="actions">
              <button
                type="button"
                disabled={loading}
                onClick={() => void load()}
              >
                {loading ? "Checking…" : "Check again"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
