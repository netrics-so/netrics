// The effective manifest of one custom-api connection: built per call from
// the connection's pinned definition version and environment (ADR 0027).

import type {
  AuthStrategy,
  ConnectorManifest,
  DatasetField,
  SourceDatasetDefinition,
} from "@netrics/connector-sdk";
import type {
  CustomApiDefinition,
  CustomApiEnvironment,
  CustomApiField,
} from "@netrics/connector-sdk/custom-api";
import { customApiConfigSchema } from "@netrics/connector-sdk/custom-api";

import { CustomApiConfigError } from "./errors.js";

export { CustomApiConfigError } from "./errors.js";

export const CUSTOM_API_CONNECTOR_ID = "custom-api";

/** What a custom-api connection is pinned to. */
export interface CustomApiPin {
  definitionId: string;
  versionId: string;
  version: number;
  environmentId: string;
  /** Dataset version per stream key, as stored with the definition version. */
  datasetVersions: Readonly<Record<string, number>>;
}

export function customApiEnvironment(
  definition: Pick<CustomApiDefinition, "environments">,
  environmentId: string,
): CustomApiEnvironment {
  const environment = definition.environments.find(
    (entry) => entry.id === environmentId,
  );
  if (!environment)
    throw new CustomApiConfigError(
      "The connection's environment is not part of its custom API definition",
    );
  return environment;
}

/** The host (with a non-default port) credentials of an environment are bound to. */
export function customApiEnvironmentHost(
  environment: Pick<CustomApiEnvironment, "baseUrl">,
): string {
  return new URL(environment.baseUrl).host;
}

function hostname(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, "");
}

/**
 * Hosts credentials may go to: the environment host first, then the
 * tokenUrl/revokeUrl hosts of the OAuth types (sorted). Unique. Not the
 * authorize URL, which is a browser redirect. Host names without ports, as
 * egress compares them.
 */
export function customApiCredentialHosts(
  definition: Pick<CustomApiDefinition, "environments" | "auth">,
  environmentId: string,
): string[] {
  const environment = hostname(
    customApiEnvironment(definition, environmentId).baseUrl,
  );
  const auth = definition.auth;
  const endpoints =
    auth.type === "oauth_client_credentials"
      ? [auth.tokenUrl]
      : auth.type === "oauth_authorization_code"
        ? [auth.tokenUrl, ...(auth.revokeUrl ? [auth.revokeUrl] : [])]
        : [];
  const others = [...new Set(endpoints.map(hostname))]
    .filter((host) => host !== environment)
    .sort();
  return [environment, ...others];
}

function datasetField(field: CustomApiField): DatasetField {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    nullable: field.nullable,
    classification: field.classification,
    ...(field.retentionDays !== undefined
      ? { retentionDays: field.retentionDays }
      : {}),
    ...(field.unit !== undefined ? { unit: field.unit } : {}),
    ...(field.currencyField !== undefined
      ? { currencyField: field.currencyField }
      : {}),
    ...(field.scale !== undefined ? { scale: field.scale } : {}),
    ...(field.role !== undefined ? { role: field.role } : {}),
  };
}

/** The configuration schema (shared with the web form, #830). */
export { customApiConfigSchema };

function authStrategies(definition: CustomApiDefinition): AuthStrategy[] {
  const token = (properties: Record<string, { title: string }>) => [
    {
      strategy: "token" as const,
      credentialsSchema: {
        type: "object",
        properties,
        required: Object.keys(properties),
      },
    },
  ];
  switch (definition.auth.type) {
    case "api_key":
      return token({ apiKey: { title: "API key" } });
    case "bearer":
      return token({ token: { title: "Token" } });
    case "basic":
      return token({
        username: { title: "Username" },
        password: { title: "Password" },
      });
    default:
      // none, and the OAuth types: the host applies OAuth through
      // connection_oauth (provider "custom"); no generic path reaches it.
      return [{ strategy: "none" }];
  }
}

/** Valid per assertManifestCompatible (sdkVersion "^0.2.17"). */
export function customApiManifest(
  definition: CustomApiDefinition,
  pin: CustomApiPin,
): ConnectorManifest {
  const credentialHosts = customApiCredentialHosts(
    definition,
    pin.environmentId,
  );
  const datasets: SourceDatasetDefinition[] = definition.streams.map(
    (stream) => {
      const version = pin.datasetVersions[stream.key];
      if (version === undefined)
        throw new CustomApiConfigError(
          "The connection's definition version has no dataset version for a stream",
        );
      const reporting = stream.fields.find(
        (field) => field.id === stream.reportingField,
      );
      return {
        key: stream.key,
        name: stream.name,
        version,
        fields: stream.fields.map(datasetField),
        keyFields: [...stream.keyFields],
        grain: `One record per ${stream.keyFields.join(", ")}`,
        mode: stream.mode,
        ...(stream.reportingField !== undefined
          ? { reportingField: stream.reportingField }
          : {}),
        ...(reporting?.type === "date"
          ? { reportingTimeZone: definition.defaults.timeZone }
          : {}),
        retentionDays: stream.retentionDays,
      };
    },
  );
  const windowed = definition.streams.flatMap((stream) =>
    stream.window.type === "none" ? [] : [stream.window.backfillDays],
  );
  const outboundDomains = [
    ...new Set([...credentialHosts, ...(definition.images?.hosts ?? [])]),
  ];
  return {
    id: CUSTOM_API_CONNECTOR_ID,
    version: `1.0.${pin.version}`,
    sdkVersion: "^0.2.17",
    name: definition.name,
    description: "A custom API defined in this workspace.",
    category: "other",
    authStrategies: authStrategies(definition),
    configSchema: customApiConfigSchema(definition),
    datasets,
    metrics: [],
    minRefreshIntervalSeconds: definition.defaults.refreshMinutes * 60,
    supportsBackfill: true,
    backfillDays: windowed.length ? Math.max(...windowed) : 1,
    outboundDomains,
  };
}
