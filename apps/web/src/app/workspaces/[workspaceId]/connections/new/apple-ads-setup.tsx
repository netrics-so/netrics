"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type {
  ConnectionPreviewResponse,
  ConnectorCatalogEntry,
  SignedKeyPairResponse,
} from "@netrics/contracts";

import { SignedKeyFields } from "../signed-key-fields";
import {
  apiErrorMessage,
  createConnections,
  previewConnection,
} from "@/lib/api";
import { appleAdsAccounts, type AppleAdsAccount } from "@/lib/apple-ads";
import {
  APPLE_ADS_DOCS_URL,
  APPLE_ADS_INVITE_HELP_URL,
  APPLE_ADS_URL,
  emptyKeyValues,
  fieldOfMessage,
  keyPayload,
  localizedFieldLabel,
  missingKeyFieldWith,
  type SignedKeyStrategy,
} from "@/lib/signed-key";
import { useLocale, useT } from "@/lib/i18n/client";

interface AppleAdsSetupProps {
  workspaceId: string;
  connector: ConnectorCatalogEntry;
  strategy: SignedKeyStrategy;
}

/**
 * The guided Apple Ads setup (ADR 0020 §4 and §5, #375): an API user of
 * the customer's own account, a key pair netrics generates (the public key
 * to paste in Apple Ads, the private key never shown), the three IDs Apple
 * Ads then shows, checked as they are typed, and the check with Apple that
 * lists the ad accounts. Every ad account chosen becomes its own
 * connection, all created in one request from the one key.
 */
