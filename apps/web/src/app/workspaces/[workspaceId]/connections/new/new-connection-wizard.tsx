"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type {
  ConnectionPreviewResponse,
  ConnectorCatalogEntry,
} from "@netrics/contracts";

import { ConfigFields } from "../config-fields";
import { ConnectOAuthButton } from "../connect-oauth-button";
import { SignedKeyFields } from "../signed-key-fields";
import { TokenField } from "../token-field";
import {
  apiErrorMessage,
  createConnection,
  previewConnection,
} from "@/lib/api";
import {
  coerceConfigValues,
  initialConfigValues,
  parseConfigSchema,
} from "@/lib/config-schema";
import {
  oauthProviderOf,
  providerName,
  unavailableCopy,
} from "@/lib/oauth-connection";
import {
  APP_STORE_CONNECT_DOCS_URL,
  APP_STORE_CONNECT_PROVIDER,
  emptyKeyValues,
  fieldOfMessage,
  keyCredentials,
  missingKeyField,
  signedKeyStrategyOf,
} from "@/lib/signed-key";
import { useLocale } from "@/lib/i18n/client";

interface NewConnectionWizardProps {
  workspaceId: string;
  connectors: ConnectorCatalogEntry[];
}

export function NewConnectionWizard({
  workspaceId,
  connectors,
}: NewConnectionWizardProps) {
  const locale = useLocale();
  const router = useRouter();
  const [connector, setConnector] = useState<ConnectorCatalogEntry | null>(
    null,
  );
  const [name, setName] = useState("");
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [keyValues, setKeyValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [preview, setPreview] = useState<ConnectionPreviewResponse | null>(
    null,
  );
  const [selectedResources, setSelectedResources] =
    useState<Set<string> | null>(null);
  const [pending, setPending] = useState<"preview" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(
    () => (connector ? parseConfigSchema(connector.configSchema) : []),
    [connector],
  );
  const tokenStrategy = connector?.authStrategies.find(
    (strategy) => strategy.strategy === "token",
  );
  // A signed-key provider (ADR 0014) asks for its key fields instead.
  const keyStrategy = signedKeyStrategyOf(connector ?? undefined);
  const wantsToken = tokenStrategy !== undefined && keyStrategy === null;
  const appStore = keyStrategy?.provider === APP_STORE_CONNECT_PROVIDER;
  const resourceNoun = appStore ? "apps" : "resources";
  // OAuth-only connectors connect at the provider; the callback creates the
  // connection and setup continues on the return (ADR 0012).
  const oauthProvider =
    connector && !connector.authStrategies.some((s) => s.strategy !== "oauth2")
      ? oauthProviderOf(connector)
      : null;

  // Check failures show in the form they are about; create failures below.
  const errorInConfigure =
    connector !== null &&
    connector.available &&
    !oauthProvider &&
    !preview?.check.ok;

  function selectConnector(entry: ConnectorCatalogEntry) {
    setConnector(entry);
    setName(entry.name);
    setConfigValues(initialConfigValues(parseConfigSchema(entry.configSchema)));
    setToken("");
    const strategy = signedKeyStrategyOf(entry);
    setKeyValues(strategy ? emptyKeyValues(strategy) : {});
    setFieldErrors({});
    setPreview(null);
    setSelectedResources(null);
    setError(null);
  }

  /** Shows a server message next to its field, or for the whole form. */
  function showFailure(message: string) {
    const field = keyStrategy
      ? fieldOfMessage(message, keyStrategy.fields, fields)
      : null;
    if (field) {
      setFieldErrors({ [field]: message });
      setError(null);
    } else {
      setFieldErrors({});
      setError(message);
    }
  }

  function invalidatePreview() {
    setPreview(null);
    setSelectedResources(null);
  }

  function buildPayload() {
    const config = coerceConfigValues(fields, configValues);
    const credentials = keyStrategy
      ? keyCredentials(keyStrategy, keyValues)
      : wantsToken && token !== ""
        ? { token }
        : undefined;
    return { config, ...(credentials ? { credentials } : {}) };
  }

  async function onTest() {
    if (!connector) {
      return;
    }
    setError(null);
    setFieldErrors({});
    const missing = keyStrategy
      ? missingKeyField(keyStrategy, keyValues)
      : null;
    if (missing) {
      setFieldErrors({
        [missing.key]:
          missing.input === "file"
            ? `Choose the .p8 file, or paste the key.`
            : `${missing.label} is required.`,
      });
      return;
    }
    setPending("preview");
    try {
      const result = await previewConnection(workspaceId, {
        connectorId: connector.id,
        ...buildPayload(),
      });
      setPreview(result);
      setSelectedResources(new Set(result.resources.map((r) => r.id)));
      if (!result.check.ok) {
        showFailure(result.check.message ?? "The connection check failed.");
      }
    } catch (cause) {
      setPreview(null);
      showFailure(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }

  async function onCreate() {
    if (!connector) {
      return;
    }
    setError(null);
    setPending("create");
    try {
      const payload = buildPayload();
      let resources: string[] | undefined;
      if (preview && preview.resources.length > 0 && selectedResources) {
        if (selectedResources.size === 0) {
          setError(`Select at least one of the discovered ${resourceNoun}.`);
          setPending(null);
          return;
        }
        if (selectedResources.size < preview.resources.length) {
          resources = [...selectedResources];
        }
      }
      const { connection } = await createConnection(workspaceId, {
        connectorId: connector.id,
        name: name.trim() || connector.name,
        ...payload,
        ...(resources ? { resources } : {}),
      });
      router.push(`/workspaces/${workspaceId}/connections/${connection.id}`);
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(null);
    }
  }

  function toggleResource(id: string) {
    setSelectedResources((current) => {
      if (!current) {
        return current;
      }
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <>
      <div className="card">
        <h2>1. Choose a connector</h2>
        <div className="connector-cards">
          {connectors.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`connector-card ${connector?.id === entry.id ? "selected" : ""} ${entry.available ? "" : "unavailable"}`}
              onClick={() => selectConnector(entry)}
            >
              <h3>{entry.name}</h3>
              <p>{entry.description}</p>
              <p className="meta">
                {entry.unavailable
                  ? unavailableCopy(entry.unavailable).summary
                  : `v${entry.version} · ${entry.metricsCount} metrics${entry.supportsBackfill ? " · backfill" : ""}`}
              </p>
            </button>
          ))}
        </div>
      </div>

      {connector && connector.unavailable ? (
        <UnavailableConnector connector={connector} />
      ) : null}

      {connector && connector.available && oauthProvider ? (
        <div className="card">
          <h2>2. Connect with {providerName(oauthProvider)}</h2>
          <p>
            You sign in at {providerName(oauthProvider)} and allow netrics
            read-only access to your {connector.name} data. netrics never sees
            your {providerName(oauthProvider)} password. Afterwards you choose
            what this connection reads.
          </p>
          <ConnectOAuthButton
            workspaceId={workspaceId}
            connectorId={connector.id}
            provider={oauthProvider}
            returnPath={`/workspaces/${workspaceId}/connections/new`}
          />
        </div>
      ) : null}

      {connector && connector.available && !oauthProvider ? (
        <div className="card">
          <h2>
            {keyStrategy
              ? `2. Add your ${keyStrategy.providerName ?? connector.name} key`
              : "2. Configure"}
          </h2>
          {appStore ? (
            <p className="muted">
              App Store Connect has no &ldquo;Sign in with Apple&rdquo; for its
              data, so netrics reads it with a team API key that you create
              once. It takes about two minutes; netrics stores the key encrypted
              and checks it with Apple before saving.{" "}
              <a
                href={APP_STORE_CONNECT_DOCS_URL}
                target="_blank"
                rel="noreferrer"
              >
                More about the connector
              </a>
            </p>
          ) : null}
          <form className="stack" onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="connection-name">Name</label>
              <input
                id="connection-name"
                type="text"
                value={name}
                maxLength={100}
                disabled={pending !== null}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </div>
            {wantsToken ? (
              <TokenField
                id="connection-token"
                strategy={tokenStrategy}
                value={token}
                disabled={pending !== null}
                guideOpen
                onChange={(value) => {
                  setToken(value);
                  invalidatePreview();
                }}
              />
            ) : null}
            {keyStrategy ? (
              <SignedKeyFields
                strategy={keyStrategy}
                values={keyValues}
                errors={fieldErrors}
                disabled={pending !== null}
                guideOpen
                onChange={(key, value) => {
                  setKeyValues((current) => ({ ...current, [key]: value }));
                  setFieldErrors((current) => ({
                    ...current,
                    [key]: undefined,
                  }));
                  invalidatePreview();
                }}
              />
            ) : null}
            <ConfigFields
              fields={fields}
              values={configValues}
              errors={fieldErrors}
              disabled={pending !== null}
              onChange={(key, value) => {
                setConfigValues((current) => ({ ...current, [key]: value }));
                setFieldErrors((current) => ({ ...current, [key]: undefined }));
                invalidatePreview();
              }}
            />
            <div className="actions">
              <button
                type="button"
                className={keyStrategy ? "primary" : undefined}
                disabled={pending !== null}
                onClick={onTest}
              >
                {pending === "preview"
                  ? keyStrategy
                    ? "Checking with Apple…"
                    : "Testing…"
                  : keyStrategy
                    ? "Check key and find apps"
                    : "Test connection"}
              </button>
            </div>
            {error && errorInConfigure ? (
              <div className="error" role="alert">
                {error}
              </div>
            ) : null}
          </form>
        </div>
      ) : null}

      {preview && preview.check.ok ? (
        <div className="card">
          <h2>
            {appStore ? "3. Choose apps and create" : "3. Review and create"}
          </h2>
          <div className="notice">
            Connection check passed
            {preview.check.message ? `: ${preview.check.message}` : "."}
          </div>
          {preview.resources.length > 0 ? (
            <>
              <p className="muted">
                Found {preview.resources.length} {resourceNoun} — uncheck any
                you do not want to sync.
              </p>
              <ul className="workspace-list">
                {preview.resources.map((resource) => (
                  <li key={resource.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedResources?.has(resource.id) ?? true}
                        onChange={() => toggleResource(resource.id)}
                      />{" "}
                      {resource.name}{" "}
                      <span className="muted">({resource.kind})</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={pending !== null}
              onClick={onCreate}
            >
              {pending === "create" ? "Creating…" : "Create connection"}
            </button>
          </div>
        </div>
      ) : null}

      {error && !errorInConfigure ? <div className="error">{error}</div> : null}
    </>
  );
}

function UnavailableConnector({
  connector,
}: {
  connector: ConnectorCatalogEntry;
}) {
  const copy = unavailableCopy(connector.unavailable!);
  return (
    <div className="card">
      <h2>{connector.name} is not available here</h2>
      <p className="break-anywhere">{copy.detail}</p>
      {copy.guideUrl ? (
        <p className="muted">
          Running netrics yourself?{" "}
          <a href={copy.guideUrl} target="_blank" rel="noreferrer">
            Read the setup guide
          </a>
          .
        </p>
      ) : null}
    </div>
  );
}
