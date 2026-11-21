"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type {
  ConnectionDetail,
  CustomApiAuth,
  CustomApiVariable,
} from "@netrics/contracts";

import { apiErrorMessage, updateConnection } from "@/lib/api";
import { startCustomOAuth } from "@/lib/custom-api";
import { useLocale, useT } from "@/lib/i18n/client";

import { SecretInputs, type SecretEntry } from "./step-login";

/** The credential names of a login method (secret variables aside). */
export function credentialNames(method: CustomApiAuth["type"]): string[] {
  switch (method) {
    case "api_key":
      return ["apiKey"];
    case "bearer":
      return ["token"];
    case "basic":
      return ["username", "password"];
    case "oauth_client_credentials":
    case "oauth_authorization_code":
      return ["clientId", "clientSecret"];
    case "none":
      return [];
  }
}

export const isOAuthMethod = (method: CustomApiAuth["type"]) =>
  method === "oauth_client_credentials" ||
  method === "oauth_authorization_code";

/** The inputs a login needs: the method's credentials, then secret values. */
export function loginEntries(
  method: CustomApiAuth["type"],
  variables: readonly CustomApiVariable[],
  label: (name: string) => string,
): SecretEntry[] {
  return [
    ...credentialNames(method).map((name) => ({ name, label: label(name) })),
    ...(isOAuthMethod(method)
      ? []
      : variables
          .filter((variable) => variable.secret)
          .map((variable) => ({ name: variable.id, label: variable.label }))),
  ];
}

export interface ConnectionLoginClient {
  updateConnection: typeof updateConnection;
  startCustomOAuth: typeof startCustomOAuth;
}

/**
 * Saves a custom API connection's login (PATCH): credentials, and for the
 * methods without OAuth the secret values. A custom OAuth client goes the
 * same way (#805); says whether an authorization-code connection needs a
 * sign-in afterwards (a new client ID, or a login an update dropped).
 */
export async function saveConnectionLogin(
  client: ConnectionLoginClient,
  input: {
    workspaceId: string;
    connectionId: string;
    method: CustomApiAuth["type"];
    secretVariableIds: readonly string[];
    values: Record<string, string>;
  },
): Promise<{ needsSignIn: boolean; connection: ConnectionDetail }> {
  const pick = (names: readonly string[]) =>
    Object.fromEntries(
      names.flatMap((name) =>
        input.values[name] ? [[name, input.values[name]]] : [],
      ),
    ) as Record<string, string>;
  const oauth = isOAuthMethod(input.method);
  const { connection } = await client.updateConnection(
    input.workspaceId,
    input.connectionId,
    {
      credentials: pick(credentialNames(input.method)),
      ...(!oauth && input.secretVariableIds.length
        ? { secretVariables: pick(input.secretVariableIds) }
        : {}),
    },
  );
  return {
    // A new client ID (or a login an update dropped) needs a sign-in.
    needsSignIn:
      input.method === "oauth_authorization_code" &&
      (connection.state.authState === "needs_reauthorization" ||
        connection.setupPending === true),
    connection,
  };
}

/**
 * The login of a custom API connection on its page (#808): entered again
 * after an update dropped it, replaced at any time, and for custom OAuth
 * the client (ID and secret) with the sign-in it then needs.
 */
export function CustomApiConnectionLogin({
  workspaceId,
  connection,
  method,
  variables,
  client = { updateConnection, startCustomOAuth },
}: {
  workspaceId: string;
  connection: ConnectionDetail;
  method: CustomApiAuth["type"];
  variables: readonly CustomApiVariable[];
  client?: ConnectionLoginClient;
}) {
  const t = useT("customApi.connectionLogin");
  const login = useT("customApi.login");
  const locale = useLocale();
  const router = useRouter();
  const missing = connection.customApi?.loginMissing === true;
  const oauth = isOAuthMethod(method);
  const [signInShown, setSignInShown] = useState(false);
  const needsSignIn =
    signInShown ||
    (method === "oauth_authorization_code" &&
      (connection.state.authState === "needs_reauthorization" ||
        connection.setupPending) &&
      !missing);
  const [open, setOpen] = useState(missing);
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (method === "none" && !variables.some((v) => v.secret)) return null;
  const entries = loginEntries(method, variables, (name) =>
    login(name as "apiKey"),
  );
  const complete = entries.every((entry) => values[entry.name]);

  async function signIn() {
    setPending(true);
    setError(null);
    try {
      const started = await client.startCustomOAuth(workspaceId, connection.id);
      window.location.assign(started.authorizationUrl);
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveConnectionLogin(client, {
        workspaceId,
        connectionId: connection.id,
        method,
        secretVariableIds: variables.filter((v) => v.secret).map((v) => v.id),
        values,
      });
      setValues({});
      setSignInShown(saved.needsSignIn);
      setNotice(t("saved"));
      setOpen(false);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="card stack custom-api-connection-login"
      id="custom-api-login"
    >
      <h2>{oauth ? t("client") : t("title")}</h2>
      {missing ? (
        <p className="error" role="alert">
          {t("missing")}
        </p>
      ) : null}
      {needsSignIn ? (
        <div className="stack">
          <p>{t("signInNeeded")}</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={pending}
              onClick={() => void signIn()}
            >
              {t("signIn")}
            </button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {open ? (
        <form className="stack" onSubmit={submit}>
          {oauth ? <p className="help">{t("clientHelp")}</p> : null}
          <SecretInputs
            entries={entries}
            stored={[]}
            values={values}
            idPrefix="custom-api-connection-secret"
            onChange={(name, value) =>
              setValues((current) => ({ ...current, [name]: value ?? "" }))
            }
          />
          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={pending || !complete}
            >
              {pending ? t("saving") : oauth ? t("saveClient") : t("save")}
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button type="button" onClick={() => setOpen(true)}>
            {t("replace")}
          </button>
        </div>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
