"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import type { AppStoreReviewsStatusResponse } from "@netrics/contracts";

import { SignedKeyFields } from "../signed-key-fields";
import {
  apiErrorMessage,
  getAppStoreReviews,
  updateConnection,
} from "@/lib/api";
import {
  REMOVE_REVIEWS_KEY,
  reviewsKeyGuide,
  reviewsKeyCredentials,
  reviewsKeyStrategy,
  reviewsStatusLabel,
} from "@/lib/app-store-reviews";
import {
  emptyKeyValues,
  fieldOfMessage,
  localizedFieldLabel,
  missingKeyField,
  type SignedKeyStrategy,
} from "@/lib/signed-key";
import { useLocale, useT } from "@/lib/i18n/client";

interface AppStoreReviewsPanelProps {
  workspaceId: string;
  connectionId: string;
  strategy: SignedKeyStrategy;
  canUpdate: boolean;
}

type Outcome =
  | { kind: "stored"; keyId: string | null; previous: string | null }
  | { kind: "removed"; keyId: string | null };

/**
 * "App Store ratings and reviews" (ADR 0014 decision 2, #190): the
 * optional second key with the Customer Support role. It is checked with
 * Apple before it is stored next to the Sales key; replacing and removing
 * it go through the connection's credential update. Without it, the
 * connection works as before.
 */
