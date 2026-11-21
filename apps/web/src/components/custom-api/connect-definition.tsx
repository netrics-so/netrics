"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { CustomApiDefinitionResponse } from "@netrics/contracts";

import { ProjectSelect } from "@/components/project-select";
import { apiErrorMessage, updateConnection } from "@/lib/api";
import { connectDefinition, startCustomOAuth } from "@/lib/custom-api";
import { credentialNames } from "@/lib/custom-api-builder";
import { useLocale, useT } from "@/lib/i18n/client";

import { SecretInputs, useCredentialEntries } from "./step-login";

type Definition = CustomApiDefinitionResponse["definition"];

export type ConnectClient = {
  connectDefinition: typeof connectDefinition;
  startCustomOAuth: typeof startCustomOAuth;
  updateConnection: typeof updateConnection;
};

/** What "Connect" sends: values split into plain, secret and the login's credentials. */
export function connectRequest(
  definition: Definition,
  input: {
    name: string;
    environmentId: string;
    values: Readonly<Record<string, string>>;
    secrets: Readonly<Record<string, string>>;
    projectId: string | null;
  },
) {
  const document = definition.document;
  const variables: Record<string, string> = {};
  const secretVariables: Record<string, string> = {};
  for (const variable of document.variables) {
    if (variable.secret) {
      const value = input.secrets[variable.id];
      if (value) secretVariables[variable.id] = value;
    } else {
      const value = input.values[variable.id]?.trim();
      if (value) variables[variable.id] = value;
    }
  }
  const credentials: Record<string, string> = {};
  for (const name of credentialNames(document.auth)) {
    const value = input.secrets[name];
    if (value) credentials[name] = value;
  }
  return {
    name: input.name.trim(),
    environmentId: input.environmentId,
    variables,
    secretVariables,
    credentials,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
}

/**
 * Creates the connection (unless an earlier attempt did) and, for OAuth
 * (authorization code), starts its sign-in.
 */
export async function connectAndSignIn(
  api: ConnectClient,
  input: {
    workspaceId: string;
    definitionId: string;
    /** Created by an earlier attempt: not created again. */
    connectionId: string | null;
    oauth: boolean;
    body: ReturnType<typeof connectRequest>;
    onCreated: (connectionId: string) => void;
  },
): Promise<{ connectionId: string; authorizationUrl: string | null }> {
  let connectionId = input.connectionId;
  if (connectionId !== null) {
    // A retry: the connection takes the form as it is now. An OAuth
    // connection keeps its environment (its grant is bound to it, C-G4); a
    // new client ID there leaves it needing the sign-in that follows
    // (purpose reauthorize).
    const { body } = input;
    await api.updateConnection(input.workspaceId, connectionId, {
      name: body.name,
      config: body.variables,
      projectId: body.projectId ?? null,
      ...(input.oauth ? {} : { customApiEnvironmentId: body.environmentId }),
      ...(Object.keys(body.credentials).length
        ? { credentials: body.credentials }
        : {}),
      ...(!input.oauth && Object.keys(body.secretVariables).length
        ? { secretVariables: body.secretVariables }
        : {}),
    });
  } else {
    const { connection } = await api.connectDefinition(
      input.workspaceId,
      input.definitionId,
      input.body,
    );
    connectionId = connection.id;
    input.onCreated(connectionId);
  }
  if (!input.oauth) return { connectionId, authorizationUrl: null };
  const { authorizationUrl } = await api.startCustomOAuth(
    input.workspaceId,
    connectionId,
  );
  return { connectionId, authorizationUrl };
}

/**
 * Connect an existing custom API (#807): environment, connection values,
 * the login's secrets and a project; OAuth (authorization code) then signs
 * in at the provider.
 */
export function ConnectDefinition({
  workspaceId,
  definition,
  projects,
  api = { connectDefinition, startCustomOAuth, updateConnection },
}: {
  workspaceId: string;
  definition: Definition;
  projects: ReadonlyArray<{
    id: string;
    name: string;
    archivedAt: string | null;
  }>;
  api?: ConnectClient;
}) {
  const t = useT("customApi");
  const locale = useLocale();
  const router = useRouter();
  const document = definition.document;
  const environments = document.environments;
  const [environmentId, setEnvironmentId] = useState(environments[0]!.id);
  const environmentName =
    environments.find((e) => e.id === environmentId)?.name ?? "";
  const [name, setName] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [projectId, setProjectId] = useState<string | null>(
    definition.projectId,
  );
  const [pending, setPending] = useState(false);
  // The connection created by an earlier attempt whose sign-in did not
  // start: a retry signs it in instead of creating another one.
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const credentialEntries = useCredentialEntries(document.auth);
  const secretEntries = [
    ...document.variables
      .filter((v) => v.secret)
      .map((v) => ({ name: v.id, label: v.label })),
    ...credentialEntries,
  ];
  const shownName =
    name ??
    (environments.length > 1
      ? `${definition.name} (${environmentName})`
      : definition.name);
  const oauthCode = document.auth.type === "oauth_authorization_code";

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const result = await connectAndSignIn(api, {
        workspaceId,
        definitionId: definition.id,
        connectionId: created,
        oauth: oauthCode,
        body: connectRequest(definition, {
          name: shownName,
          environmentId,
          values,
          secrets,
          projectId,
        }),
        onCreated: setCreated,
      });
      if (result.authorizationUrl) {
        window.location.assign(result.authorizationUrl);
        return;
      }
      router.push(
        `/workspaces/${workspaceId}/connections/${result.connectionId}`,
      );
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(false);
    }
  }

  return (
    <form
      className="card custom-api-form custom-api-connect"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="field">
        <label htmlFor="custom-api-connect-name">{t("connect.name")}</label>
        <input
          id="custom-api-connect-name"
          value={shownName}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {environments.length > 1 ? (
        <div className="field">
          <label htmlFor="custom-api-connect-environment">
            {t("connect.environment")}
          </label>
          <select
            id="custom-api-connect-environment"
            value={environmentId}
            // An OAuth connection, once created, keeps its environment.
            disabled={oauthCode && created !== null}
            onChange={(event) => setEnvironmentId(event.target.value)}
          >
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name} ({environment.baseUrl})
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {document.variables.some((v) => !v.secret) ? (
        <fieldset className="field">
          <legend>{t("connect.values")}</legend>
          {document.variables
            .filter((v) => !v.secret)
            .map((variable) => (
              <div className="field" key={variable.id}>
                <label htmlFor={`custom-api-connect-${variable.id}`}>
                  {variable.label}
                </label>
                <input
                  id={`custom-api-connect-${variable.id}`}
                  value={values[variable.id] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [variable.id]: event.target.value,
                    }))
                  }
                />
              </div>
            ))}
        </fieldset>
      ) : null}
      <SecretInputs
        entries={secretEntries}
        stored={[]}
        values={secrets}
        idPrefix="custom-api-connect-secret"
        onChange={(key, value) =>
          setSecrets((current) => ({ ...current, [key]: value ?? "" }))
        }
      />
      <div className="field">
        <label htmlFor="custom-api-connect-project">
          {t("basics.project")}
        </label>
        <ProjectSelect
          id="custom-api-connect-project"
          projects={projects}
          value={projectId}
          onChange={setProjectId}
        />
      </div>
      {oauthCode ? <p className="help">{t("connect.signInNext")}</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="custom-api-actions">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? t("connect.submitting") : t("connect.submit")}
        </button>
      </div>
    </form>
  );
}
