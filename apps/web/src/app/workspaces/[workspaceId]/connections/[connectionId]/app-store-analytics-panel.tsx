"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import type {
  AppStoreAnalyticsStatusResponse,
  AppStoreReviewsKeyOffer,
  EnableAppStoreAnalyticsResponse,
} from "@netrics/contracts";

import { SignedKeyFields } from "../signed-key-fields";
import {
  apiErrorMessage,
  enableAppStoreAnalytics,
  getAppStoreAnalytics,
  updateConnection,
} from "@/lib/api";
import {
  REVIEWS_KEY_CHANGED_EVENT,
  reviewsKeyCredentials,
} from "@/lib/app-store-reviews";
import {
  APP_STORE_CONNECT_KEYS_URL,
  adminKeyGuide,
  adminKeyIdOf,
  analyticsLead,
  analyticsStatusLabel,
  needsEnablement,
  pausedApps,
} from "@/lib/app-store-analytics";
import {
  emptyKeyValues,
  fieldOfMessage,
  keyCredentials,
  localizedFieldLabel,
  missingKeyField,
  type SignedKeyStrategy,
} from "@/lib/signed-key";
import { useLocale, useT } from "@/lib/i18n/client";

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

/**
 * "Enable App Store analytics" (ADR 0014, #174): the per-app status of the
 * analytics report requests, and the one-time step with a temporary Admin
 * key. The key is read in the browser, sent once, used by the API in memory
 * and never stored; afterwards the user is told to revoke it. A Customer
 * Support key uploaded here by mistake (#715) is offered, in place, as the
 * connection's reviews key: on confirm the form's values go to the reviews
 * key update, which checks the key again before storing it.
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
  const t = useT("connections.appStoreAnalytics");
  const reviews = useT("connections.appStoreReviews");
  const common = useT("common");
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
  // #715: the uploaded key is a reviews key. It stays in the form's
  // values (browser memory) until the user takes or discards the offer.
  const [offer, setOffer] = useState<AppStoreReviewsKeyOffer | null>(null);
  const [reviewsStored, setReviewsStored] = useState<{
    keyId: string;
    previous: string | null;
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
    setOffer(null);
  }

  /** Stores the offered key as the reviews key, from the form's values. */
  async function acceptOffer() {
    if (!offer) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const credentials = reviewsKeyCredentials(strategy, values);
      await updateConnection(workspaceId, connectionId, { credentials });
      setReviewsStored({
        keyId: credentials.reviews.keyId ?? offer.keyId,
        previous: offer.replacesKeyId,
      });
      // The private key leaves the browser's memory with the form.
      close();
      window.dispatchEvent(new Event(REVIEWS_KEY_CHANGED_EVENT));
    } catch (cause) {
      setOffer(null);
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setOffer(null);
    setReviewsStored(null);
    const missing = missingKeyField(strategy, values);
    if (missing) {
      setFieldErrors({
        [missing.key]:
          missing.input === "file"
            ? t("chooseAdminFile")
            : t("fieldRequired", {
                field: localizedFieldLabel(strategy, missing, locale),
              }),
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
      if (response.reviewsKeyOffer) {
        // Nothing was requested or stored: ask before keeping the key.
        setOffer(response.reviewsKeyOffer);
        return;
      }
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
      <h2>{t("title")}</h2>
      <p>
        <strong>
          {analyticsLead(
            {
              apps: canUpdate && !authFailed ? (status?.apps ?? null) : null,
              keyRefused: authFailed,
            },
            locale,
          )}
        </strong>
      </p>
      <p className="muted">{t("intro")}</p>

      {!canUpdate ? (
        <p className="muted">{t("askToEnable")}</p>
      ) : authFailed ? (
        <p className="muted">{t("uploadKeyFirst")}</p>
      ) : null}

      {paused.length > 0 ? (
        <div className="error" role="alert">
          <p>
            <strong>{t("pausedTitle")}</strong>{" "}
            {t("pausedDetail", {
              apps: new Intl.ListFormat(locale).format(
                paused.map((app) => app.name ?? app.appId),
              ),
            })}
          </p>
        </div>
      ) : null}

      {reviewsStored ? (
        <div className="notice" role="status">
          <p>
            {t("offer.stored", { keyId: reviewsStored.keyId })}
            {reviewsStored.previous &&
            reviewsStored.previous !== reviewsStored.keyId ? (
              <>
                {" "}
                <strong>
                  {reviews("revokePrevious", {
                    keyId: reviewsStored.previous,
                  })}
                </strong>{" "}
                <a
                  href={status?.keysUrl ?? APP_STORE_CONNECT_KEYS_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("openKeys")} ↗
                </a>
              </>
            ) : null}
          </p>
        </div>
      ) : null}

      {result ? (
        <div className="notice" role="status">
          <p>
            {result.response.apps.some((app) => app.outcome === "created")
              ? t("requested")
              : t("nothingNew")}
          </p>
          <ul className="analytics-outcomes">
            {result.response.apps.map((app) => (
              <li key={app.appId}>
                {app.name ?? app.appId}: {t(`outcomes.${app.outcome}`)}
                {app.message ? ` — ${app.message}` : ""}
              </li>
            ))}
          </ul>
          <p>
            <strong>
              {result.keyId
                ? t("revokeNowKey", { keyId: result.keyId })
                : t("revokeNow")}
            </strong>{" "}
            {t("notStored")}{" "}
            <a href={result.response.keysUrl} target="_blank" rel="noreferrer">
              {t("openKeys")} ↗
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
            <p className="muted">{t("asking")}</p>
          ) : apps.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>{t("app")}</th>
                  <th>{t("analytics")}</th>
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
                      {analyticsStatusLabel(app.status, app.latestDay, locale)}
                      {app.message ? (
                        <div className="muted">{app.message}</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : status ? (
            <p className="muted">{t("noApps")}</p>
          ) : null}

          {open ? (
            <form className="stack" onSubmit={onSubmit}>
              <h3>{t("enable")}</h3>
              <p>
                <strong>{t("adminOnly")}</strong>
              </p>
              <p className="muted">{t("enableIntro")}</p>
              <SignedKeyFields
                strategy={strategy}
                values={values}
                errors={fieldErrors}
                disabled={pending || offer !== null}
                guideOpen
                guide={adminKeyGuide(locale)}
                idPrefix="admin-"
                onChange={(key, value) => {
                  setValues((current) => ({ ...current, [key]: value }));
                  setFieldErrors((current) => ({
                    ...current,
                    [key]: undefined,
                  }));
                }}
              />
              {offer ? (
                <div
                  className="notice"
                  role="status"
                  data-testid="reviews-key-offer"
                >
                  <p>
                    <strong>{t("offer.title")}</strong>
                  </p>
                  <p>{t("offer.detail", { keyId: offer.keyId })}</p>
                  {offer.replacesKeyId ? (
                    <p>{t("offer.replaces", { keyId: offer.replacesKeyId })}</p>
                  ) : null}
                  <div className="actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={pending}
                      onClick={() => void acceptOffer()}
                    >
                      {pending
                        ? reviews("checkingKey")
                        : offer.replacesKeyId
                          ? t("offer.replace")
                          : t("offer.use")}
                    </button>
                    <button type="button" disabled={pending} onClick={close}>
                      {t("offer.dismiss")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="actions">
                  <button type="submit" className="primary" disabled={pending}>
                    {pending ? t("requesting") : t("request")}
                  </button>
                  <button type="button" disabled={pending} onClick={close}>
                    {common("cancel")}
                  </button>
                </div>
              )}
              {error ? (
                <div className="error" role="alert">
                  <p>{error}</p>
                  <p>{t("nothingStored")}</p>
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
                  setReviewsStored(null);
                  setOpen(true);
                }}
              >
                {t("enable")}
              </button>
            </div>
          ) : status ? (
            <div className="actions">
              <button
                type="button"
                disabled={loading}
                onClick={() => void load()}
              >
                {loading ? t("checking") : t("checkAgain")}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
