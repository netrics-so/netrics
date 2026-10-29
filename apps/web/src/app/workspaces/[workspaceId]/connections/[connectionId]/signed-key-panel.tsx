"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type {
  ConnectionSignedKeyView,
  SignedKeyPairResponse,
} from "@netrics/contracts";

import { SignedKeyFields } from "../signed-key-fields";
import { apiErrorMessage, updateConnection } from "@/lib/api";
import { listNames } from "@/lib/apple-ads";
import {
  APPLE_ADS_PROVIDER,
  emptyKeyValues,
  fieldOfMessage,
  keyPayload,
  localizedFieldLabel,
  missingKeyFieldWith,
  type SignedKeyStrategy,
} from "@/lib/signed-key";
import { useLocale, useT } from "@/lib/i18n/client";

interface SignedKeyPanelProps {
  workspaceId: string;
  connectionId: string;
  strategy: SignedKeyStrategy;
  /** The stored key's non-secret fields, if the API could read them. */
  signedKey: ConnectionSignedKeyView | null;
  hasCredentials: boolean;
  /** The key was refused: the form opens right away. */
  authFailed: boolean;
  canUpdate: boolean;
}

/**
 * The stored key of a signed-key connection (ADR 0014): which key it is
 * (non-secret fields only, the private key is never shown), and "Replace
 * key" for rotation or after a revocation. The new key is checked with the
 * provider before it replaces the stored one; a refused key changes
 * nothing. Afterwards the user is reminded to revoke the old key, which
 * netrics cannot do.
 */
