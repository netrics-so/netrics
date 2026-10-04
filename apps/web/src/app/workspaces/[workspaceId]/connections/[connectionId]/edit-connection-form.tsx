"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import type {
  ConnectionDetail,
  ConnectorCatalogEntry,
} from "@netrics/contracts";

import { ConfigFields } from "../config-fields";
import { TokenField } from "../token-field";
import { apiErrorMessage, updateConnection } from "@/lib/api";
import {
  coerceConfigValues,
  initialConfigValues,
  parseConfigSchema,
} from "@/lib/config-schema";
import { signedKeyStrategyOf } from "@/lib/signed-key";
import { useLocale, useT } from "@/lib/i18n/client";

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
  const locale = useLocale();
  const t = useT("connections.edit");
  const common = useT("common");
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

  const tokenStrategy = connector?.authStrategies.find(
    (strategy) => strategy.strategy === "token",
  );
  // An OAuth connection's credentials are its grant: renewed by reconnecting
  // at the provider, never by pasting a token (ADR 0012).
  // A signed key (ADR 0014) is replaced in its own panel, never here.
  const wantsToken =
    connection.oauth === null &&
    signedKeyStrategyOf(connector) === null &&
    (tokenStrategy !== undefined || connection.hasCredentials);
  const needsToken = connection.state.authState === "auth_failed";

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
      setNotice(t("updated"));
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="edit-name">{t("name")}</label>
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
      {wantsToken ? (
        <TokenField
          id="edit-token"
          strategy={tokenStrategy}
          value={token}
          disabled={pending}
          replacing
          guideOpen={needsToken}
          onChange={setToken}
        />
      ) : null}
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
          {t("connectorMissing", { connector: connection.connectorId })}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? common("saving") : t("saveChanges")}
        </button>
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </form>
  );
}
