"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type {
  CustomApiChange,
  CustomApiEnvironment,
  CustomApiUpdatePlan,
  CustomApiVariable,
} from "@netrics/contracts";

import { apiErrorMessage } from "@/lib/api";
import {
  applyConnectionUpdate,
  CustomApiUpdateError,
  getConnectionUpdate,
} from "@/lib/custom-api";
import { useLocale, useT } from "@/lib/i18n/client";

import { isOAuthMethod, loginEntries } from "./connection-login";
import { SecretInputs } from "./step-login";

export interface UpdateClient {
  getConnectionUpdate: typeof getConnectionUpdate;
  applyConnectionUpdate: typeof applyConnectionUpdate;
}

const defaultUpdateClient: UpdateClient = {
  getConnectionUpdate,
  applyConnectionUpdate,
};

export interface UpdateInputs {
  environmentId: string;
  variables: Record<string, string>;
  secrets: Record<string, string>;
}

/**
 * Whether every blocker of the plan has its answer in the inputs, and a
 * new login (`loginNames`) is either left out or entered completely.
 */
export function updateReady(
  plan: CustomApiUpdatePlan,
  inputs: UpdateInputs,
  loginNames: readonly string[] = [],
): boolean {
  const typed = loginNames.filter((name) => inputs.secrets[name]);
  if (typed.length > 0 && typed.length < loginNames.length) return false;
  return plan.blockers.every((blocker) =>
    blocker.code === "environment_removed"
      ? inputs.environmentId !== blocker.environment
      : blocker.secret
        ? Boolean(inputs.secrets[blocker.variable])
        : Boolean(inputs.variables[blocker.variable]?.trim()),
  );
}

/**
 * Applies the reviewed plan. A stale basis (the connection or the
 * definition changed meanwhile) answers the fresh plan to review again.
 */
export async function applyUpdateFlow(
  client: Pick<UpdateClient, "applyConnectionUpdate">,
  input: {
    workspaceId: string;
    connectionId: string;
    plan: CustomApiUpdatePlan;
    inputs: UpdateInputs;
  },
): Promise<
  | { kind: "applied"; version: number }
  | { kind: "stale"; plan: CustomApiUpdatePlan | null }
> {
  const { plan, inputs } = input;
  const entered = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values).filter(([, value]) => value.trim() !== ""),
    );
  try {
    const { connection } = await client.applyConnectionUpdate(
      input.workspaceId,
      input.connectionId,
      {
        basis: plan.basis,
        toVersionId: plan.toVersion.id,
        ...(inputs.environmentId !== plan.environmentId ||
        plan.blockers.some((b) => b.code === "environment_removed")
          ? { environmentId: inputs.environmentId }
          : {}),
        ...(Object.keys(entered(inputs.variables)).length
          ? { variables: entered(inputs.variables) }
          : {}),
        ...(Object.keys(entered(inputs.secrets)).length
          ? { secrets: entered(inputs.secrets) }
          : {}),
      },
    );
    return {
      kind: "applied",
      version: connection.customApi?.version ?? plan.toVersion.version,
    };
  } catch (cause) {
    if (
      cause instanceof CustomApiUpdateError &&
      cause.code === "custom_api_update_stale"
    )
      return { kind: "stale", plan: cause.plan };
    throw cause;
  }
}

/** The sentence for one change, with stream and field names. */
export function useChangeText() {
  const t = useT("customApi.update");
  return (change: CustomApiChange, streamName: (key: string) => string) => {
    switch (change.kind) {
      case "field_changed":
        return t("changes.field_changed", {
          field: change.field,
          stream: streamName(change.stream),
          aspects: change.changes.map((a) => t(`aspects.${a}`)).join(", "),
        });
      case "field_added":
      case "field_removed":
        return t(`changes.${change.kind}`, {
          field: change.field,
          stream: streamName(change.stream),
        });
      case "stream_added":
      case "stream_removed":
      case "request_changed":
      case "pagination_changed":
      case "window_changed":
      case "mode_changed":
        return t(`changes.${change.kind}`, {
          stream: streamName(change.stream),
        });
      case "environment_added":
      case "environment_removed":
      case "environment_url_changed":
        return t(`changes.${change.kind}`, {
          environment: change.environment,
        });
      case "variable_added":
      case "variable_removed":
        return t(`changes.${change.kind}`, { variable: change.variable });
      case "auth_changed":
      case "schedule_changed":
        return t(`changes.${change.kind}`);
    }
  };
}