export function SignedKeyPanel({
  workspaceId,
  connectionId,
  strategy,
  signedKey,
  hasCredentials,
  authFailed,
  canUpdate,
}: SignedKeyPanelProps) {
  const locale = useLocale();
  const t = useT("connections.keyPanel");
  const ads = useT("connections.appleAds");
  const common = useT("common");
  const router = useRouter();
  const name = strategy.providerName ?? t("provider");
  // Apple Ads (#375): a public key pasted in Apple Ads, perhaps serving
  // several connections.
  const appleAds = strategy.provider === APPLE_ADS_PROVIDER;
  const shared = (signedKey?.sharedWith ?? []).map((other) => other.name);
  const [open, setOpen] = useState(authFailed && canUpdate);
  // A new key is usually from the same team: keep its issuer ID. The key
  // ID comes with the new file (AuthKey_<Key ID>.p8). Apple Ads shows all
  // three IDs anew with a new public key, so nothing is kept.
  const keep = (fields: ConnectionSignedKeyView["fields"]) =>
    appleAds
      ? {}
      : Object.fromEntries(
          fields
            .filter((field) => field.key !== "keyId")
            .map((field) => [field.key, field.value]),
        );
  const initialValues = () => ({
    ...emptyKeyValues(strategy),
    ...keep(signedKey?.fields ?? []),
  });
  const [values, setValues] = useState(initialValues);
  const [keyPair, setKeyPair] = useState<SignedKeyPairResponse | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [replaced, setReplaced] = useState<{
    oldKeyId: string | null;
    newKeyId: string | null;
    /** Other connections whose key was replaced with it. */
    shared: string[];
  } | null>(null);
  const keyIdOf = (view: ConnectionSignedKeyView | null) =>
    view?.fields.find((field) => field.key === "keyId")?.value ?? null;
  const revokeUrl = strategy.setup?.url;

  function close() {
    setOpen(false);
    setValues(initialValues());
    setKeyPair(null);
    setFieldErrors({});
    setError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    const missing = missingKeyFieldWith(strategy, values, keyPair !== null);
    if (missing) {
      setFieldErrors({
        [missing.key]:
          missing.input === "file"
            ? strategy.generatedKeyPair
              ? t("generateOrPaste")
              : t("chooseFile")
            : t("fieldRequired", {
                field: localizedFieldLabel(strategy, missing, locale),
              }),
      });
      return;
    }
    setPending(true);
    try {
      const { connection } = await updateConnection(
        workspaceId,
        connectionId,
        keyPayload(strategy, values, keyPair?.pendingKeyId ?? null),
      );
      // A generated pending key moved into the connection.
      setKeyPair(null);
      setReplaced({
        oldKeyId: keyIdOf(signedKey),
        newKeyId: keyIdOf(connection.signedKey),
        shared: (connection.signedKey?.sharedWith ?? []).map(
          (other) => other.name,
        ),
      });
      // The private key leaves the browser's memory with the form.
      setValues({
        ...initialValues(),
        ...keep(connection.signedKey?.fields ?? []),
      });
      setOpen(false);
      router.refresh();
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

  return (
    <div className="card" id="replace-key">
      <h2>{t("title", { name })}</h2>
      <div className="row">
        <span className="label">{t("privateKey")}</span>
        <span className="value">
          {hasCredentials ? t("stored") : common("none")}
        </span>
      </div>
      {signedKey?.fields.map((field) => (
        <div className="row" key={field.key}>
          <span className="label">
            {localizedFieldLabel(strategy, field, locale)}
          </span>
          <span className="value">
            <code>{field.value}</code>
          </span>
        </div>
      ))}

      {shared.length > 0 ? (
        <p className="muted">
          {ads("sharedWith", { names: listNames(shared, locale) })}
        </p>
      ) : null}

      {replaced ? (
        <div className="notice" role="status">
          <p>
            {replaced.newKeyId
              ? t("replacedKey", { keyId: replaced.newKeyId })
              : t("replaced")}
          </p>
          {replaced.shared.length > 0 ? (
            <p>
              {ads("replacedShared", {
                names: listNames(replaced.shared, locale),
              })}
            </p>
          ) : null}
          <p>
            {appleAds
              ? ads("removeOldKey")
              : replaced.oldKeyId
                ? t("revokeOldKey", { keyId: replaced.oldKeyId, name })
                : t("revokeOld", { name })}{" "}
            {revokeUrl ? (
              <a href={revokeUrl} target="_blank" rel="noreferrer">
                {t("openKeys", { name })} ↗
              </a>
            ) : null}
          </p>
        </div>
      ) : null}

      {!canUpdate ? (
        <p className="muted">{t("askToReplace")}</p>
      ) : open ? (
        <form className="stack" onSubmit={onSubmit}>
          <h3>
            {authFailed
              ? appleAds
                ? ads("setUpNewKey")
                : t("uploadNew", { name })
              : t("replace")}
          </h3>
          <p className="muted">{t("checksFirst", { name })}</p>
          <SignedKeyFields
            strategy={strategy}
            values={values}
            errors={fieldErrors}
            disabled={pending}
            guideOpen={authFailed}
            keyPair={{
              workspaceId,
              value: keyPair,
              onChange: (value) => {
                setKeyPair(value);
                setFieldErrors({});
              },
            }}
            onChange={(key, value) => {
              setValues((current) => ({ ...current, [key]: value }));
              setFieldErrors((current) => ({ ...current, [key]: undefined }));
            }}
          />
          <div className="actions">
            <button type="submit" className="primary" disabled={pending}>
              {pending ? t("checking", { name }) : t("checkAndReplace")}
            </button>
            <button type="button" disabled={pending} onClick={close}>
              {common("cancel")}
            </button>
          </div>
          {error ? (
            <div className="error" role="alert">
              <p>{error}</p>
              <p>{t("notChanged")}</p>
            </div>
          ) : null}
        </form>
      ) : (
        <div className="actions">
          <button
            type="button"
            className={authFailed ? "primary" : undefined}
            onClick={() => {
              setReplaced(null);
              setOpen(true);
            }}
          >
            {authFailed
              ? appleAds
                ? ads("setUpNewKey")
                : t("uploadNew", { name })
              : t("replace")}
          </button>
        </div>
      )}
    </div>
  );
}