export function AppStoreReviewsPanel({
  workspaceId,
  connectionId,
  strategy,
  canUpdate,
}: AppStoreReviewsPanelProps) {
  const locale = useLocale();
  const t = useT("connections.appStoreReviews");
  const shared = useT("connections.appStoreAnalytics");
  const common = useT("common");
  const keyStrategy = useMemo(
    () => reviewsKeyStrategy(strategy, locale),
    [strategy, locale],
  );
  const guide = reviewsKeyGuide(locale);
  const [status, setStatus] = useState<AppStoreReviewsStatusResponse | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(() => emptyKeyValues(keyStrategy));
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setStatus(await getAppStoreReviews(workspaceId, connectionId));
    } catch (cause) {
      setLoadError(apiErrorMessage(cause, locale));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, connectionId]);

  useEffect(() => {
    if (canUpdate) {
      void load();
    }
  }, [canUpdate, load]);

  function close() {
    setOpen(false);
    setValues(emptyKeyValues(keyStrategy));
    setFieldErrors({});
    setError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    const missing = missingKeyField(keyStrategy, values);
    if (missing) {
      setFieldErrors({
        [missing.key]:
          missing.input === "file"
            ? t("chooseFile")
            : shared("fieldRequired", {
                field: localizedFieldLabel(keyStrategy, missing, locale),
              }),
      });
      return;
    }
    setPending(true);
    const previous = status?.keyId ?? null;
    try {
      const credentials = reviewsKeyCredentials(keyStrategy, values);
      await updateConnection(workspaceId, connectionId, { credentials });
      setOutcome({
        kind: "stored",
        keyId: credentials.reviews.keyId ?? null,
        previous,
      });
      // The private key leaves the browser's memory with the form.
      close();
      await load();
    } catch (cause) {
      const message = apiErrorMessage(cause, locale);
      const field = fieldOfMessage(message, keyStrategy.fields);
      if (field) {
        setFieldErrors({ [field]: message });
      } else {
        setError(message);
      }
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    setError(null);
    const keyId = status?.keyId ?? null;
    try {
      await updateConnection(workspaceId, connectionId, {
        credentials: { ...REMOVE_REVIEWS_KEY },
      });
      setConfirmRemove(false);
      setOutcome({ kind: "removed", keyId });
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  const configured = status !== null && status.status !== "not_configured";

  return (
    <div className="card" id="app-store-reviews">
      <h2>{t("title")}</h2>
      <p className="muted">{t("intro")}</p>

      {!canUpdate ? <p className="muted">{t("askToAdd")}</p> : null}

      {status?.status === "paused" ? (
        <div className="error" role="alert">
          <p>
            {status.message ?? t("pausedFallback")} {t("salesKeepSyncing")}
          </p>
        </div>
      ) : null}

      {outcome ? (
        <div className="notice" role="status">
          {outcome.kind === "stored" ? (
            <p>
              {outcome.keyId
                ? t("storedKey", { keyId: outcome.keyId })
                : t("stored")}
              {outcome.previous && outcome.previous !== outcome.keyId ? (
                <>
                  {" "}
                  <strong>
                    {t("revokePrevious", { keyId: outcome.previous })}
                  </strong>{" "}
                  <a
                    href={status?.keysUrl ?? guide.links[0]!.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shared("openKeys")} ↗
                  </a>
                </>
              ) : null}
            </p>
          ) : (
            <p>
              {t("removed")}{" "}
              <strong>
                {outcome.keyId
                  ? t("revokeRemovedKey", { keyId: outcome.keyId })
                  : t("revokeRemoved")}
              </strong>{" "}
              <a
                href={status?.keysUrl ?? guide.links[0]!.url}
                target="_blank"
                rel="noreferrer"
              >
                {shared("openKeys")} ↗
              </a>
            </p>
          )}
        </div>
      ) : null}

      {canUpdate ? (
        <>
          {loadError ? (
            <div className="error" role="alert">
              <p>{loadError}</p>
            </div>
          ) : null}
          {status === null && loading ? (
            <p className="muted">{shared("asking")}</p>
          ) : status ? (
            <div className="row">
              <span className="label">{t("reviewsKey")}</span>
              <span className="value">
                {reviewsStatusLabel(status.status, status.keyId, locale)}
                {status.status === "unknown" && status.message ? (
                  <span className="muted"> {status.message}</span>
                ) : null}
              </span>
            </div>
          ) : null}

          {open ? (
            <form className="stack" onSubmit={onSubmit}>
              <h3>{configured ? t("replaceTitle") : t("addOptional")}</h3>
              <p className="muted">{t("formIntro")}</p>
              <SignedKeyFields
                strategy={keyStrategy}
                values={values}
                errors={fieldErrors}
                disabled={pending}
                guideOpen
                guide={guide}
                idPrefix="reviews-"
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
                  {pending ? t("checkingKey") : t("checkAndStore")}
                </button>
                <button type="button" disabled={pending} onClick={close}>
                  {common("cancel")}
                </button>
              </div>
              {error ? (
                <div className="error" role="alert">
                  <p>{error}</p>
                  <p>{shared("nothingStored")}</p>
                </div>
              ) : null}
            </form>
          ) : confirmRemove ? (
            <div className="stack">
              <p>
                {status?.keyId
                  ? t("confirmRemoveKey", { keyId: status.keyId })
                  : t("confirmRemove")}
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="danger"
                  disabled={pending}
                  onClick={() => void remove()}
                >
                  {pending ? common("removing") : t("remove")}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirmRemove(false)}
                >
                  {common("cancel")}
                </button>
              </div>
              {error ? (
                <div className="error" role="alert">
                  <p>{error}</p>
                </div>
              ) : null}
            </div>
          ) : status ? (
            <div className="actions">
              <button
                type="button"
                className={
                  status.status === "not_configured" ||
                  status.status === "paused"
                    ? "primary"
                    : undefined
                }
                onClick={() => {
                  setOutcome(null);
                  setOpen(true);
                }}
              >
                {status.status === "not_configured"
                  ? t("addOptional")
                  : status.status === "paused"
                    ? t("uploadNew")
                    : t("replace")}
              </button>
              {configured ? (
                <button
                  type="button"
                  onClick={() => {
                    setOutcome(null);
                    setError(null);
                    setConfirmRemove(true);
                  }}
                >
                  {t("remove")}
                </button>
              ) : null}
              {configured ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void load()}
                >
                  {loading ? shared("checking") : shared("checkAgain")}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
