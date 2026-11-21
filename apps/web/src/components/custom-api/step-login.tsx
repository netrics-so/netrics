"use client";

import { useEffect, useState } from "react";

import type { CustomApiAuth } from "@netrics/contracts";

import { credentialNames } from "@/lib/custom-api-builder";
import { getCustomOAuthInfo } from "@/lib/custom-api";
import { useT } from "@/lib/i18n/client";

import type { StepProps } from "./step-props";

export const AUTH_TYPES: readonly CustomApiAuth["type"][] = [
  "none",
  "api_key",
  "bearer",
  "basic",
  "oauth_client_credentials",
  "oauth_authorization_code",
];

/** The settings a newly chosen login method starts with. */
export function defaultAuth(type: CustomApiAuth["type"]): CustomApiAuth {
  switch (type) {
    case "none":
      return { type };
    case "api_key":
      return { type, placement: "header", name: "X-Api-Key" };
    case "bearer":
      return { type, headerName: "Authorization", prefix: "Bearer" };
    case "basic":
      return { type };
    case "oauth_client_credentials":
      return { type, tokenUrl: "", scopes: [], clientAuth: "body" };
    case "oauth_authorization_code":
      return {
        type,
        authorizeUrl: "",
        tokenUrl: "",
        scopes: [],
        pkce: true,
        clientAuth: "body",
        authorizeParams: {},
      };
  }
}

/** Names whose values are not secret (shown as text while typing). */
const PLAIN = new Set(["username", "clientId"]);

export interface SecretEntry {
  name: string;
  label: string;
}

/**
 * Inputs for secrets that are sent once: a stored secret shows "Saved" and
 * "Replace", never its value. Used by the Login and Request steps and by
 * "connect an existing custom API".
 */
