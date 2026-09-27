"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import type {
  ConnectionDetail,
  ConnectorCatalogEntry,
} from "@netrics/contracts";

import { ConfigFields } from "../config-fields";
import { apiErrorMessage, updateConnection } from "@/lib/api";
import {
  coerceConfigValues,
  initialConfigValues,
  parseConfigSchema,
} from "@/lib/config-schema";

interface EditConnectionFormProps {
  workspaceId: string;
  connection: ConnectionDetail;
  connector: ConnectorCatalogEntry | undefined;
}

export function EditConnectionForm({
  workspaceId,
  connection,
  connector,
}: EditConnectionFormProps) {
  const router = useRouter();
  const fields = useMemo(
    () => (connector ? parseConfigSchema(connector.configSchema) : []),
    [connector],
  );
  const [name, setName] = useState(connection.name);
  const [configValues, setConfigValues] = useState<Record<string, string>>(() =>
    initialConfigValues(fields, connection.config),
  );
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const wantsToken =
    connector?.authStrategies.some(
      (strategy) => strategy.strategy === "token",
    ) || connection.hasCredentials;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      await updateConnection(workspaceId, connection.id, {
        ...(name.trim() !== connection.name ? { name: name.trim() } : {}),
        config: coerceConfigValues(fields, configValues),
        ...(token !== "" ? { credentials: { token } } : {}),
      });
      setToken("");
      setNotice("Connection updated.");
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="edit-name">Name</label>
        <input
          id="edit-name"
          type="text"
          required
          maxLength={100}
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {connector ? (
        <ConfigFields
          fields={fields}
          values={configValues}
          disabled={pending}
          onChange={(key, value) =>
            setConfigValues((current) => ({ ...current, [key]: value }))
          }
        />
      ) : (
        <p className="muted">
          Connector {connection.connectorId} is not in the deployed bundle;
          config editing is unavailable.
        </p>
      )}
      {wantsToken ? (
        <div className="field">
          <label htmlFor="edit-token">
            Access token (leave empty to keep the current one)
          </label>
          <input
            id="edit-token"
            type="password"
            value={token}
            autoComplete="new-password"
            disabled={pending}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
      ) : null}
      <div className="actions">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </form>
  );
}
