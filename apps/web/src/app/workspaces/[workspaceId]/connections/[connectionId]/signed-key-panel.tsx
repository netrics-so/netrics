"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { ConnectionSignedKeyView } from "@netrics/contracts";

import { SignedKeyFields } from "../signed-key-fields";
import { apiErrorMessage, updateConnection } from "@/lib/api";
import {
  emptyKeyValues,
  fieldOfMessage,
  keyCredentials,
  localizedFieldLabel,
  missingKeyField,
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
  const common = useT("common");
  const router = useRouter();
  const name = strategy.providerName ?? t("provider");
  const [open, setOpen] = useState(authFailed && canUpdate);
  // A new key is usually from the same team: keep its issuer ID. The key
  // ID comes with the new file (AuthKey_<Key ID>.p8).
  const initialValues = () => ({
    ...emptyKeyValues(strategy),
    ...Object.fromEntries(
      (signedKey?.fields ?? [])
        .filter((field) => field.key !== "keyId")
        .map((field) => [field.key, field.value]),
    ),
  });
  const [values, setValues] = useState(initialValues);
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [replaced, setReplaced] = useState<{
    oldKeyId: string | null;
    newKeyId: string | null;
  } | null>(null);
  const keyIdOf = (view: ConnectionSignedKeyView | null) =>
    view?.fields.find((field) => field.key === "keyId")?.value ?? null;
  const revokeUrl = strategy.setup?.url;

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
            ? t("chooseFile")
            : t("fieldRequired", {
                field: localizedFieldLabel(strategy, missing, locale),
              }),
      });
      return;
    }
    setPending(true);
    try {
      const { connection } = await updateConnection(workspaceId, connectionId, {
        credentials: keyCredentials(strategy, values),
      });
      setReplaced({
        oldKeyId: keyIdOf(signedKey),
        newKeyId: keyIdOf(connection.signedKey),
      });
      // The private key leaves the browser's memory with the form.
      setValues({
        ...initialValues(),
        ...Object.fromEntries(
          (connection.signedKey?.fields ?? [])
            .filter((field) => field.key !== "keyId")
            .map((field) => [field.key, field.value]),
        ),
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
          <span className="label">{field.label}</span>
          <span className="value">
            <code>{field.value}</code>
          </span>
        </div>
      ))}

      {replaced ? (
        <div className="notice" role="status">
          <p>
            {replaced.newKeyId
              ? t("replacedKey", { keyId: replaced.newKeyId })
              : t("replaced")}
          </p>
          <p>
            {replaced.oldKeyId
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
          <h3>{authFailed ? t("uploadNew", { name }) : t("replace")}</h3>
          <p className="muted">{t("checksFirst", { name })}</p>
          <SignedKeyFields
            strategy={strategy}
            values={values}
            errors={fieldErrors}
            disabled={pending}
            guideOpen={authFailed}
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
            {authFailed ? t("uploadNew", { name }) : t("replace")}
          </button>
        </div>
      )}
    </div>
  );
}