export function SecretInputs({
  entries,
  stored,
  values,
  onChange,
  idPrefix,
}: {
  entries: readonly SecretEntry[];
  stored: readonly string[];
  values: Readonly<Record<string, string>>;
  onChange: (name: string, value: string | undefined) => void;
  idPrefix: string;
}) {
  const t = useT("customApi.login");
  return (
    <>
      {entries.map(({ name, label }) => {
        const id = `${idPrefix}-${name}`;
        const saved = stored.includes(name) && values[name] === undefined;
        return (
          <div className="field" key={name}>
            <label htmlFor={saved ? undefined : id}>{label}</label>
            {saved ? (
              <p className="custom-api-saved">
                <span>{t("secretSaved")}</span>{" "}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onChange(name, "")}
                >
                  {t("replace")}
                </button>
              </p>
            ) : (
              <input
                id={id}
                type={PLAIN.has(name) ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={values[name] ?? ""}
                onChange={(event) => onChange(name, event.target.value)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/** The credential inputs a login method asks for, labelled. */
export function useCredentialEntries(
  auth: Pick<CustomApiAuth, "type">,
): SecretEntry[] {
  const t = useT("customApi.login");
  return credentialNames(auth).map((name) => ({
    name,
    label: t(name as "apiKey"),
  }));
}

/** Entered secret values, without empty ones; null when there are none. */
export function enteredSecrets(
  values: Readonly<Record<string, string>>,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(values))
    if (value !== "") out[name] = value;
  return Object.keys(out).length ? out : null;
}

/** Step 2: the login method, its settings and its secrets. */
export function StepLogin({
  state,
  update,
  workspaceId,
  draftId,
  secretsLost,
  pending,
  values,
  onValueChange,
  onSaveSecrets,
  onSignIn,
}: StepProps & {
  workspaceId: string;
  draftId: string | null;
  /** The last draft answer forgot stored secrets (another host or method). */
  secretsLost: boolean;
  pending: boolean;
  /** Sends the secrets once; resolves true when they were stored. */
  /** Secrets typed but not saved yet (kept by the builder, never stored). */
  values: Readonly<Record<string, string>>;
  onValueChange: (name: string, value: string | undefined) => void;
  onSaveSecrets: (secrets: Record<string, string>) => Promise<boolean>;
  onSignIn: () => void;
}) {
  const t = useT("customApi.login");
  const auth = state.auth;
  const entries = useCredentialEntries(auth);
  const credentialsStored = entries.some((e) =>
    state.secretsSet.includes(e.name),
  );
  const setAuth = (patch: Partial<CustomApiAuth>) =>
    update((current) => ({
      ...current,
      auth: { ...current.auth, ...patch } as CustomApiAuth,
    }));
  const entered = enteredSecrets(
    Object.fromEntries(
      entries
        .filter((e) => values[e.name] !== undefined)
        .map((e) => [e.name, values[e.name]!]),
    ),
  );

  return (
    <div className="custom-api-form">
      {secretsLost ? (
        <p className="notice warning" role="status">
          {t("hostChanged")}
        </p>
      ) : null}
      <fieldset className="field">
        <legend>{t("method")}</legend>
        <div className="custom-api-choices">
          {AUTH_TYPES.map((type) => (
            <label className="checkbox" key={type}>
              <input
                type="radio"
                name="custom-api-auth"
                checked={auth.type === type}
                onChange={() => {
                  for (const entry of entries)
                    onValueChange(entry.name, undefined);
                  update((current) => ({
                    ...current,
                    auth: defaultAuth(type),
                  }));
                }}
              />
              {t(`methods.${type}`)}
            </label>
          ))}
        </div>
        {credentialsStored ? (
          <p className="help custom-api-warning">{t("methodWarning")}</p>
        ) : null}
      </fieldset>

      {auth.type === "none" ? <p className="muted">{t("noLogin")}</p> : null}

      {auth.type === "api_key" ? (
        <>
          <fieldset className="field">
            <legend>{t("placement")}</legend>
            <div className="custom-api-choices">
              {(["header", "query"] as const).map((placement) => (
                <label className="checkbox" key={placement}>
                  <input
                    type="radio"
                    name="custom-api-key-placement"
                    checked={auth.placement === placement}
                    onChange={() => setAuth({ placement })}
                  />
                  {t(placement)}
                </label>
              ))}
            </div>
          </fieldset>
          <TextField
            id="custom-api-key-name"
            label={t("paramName")}
            value={auth.name}
            onChange={(name) => setAuth({ name })}
          />
        </>
      ) : null}

      {auth.type === "bearer" ? (
        <div className="custom-api-pair">
          <TextField
            id="custom-api-bearer-header"
            label={t("headerName")}
            value={auth.headerName}
            onChange={(headerName) => setAuth({ headerName })}
          />
          <TextField
            id="custom-api-bearer-prefix"
            label={t("prefix")}
            value={auth.prefix}
            onChange={(prefix) => setAuth({ prefix })}
          />
        </div>
      ) : null}

      {auth.type === "oauth_client_credentials" ||
      auth.type === "oauth_authorization_code" ? (
        <OAuthSettings key={auth.type} auth={auth} setAuth={setAuth} />
      ) : null}
      {auth.type === "oauth_authorization_code" && credentialsStored ? (
        <p className="help custom-api-warning">{t("oauthChangeWarning")}</p>
      ) : null}

      {entries.length ? (
        <>
          <SecretInputs
            entries={entries}
            stored={state.secretsSet}
            values={values}
            idPrefix="custom-api-secret"
            onChange={onValueChange}
          />
          <div className="custom-api-actions">
            <button
              type="button"
              className="primary"
              disabled={pending || !entered}
              onClick={async () => {
                if (!entered) return;
                await onSaveSecrets(entered);
              }}
            >
              {pending ? t("saving") : t("save")}
            </button>
          </div>
        </>
      ) : null}

      {auth.type === "oauth_authorization_code" ? (
        <OAuthSignIn
          workspaceId={workspaceId}
          ready={
            draftId !== null &&
            entries.every((e) => state.secretsSet.includes(e.name))
          }
          pending={pending}
          onSignIn={onSignIn}
        />
      ) : null}
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  help,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  type?: "text" | "url";
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      {help ? <p className="help">{help}</p> : null}
    </div>
  );
}

type OAuthAuth = Extract<
  CustomApiAuth,
  { type: "oauth_client_credentials" | "oauth_authorization_code" }
>;

function OAuthSettings({
  auth,
  setAuth,
}: {
  auth: OAuthAuth;
  setAuth: (patch: Partial<CustomApiAuth>) => void;
}) {
  const t = useT("customApi.login");
  const [scopes, setScopes] = useState(auth.scopes.join(" "));
  return (
    <>
      {auth.type === "oauth_authorization_code" ? (
        <TextField
          id="custom-api-authorize-url"
          type="url"
          label={t("authorizeUrl")}
          value={auth.authorizeUrl}
          onChange={(authorizeUrl) => setAuth({ authorizeUrl })}
        />
      ) : null}
      <TextField
        id="custom-api-token-url"
        type="url"
        label={t("tokenUrl")}
        value={auth.tokenUrl}
        onChange={(tokenUrl) => setAuth({ tokenUrl })}
      />
      {auth.type === "oauth_authorization_code" ? (
        <TextField
          id="custom-api-revoke-url"
          type="url"
          label={t("revokeUrl")}
          value={auth.revokeUrl ?? ""}
          onChange={(revokeUrl) =>
            setAuth({ revokeUrl: revokeUrl || undefined })
          }
        />
      ) : null}
      <TextField
        id="custom-api-scopes"
        label={t("scopes")}
        help={t("scopesHelp")}
        value={scopes}
        onChange={(value) => {
          setScopes(value);
          setAuth({ scopes: value.split(/\s+/).filter(Boolean) });
        }}
      />
      <fieldset className="field">
        <legend>{t("clientAuth")}</legend>
        <div className="custom-api-choices">
          {(["body", "basic"] as const).map((clientAuth) => (
            <label className="checkbox" key={clientAuth}>
              <input
                type="radio"
                name="custom-api-client-auth"
                checked={auth.clientAuth === clientAuth}
                onChange={() => setAuth({ clientAuth })}
              />
              {t(`clientAuths.${clientAuth}`)}
            </label>
          ))}
        </div>
      </fieldset>
      {auth.type === "oauth_authorization_code" ? (
        <>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={auth.pkce}
              onChange={(event) => setAuth({ pkce: event.target.checked })}
            />
            {t("pkce")}
          </label>
          <AuthorizeParams
            params={auth.authorizeParams}
            onChange={(authorizeParams) => setAuth({ authorizeParams })}
          />
        </>
      ) : null}
    </>
  );
}

function AuthorizeParams({
  params,
  onChange,
}: {
  params: Record<string, string>;
  onChange: (params: Record<string, string>) => void;
}) {
  const t = useT("customApi");
  const [rows, setRows] = useState(() =>
    Object.entries(params).map(([key, value]) => ({ key, value })),
  );
  const set = (next: { key: string; value: string }[]) => {
    setRows(next);
    const out: Record<string, string> = {};
    for (const row of next) if (row.key.trim()) out[row.key.trim()] = row.value;
    onChange(out);
  };
  return (
    <fieldset className="field">
      <legend>{t("login.authorizeParams")}</legend>
      {rows.map((row, index) => (
        <div className="custom-api-kv" key={index}>
          <input
            aria-label={t("request.name")}
            value={row.key}
            onChange={(event) =>
              set(
                rows.map((r, i) =>
                  i === index ? { ...r, key: event.target.value } : r,
                ),
              )
            }
          />
          <input
            aria-label={t("request.value")}
            value={row.value}
            onChange={(event) =>
              set(
                rows.map((r, i) =>
                  i === index ? { ...r, value: event.target.value } : r,
                ),
              )
            }
          />
          <button
            type="button"
            className="link-button"
            onClick={() => set(rows.filter((_, i) => i !== index))}
          >
            {t("request.remove")}
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setRows([...rows, { key: "", value: "" }])}
      >
        {t("request.addRow")}
      </button>
    </fieldset>
  );
}

/**
 * Authorization code: the redirect URL to register at the provider
 * (netrics can't own apps for APIs it doesn't know), then "Sign in" for
 * the draft (C-G4).
 */
export function OAuthSignIn({
  workspaceId,
  ready,
  pending,
  onSignIn,
  redirectUri: given,
}: {
  workspaceId: string;
  ready: boolean;
  pending: boolean;
  onSignIn: () => void;
  /** Tests: the redirect URL instead of asking the API. */
  redirectUri?: string;
}) {
  const t = useT("customApi.login");
  const [redirectUri, setRedirectUri] = useState<string | null | undefined>(
    given,
  );
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (given !== undefined) return;
    let live = true;
    getCustomOAuthInfo(workspaceId)
      .then((info) => live && setRedirectUri(info.redirectUri))
      .catch(() => live && setRedirectUri(null));
    return () => {
      live = false;
    };
  }, [workspaceId, given]);
  return (
    <div className="custom-api-oauth">
      <p>{t("oauthOwnApp")}</p>
      {redirectUri ? (
        <p className="custom-api-copy">
          <code>{redirectUri}</code>{" "}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(redirectUri).then(() => {
                setCopied(true);
              });
            }}
          >
            {copied ? t("copied") : t("copy")}
          </button>
        </p>
      ) : redirectUri === null ? (
        <p className="muted">{t("oauthUnavailable")}</p>
      ) : null}
      <p className="help">{t("signInFirst")}</p>
      <button
        type="button"
        className="primary"
        disabled={!ready || pending}
        onClick={onSignIn}
      >
        {t("signIn")}
      </button>
    </div>
  );
}
