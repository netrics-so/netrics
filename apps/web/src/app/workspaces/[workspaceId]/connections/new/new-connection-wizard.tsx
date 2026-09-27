"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type {
  ConnectionPreviewResponse,
  ConnectorCatalogEntry,
} from "@netrics/contracts";

import { ConfigFields } from "../config-fields";
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

interface NewConnectionWizardProps {
  workspaceId: string;
  connectors: ConnectorCatalogEntry[];
}

export function NewConnectionWizard({
  workspaceId,
  connectors,
}: NewConnectionWizardProps) {
  const router = useRouter();
  const [connector, setConnector] = useState<ConnectorCatalogEntry | null>(
    null,
  );
  const [name, setName] = useState("");
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
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
  const wantsToken = connector?.authStrategies.some(
    (strategy) => strategy.strategy === "token",
  );

  function selectConnector(entry: ConnectorCatalogEntry) {
    setConnector(entry);
    setName(entry.name);
    setConfigValues(initialConfigValues(parseConfigSchema(entry.configSchema)));
    setToken("");
    setPreview(null);
    setSelectedResources(null);
    setError(null);
  }

  function invalidatePreview() {
    setPreview(null);
    setSelectedResources(null);
  }

  function buildPayload() {
    const config = coerceConfigValues(fields, configValues);
    const credentials = wantsToken && token !== "" ? { token } : undefined;
    return { config, ...(credentials ? { credentials } : {}) };
  }

  async function onTest() {
    if (!connector) {
      return;
    }
    setError(null);
    setPending("preview");
    try {
      const result = await previewConnection(workspaceId, {
        connectorId: connector.id,
        ...buildPayload(),
      });
      setPreview(result);
      setSelectedResources(new Set(result.resources.map((r) => r.id)));
      if (!result.check.ok) {
        setError(result.check.message ?? "The connection check failed.");
      }
    } catch (cause) {
      setPreview(null);
      setError(apiErrorMessage(cause));
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
          setError("Select at least one discovered resource.");
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
      setError(apiErrorMessage(cause));
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
              className={`connector-card ${connector?.id === entry.id ? "selected" : ""}`}
              onClick={() => selectConnector(entry)}
            >
              <h3>{entry.name}</h3>
              <p>{entry.description}</p>
              <p className="meta">
                v{entry.version} · {entry.metricsCount} metrics
                {entry.supportsBackfill ? " · backfill" : ""}
              </p>
            </button>
          ))}
        </div>
      </div>

      {connector ? (
        <div className="card">
          <h2>2. Configure</h2>
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
            <ConfigFields
              fields={fields}
              values={configValues}
              disabled={pending !== null}
              onChange={(key, value) => {
                setConfigValues((current) => ({ ...current, [key]: value }));
                invalidatePreview();
              }}
            />
            {wantsToken ? (
              <div className="field">
                <label htmlFor="connection-token">Access token</label>
                <input
                  id="connection-token"
                  type="password"
                  value={token}
                  autoComplete="off"
                  disabled={pending !== null}
                  onChange={(event) => {
                    setToken(event.target.value);
                    invalidatePreview();
                  }}
                />
              </div>
            ) : null}
            <div className="actions">
              <button
                type="button"
                disabled={pending !== null}
                onClick={onTest}
              >
                {pending === "preview" ? "Testing…" : "Test connection"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {preview && preview.check.ok ? (
        <div className="card">
          <h2>3. Review and create</h2>
          <div className="notice">
            Connection check passed
            {preview.check.message ? `: ${preview.check.message}` : "."}
          </div>
          {preview.resources.length > 0 ? (
            <>
              <p className="muted">
                Discovered {preview.resources.length} resources — uncheck any
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

      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
