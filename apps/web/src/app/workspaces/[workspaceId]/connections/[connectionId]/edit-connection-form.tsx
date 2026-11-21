"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import type {
  ConnectionDetail,
  ConnectorCatalogEntry,
  CustomApiVariable,
  UpdateConnectionRequest,
} from "@netrics/contracts";

import { ConfigFields } from "../config-fields";
import { TokenField } from "../token-field";
import { apiErrorMessage, updateConnection } from "@/lib/api";
import {
  coerceConfigValues,
  initialConfigValues,
  parseConfigSchema,
  type ConfigField,
} from "@/lib/config-schema";
import { APPLE_ADS_CONNECTOR_ID, signedKeyStrategyOf } from "@/lib/signed-key";
import { useLocale, useT } from "@/lib/i18n/client";

interface EditConnectionFormProps {
  workspaceId: string;
  connection: ConnectionDetail;
  connector: ConnectorCatalogEntry | undefined;
  /** A custom API connection's pinned version's variables (#830). */
  customApiVariables?: readonly CustomApiVariable[];
}

/**
 * A custom API connection's config fields (#830): its pinned version's
 * plain (non-secret) values, each required, as the server's
 * `customApiConfigSchema` (packages/connectors) describes them.
 */
export function customApiConfigFields(
  variables: readonly CustomApiVariable[],
): ConfigField[] {
  const plain = variables.filter((variable) => !variable.secret);
  return parseConfigSchema({
    type: "object",
    properties: Object.fromEntries(
      plain.map((variable) => [
        variable.id,
        { type: "string", title: variable.label, minLength: 1, maxLength: 500 },
      ]),
    ),
    required: plain.map((variable) => variable.id),
    additionalProperties: false,
  });
}

/**
 * What "Save changes" sends. A custom API connection sends its values only
 * when they changed: a config change is checked against the API (with a
 * fresh token for OAuth), which a name change should not need.
 */
export function editConnectionRequest(input: {
  connection: ConnectionDetail;
  name: string;
  fields: ConfigField[];
  configValues: Record<string, string>;
  token: string;
  fixedConfig: boolean;
}): UpdateConnectionRequest {
  const { connection } = input;
  const customApi = connection.customApi != null;
  const config = coerceConfigValues(input.fields, input.configValues);
  const configChanged = input.fields.some(
    (field) => config[field.key] !== connection.config[field.key],
  );
  const sendConfig =
    !input.fixedConfig &&
    (customApi ? input.fields.length > 0 && configChanged : true);
  return {
    ...(input.name.trim() !== connection.name
      ? { name: input.name.trim() }
      : {}),
    ...(sendConfig ? { config } : {}),
    ...(input.token !== "" ? { credentials: { token: input.token } } : {}),
  };
}

export function EditConnectionForm({
  workspaceId,
  connection,
  connector,
  customApiVariables,
}: EditConnectionFormProps) {
  const locale = useLocale();
  const t = useT("connections.edit");
  const common = useT("common");
  const router = useRouter();
  // An Apple Ads connection's config is its ad account as Apple named it
  // (#375): shown on the page, chosen in the setup, never typed here.
  const fixedConfig = connection.connectorId === APPLE_ADS_CONNECTOR_ID;
  // A custom API (#808): its login is changed by the login panel; its
  // name and plain values (#830) are edited here.
  const customApi = connection.customApi != null;
  const fields = useMemo(
    () =>
      customApi
        ? customApiConfigFields(customApiVariables ?? [])
        : connector && !fixedConfig
          ? parseConfigSchema(connector.configSchema)
          : [],
    [connector, fixedConfig, customApi, customApiVariables],
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
    !customApi &&
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
      await updateConnection(
        workspaceId,
        connection.id,
        editConnectionRequest({
          connection,
          name,
          fields,
          configValues,
          token,
          fixedConfig,
        }),
      );
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
      {customApi ? (
        fields.length > 0 ? (
          <ConfigFields
            fields={fields}
            values={configValues}
            disabled={pending}
            onChange={(key, value) =>
              setConfigValues((current) => ({ ...current, [key]: value }))
            }
          />
        ) : null
      ) : fixedConfig ? null : connector ? (
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