export function AppleAdsSetup({
  workspaceId,
  connector,
  strategy,
}: AppleAdsSetupProps) {
  const locale = useLocale();
  const t = useT("connections.appleAds");
  const router = useRouter();
  const [values, setValues] = useState(() => emptyKeyValues(strategy));
  const [keyPair, setKeyPair] = useState<SignedKeyPairResponse | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [preview, setPreview] = useState<ConnectionPreviewResponse | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<"preview" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Step 2 is the key pair, step 3 the IDs: one strategy, two forms.
  const keyFields = useMemo(
    () => ({
      ...strategy,
      setup: undefined,
      fields: strategy.fields.filter((field) => field.input === "file"),
    }),
    [strategy],
  );
  const idFields = useMemo(
    () => ({
      ...strategy,
      setup: undefined,
      fields: strategy.fields.filter((field) => field.input !== "file"),
    }),
    [strategy],
  );
  const accounts = useMemo(
    () => (preview?.check.ok ? appleAdsAccounts(preview.resources) : []),
    [preview],
  );

  function invalidate() {
    setPreview(null);
    setSelected(new Set());
  }

  function onChange(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
    invalidate();
  }

  function showFailure(message: string) {
    const field = fieldOfMessage(message, strategy.fields);
    if (field) {
      setFieldErrors({ [field]: message });
      setError(null);
    } else {
      setFieldErrors({});
      setError(message);
    }
  }

  async function onCheck() {
    setError(null);
    setFieldErrors({});
    const missing = missingKeyFieldWith(strategy, values, keyPair !== null);
    if (missing) {
      setFieldErrors({
        [missing.key]:
          missing.input === "file"
            ? t("generateFirst")
            : t("fieldRequired", {
                field: localizedFieldLabel(strategy, missing, locale),
              }),
      });
      return;
    }
    setPending("preview");
    try {
      const result = await previewConnection(workspaceId, {
        connectorId: connector.id,
        config: {},
        ...keyPayload(strategy, values, keyPair?.pendingKeyId ?? null),
      });
      setPreview(result);
      if (!result.check.ok) {
        showFailure(result.check.message ?? t("checkFailed"));
        return;
      }
      // The first account that can be connected is chosen; more can be.
      const first = appleAdsAccounts(result.resources).find(
        (account) => account.selectable,
      );
      setSelected(new Set(first ? [first.id] : []));
    } catch (cause) {
      setPreview(null);
      showFailure(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }

  async function onCreate() {
    setError(null);
    const chosen = accounts.filter(
      (account) => account.selectable && selected.has(account.id),
    );
    if (chosen.length === 0) {
      setError(t("selectAccount"));
      return;
    }
    setPending("create");
    try {
      const { connections } = await createConnections(workspaceId, {
        connectorId: connector.id,
        ...keyPayload(strategy, values, keyPair?.pendingKeyId ?? null),
        connections: chosen.map((account) => ({
          name: t("connectionName", { account: account.name }).slice(0, 100),
          config: {
            adAccountId: account.id,
            adAccountName: account.name,
            ...(account.currency ? { currency: account.currency } : {}),
            ...(account.timeZone ? { timeZone: account.timeZone } : {}),
          },
        })),
      });
      // The generated key moved into the connections.
      setKeyPair(null);
      router.push(
        connections.length === 1
          ? `/workspaces/${workspaceId}/connections/${connections[0]!.id}`
          : `/workspaces/${workspaceId}/sources`,
      );
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(null);
    }
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const disabled = pending !== null;
  const selectableCount = accounts.filter((a) => a.selectable).length;

  return (
    <div className="card apple-ads-setup">
      <h2>{t("title")}</h2>
      <p className="muted">
        {t("intro")}{" "}
        <a href={APPLE_ADS_DOCS_URL} target="_blank" rel="noreferrer">
          {t("moreAboutConnector")}
        </a>
      </p>

      <section className="setup-step" aria-labelledby="apple-ads-step-1">
        <h3 id="apple-ads-step-1">1. {t("step1Title")}</h3>
        <p>{t("step1Body")}</p>
        <p className="help">
          <a href={APPLE_ADS_URL} target="_blank" rel="noreferrer">
            {t("openUserManagement")} ↗
          </a>{" "}
          ·{" "}
          <a href={APPLE_ADS_INVITE_HELP_URL} target="_blank" rel="noreferrer">
            {t("inviteHelp")} ↗
          </a>
        </p>
      </section>

      <section className="setup-step" aria-labelledby="apple-ads-step-2">
        <h3 id="apple-ads-step-2">2. {t("step2Title")}</h3>
        <p>{t("step2Body")}</p>
        <SignedKeyFields
          strategy={keyFields}
          values={values}
          errors={fieldErrors}
          disabled={disabled}
          idPrefix="apple-ads-"
          keyPair={{
            workspaceId,
            value: keyPair,
            onChange: (value) => {
              setKeyPair(value);
              setFieldErrors({});
              invalidate();
            },
          }}
          onChange={onChange}
        />
        <p className="help">
          <a href={APPLE_ADS_URL} target="_blank" rel="noreferrer">
            {t("openApi")} ↗
          </a>
        </p>
        <p className="help">{t("oneKeyNote")}</p>
      </section>

      <section className="setup-step" aria-labelledby="apple-ads-step-3">
        <h3 id="apple-ads-step-3">3. {t("step3Title")}</h3>
        <p>{t("step3Body")}</p>
        <form className="stack" onSubmit={(event) => event.preventDefault()}>
          <SignedKeyFields
            strategy={idFields}
            values={values}
            errors={fieldErrors}
            disabled={disabled}
            idPrefix="apple-ads-"
            onChange={onChange}
          />
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={disabled}
              onClick={onCheck}
            >
              {pending === "preview" ? t("checking") : t("checkKey")}
            </button>
          </div>
          {error && !preview?.check.ok ? (
            <div className="error" role="alert">
              {error}
            </div>
          ) : null}
        </form>
      </section>

      {preview?.check.ok ? (
        <section className="setup-step" aria-labelledby="apple-ads-step-4">
          <h3 id="apple-ads-step-4">4. {t("step4Title")}</h3>
          <p className="muted">{t("found", { count: accounts.length })}</p>
          {selectableCount === 0 ? (
            <div className="error" role="alert">
              {t("noneSelectable")}
            </div>
          ) : null}
          <ul className="workspace-list ad-account-list">
            {accounts.map((account) => (
              <AdAccountOption
                key={account.id}
                account={account}
                checked={selected.has(account.id)}
                disabled={disabled}
                onToggle={() => toggle(account.id)}
              />
            ))}
          </ul>
          {selectableCount > 1 ? (
            <p className="help">{t("addAnother")}</p>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={disabled || selected.size === 0}
              onClick={onCreate}
            >
              {pending === "create"
                ? t("creating")
                : t("create", { count: Math.max(selected.size, 1) })}
            </button>
          </div>
          {error ? (
            <div className="error" role="alert">
              {error}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function AdAccountOption({
  account,
  checked,
  disabled,
  onToggle,
}: {
  account: AppleAdsAccount;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const t = useT("connections.appleAds");
  const reason =
    account.unselectable === "maps"
      ? t("notSelectableMaps")
      : account.unselectable === "role"
        ? t("notSelectableRole")
        : account.unselectable === "other"
          ? t("notSelectableOther")
          : null;
  return (
    <li>
      <label className={reason ? "muted" : undefined}>
        <input
          type="checkbox"
          checked={checked && !reason}
          disabled={disabled || reason !== null}
          onChange={onToggle}
        />{" "}
        <strong>{account.name}</strong>{" "}
        <span className="muted">{t("accountId", { id: account.id })}</span>
        {account.currency && account.timeZone ? (
          <>
            <br />
            <span className="muted">
              {t("accountMeta", {
                currency: account.currency,
                timeZone: account.timeZone,
              })}
            </span>
          </>
        ) : null}
        {reason ? (
          <>
            <br />
            <span className="help">{reason}</span>
          </>
        ) : null}
      </label>
    </li>
  );
}