/**
 * The review of a custom API connection's definition update (#808): what
 * changes, grouped by data set; what must be decided (another environment,
 * new values) before "Update connection" works; whether the login carries
 * over. A stale plan is reloaded with a note.
 */
export function ConnectionUpdateReview({
  workspaceId,
  connectionId,
  initialPlan,
  streamNames,
  environments,
  variables,
  client = defaultUpdateClient,
}: {
  workspaceId: string;
  connectionId: string;
  initialPlan: CustomApiUpdatePlan;
  /** Stream key → display name, of both versions. */
  streamNames: Record<string, string>;
  /** The new version's environments and variables. */
  environments: readonly CustomApiEnvironment[];
  variables: readonly CustomApiVariable[];
  client?: UpdateClient;
}) {
  const t = useT("customApi.update");
  const login = useT("customApi.login");
  const locale = useLocale();
  const router = useRouter();
  const changeText = useChangeText();
  const [plan, setPlan] = useState(initialPlan);
  const [inputs, setInputs] = useState<UpdateInputs>({
    environmentId: initialPlan.environmentId,
    variables: {},
    secrets: {},
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const name = (key: string) => streamNames[key] ?? key;
  const label = (id: string) =>
    variables.find((variable) => variable.id === id)?.label ?? id;

  const grouped = new Map<string, CustomApiChange[]>();
  for (const change of plan.changes) {
    const group = "stream" in change ? change.stream : "";
    grouped.set(group, [...(grouped.get(group) ?? []), change]);
  }
  const oauth = isOAuthMethod(plan.login.method);
  const loginInputs =
    !plan.login.carriesOver && !oauth && plan.login.method !== "none"
      ? loginEntries(plan.login.method, variables, (n) => login(n as "apiKey"))
      : [];

  async function changeEnvironment(environmentId: string) {
    setInputs((current) => ({ ...current, environmentId }));
    setError(null);
    try {
      const next = await client.getConnectionUpdate(
        workspaceId,
        connectionId,
        environmentId,
      );
      if (next) setPlan(next);
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await applyUpdateFlow(client, {
        workspaceId,
        connectionId,
        plan,
        inputs,
      });
      if (result.kind === "stale") {
        setNotice(t("stale"));
        const fresh =
          result.plan ??
          (await client.getConnectionUpdate(workspaceId, connectionId));
        if (fresh) setPlan(fresh);
        else router.refresh();
      } else {
        setDone(result.version);
        router.refresh();
      }
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  const back = `/workspaces/${workspaceId}/connections/${connectionId}`;
  if (done !== null)
    return (
      <div className="card stack">
        <p className="notice" role="status">
          {t("done", { version: done })}
        </p>
        <div className="actions">
          <Link className="button primary" href={back}>
            {t("back")}
          </Link>
        </div>
      </div>
    );

  return (
    <form className="card stack custom-api-update" onSubmit={submit}>
      <p className="page-meta">
        {t("fromTo", {
          from: plan.fromVersion.version,
          to: plan.toVersion.version,
        })}
      </p>
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      <h2>{t("changesTitle")}</h2>
      {plan.changes.length === 0 ? (
        <p className="muted">{t("noChanges")}</p>
      ) : (
        [...grouped].map(([group, changes]) => (
          <section key={group || "general"} className="custom-api-update-group">
            <h3>{group ? name(group) : t("general")}</h3>
            <ul>
              {changes.map((change, index) => (
                <li key={index}>{changeText(change, name)}</li>
              ))}
            </ul>
          </section>
        ))
      )}

      <p
        className={plan.login.carriesOver ? "help" : "error"}
        role={plan.login.carriesOver ? undefined : "alert"}
      >
        {plan.login.carriesOver
          ? t("login.kept")
          : oauth
            ? plan.login.reason === "auth_changed"
              ? t("login.oauthMethod")
              : t("login.oauthHosts")
            : t(`login.${plan.login.reason ?? "hosts_changed"}`)}
      </p>

      {plan.blockers.length || environments.length > 1 ? (
        <section className="stack">
          {plan.blockers.length ? <h3>{t("needs.title")}</h3> : null}
          {environments.length > 1 ||
          plan.blockers.some((b) => b.code === "environment_removed") ? (
            <div className="field">
              <label htmlFor="custom-api-update-environment">
                {t("environment")}
              </label>
              {plan.blockers
                .filter((b) => b.code === "environment_removed")
                .map((b) => (
                  <p className="help" key={b.code}>
                    {t("needs.environment_removed", {
                      environment: b.environment,
                    })}
                  </p>
                ))}
              <select
                id="custom-api-update-environment"
                value={inputs.environmentId}
                disabled={pending}
                onChange={(event) => void changeEnvironment(event.target.value)}
              >
                {environments.some(
                  (environment) => environment.id === inputs.environmentId,
                ) ? null : (
                  <option value={inputs.environmentId} disabled>
                    {inputs.environmentId}
                  </option>
                )}
                {environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {plan.blockers.flatMap((blocker) =>
            blocker.code === "variable_required"
              ? [
                  <div className="field" key={blocker.variable}>
                    <label
                      htmlFor={`custom-api-update-var-${blocker.variable}`}
                    >
                      {label(blocker.variable)}
                    </label>
                    <p className="help">
                      {t("needs.variable_required", {
                        variable: label(blocker.variable),
                      })}
                    </p>
                    <input
                      id={`custom-api-update-var-${blocker.variable}`}
                      type={blocker.secret ? "password" : "text"}
                      autoComplete="off"
                      value={
                        (blocker.secret ? inputs.secrets : inputs.variables)[
                          blocker.variable
                        ] ?? ""
                      }
                      disabled={pending}
                      onChange={(event) => {
                        const value = event.target.value;
                        setInputs((current) =>
                          blocker.secret
                            ? {
                                ...current,
                                secrets: {
                                  ...current.secrets,
                                  [blocker.variable]: value,
                                },
                              }
                            : {
                                ...current,
                                variables: {
                                  ...current.variables,
                                  [blocker.variable]: value,
                                },
                              },
                        );
                      }}
                    />
                  </div>,
                ]
              : [],
          )}
        </section>
      ) : null}

      {loginInputs.length ? (
        <section className="stack">
          <p className="help">{t("login.enterNow")}</p>
          <SecretInputs
            entries={loginInputs}
            stored={[]}
            values={inputs.secrets}
            idPrefix="custom-api-update-secret"
            onChange={(key, value) =>
              setInputs((current) => ({
                ...current,
                secrets: { ...current.secrets, [key]: value ?? "" },
              }))
            }
          />
        </section>
      ) : null}

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={
            pending ||
            !updateReady(
              plan,
              inputs,
              loginInputs.map((entry) => entry.name),
            )
          }
        >
          {pending ? t("applying") : t("apply")}
        </button>
        <Link className="button" href={back}>
          {t("back")}
        </Link>
      </div>
    </form>
  );
}

/** The banner on a custom API connection's page when a newer version waits. */
export function CustomApiUpdateBanner({
  workspaceId,
  connectionId,
  name,
  version,
  canUpdate,
}: {
  workspaceId: string;
  connectionId: string;
  name: string;
  version: number;
  canUpdate: boolean;
}) {
  const t = useT("customApi.update");
  return (
    <div className="notice page-alert custom-api-update-banner" role="status">
      <p>{t("banner", { name, version })}</p>
      {canUpdate ? (
        <p>
          <Link
            className="button"
            href={`/workspaces/${workspaceId}/connections/${connectionId}/custom-api-update`}
          >
            {t("review")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
