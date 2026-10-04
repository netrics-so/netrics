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
  REVIEWS_KEY_GUIDE,
  reviewsKeyCredentials,
  reviewsKeyStrategy,
  reviewsStatusLabel,
} from "@/lib/app-store-reviews";
import {
  emptyKeyValues,
  fieldOfMessage,
  missingKeyField,
  type SignedKeyStrategy,
} from "@/lib/signed-key";
import { useLocale } from "@/lib/i18n/client";

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
  const keyStrategy = useMemo(() => reviewsKeyStrategy(strategy), [strategy]);
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
            ? "Choose the .p8 file of the Customer Support key, or paste it."
            : `${missing.label} is required.`,
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
      <h2>App Store ratings and reviews</h2>
      <p className="muted">
        Optional. Reviews per day, their star ratings and where they come from
        need a second team key with the Customer Support role, because the Sales
        key cannot read reviews. netrics keeps only counts and stars, never
        review text or nicknames. The API returns the reviews customers wrote,
        as Apple lists them; it has no aggregate star rating, so these numbers
        are not the rating shown on the App Store. Sales never depend on this
        key.
      </p>

      {!canUpdate ? (
        <p className="muted">
          Ask a workspace owner, admin or editor to add a Customer Support key.
        </p>
      ) : null}

      {status?.status === "paused" ? (
        <div className="error" role="alert">
          <p>
            {status.message ??
              "App Store reviews paused — upload a new reviews key."}{" "}
            Sales and analytics keep syncing.
          </p>
        </div>
      ) : null}

      {outcome ? (
        <div className="notice" role="status">
          {outcome.kind === "stored" ? (
            <p>
              Customer Support key{outcome.keyId ? ` ${outcome.keyId}` : ""}{" "}
              stored. Reviews of the last year are read with the next sync.
              {outcome.previous && outcome.previous !== outcome.keyId ? (
                <>
                  {" "}
                  <strong>
                    Now revoke the previous key {outcome.previous} in App Store
                    Connect.
                  </strong>{" "}
                  <a
                    href={status?.keysUrl ?? REVIEWS_KEY_GUIDE.links[0].url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open App Store Connect API keys ↗
                  </a>
                </>
              ) : null}
            </p>
          ) : (
            <p>
              Reviews key removed. Review metrics stop updating; the data
              already read stays.{" "}
              <strong>
                Revoke key{outcome.keyId ? ` ${outcome.keyId}` : ""} in App
                Store Connect if nothing else uses it.
              </strong>{" "}
              <a
                href={status?.keysUrl ?? REVIEWS_KEY_GUIDE.links[0].url}
                target="_blank"
                rel="noreferrer"
              >
                Open App Store Connect API keys ↗
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
            <p className="muted">Asking App Store Connect…</p>
          ) : status ? (
            <div className="row">
              <span className="label">Reviews key</span>
              <span className="value">
                {reviewsStatusLabel(status.status, status.keyId)}
                {status.status === "unknown" && status.message ? (
                  <span className="muted"> {status.message}</span>
                ) : null}
              </span>
            </div>
          ) : null}

          {open ? (
            <form className="stack" onSubmit={onSubmit}>
              <h3>
                {configured
                  ? "Replace the Customer Support key"
                  : "Add a Customer Support key (optional)"}
              </h3>
              <p className="muted">
                Use a team key of the same App Store Connect team with the{" "}
                <strong>Customer Support</strong> role. It can also edit App
                Store details and answer reviews, which netrics never does;
                netrics only reads reviews with it. Admin keys are refused.
              </p>
              <SignedKeyFields
                strategy={keyStrategy}
                values={values}
                errors={fieldErrors}
                disabled={pending}
                guideOpen
                guide={REVIEWS_KEY_GUIDE}
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
                  {pending
                    ? "Checking with App Store Connect…"
                    : "Check and store the key"}
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
          ) : confirmRemove ? (
            <div className="stack">
              <p>
                Remove the Customer Support key
                {status?.keyId ? ` ${status.keyId}` : ""}? Review metrics stop
                updating; sales are not affected.
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="danger"
                  disabled={pending}
                  onClick={() => void remove()}
                >
                  {pending ? "Removing…" : "Remove reviews key"}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirmRemove(false)}
                >
                  Cancel
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
                  ? "Add a Customer Support key (optional)"
                  : status.status === "paused"
                    ? "Upload a new reviews key"
                    : "Replace reviews key"}
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
                  Remove reviews key
                </button>
              ) : null}
              {configured ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void load()}
                >
                  {loading ? "Checking…" : "Check again"}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
