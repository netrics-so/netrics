"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { StoreTemplateOptions } from "@netrics/contracts";
import {
  apiErrorMessage,
  installStoreTemplate,
  listConnectionResources,
  listStoreTemplateOptions,
} from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";
import { useLeaveGuard } from "@/components/studio-editor/use-leave-guard";

type Choice = {
  key: string;
  connectionId: string;
  appId: string;
  name: string;
  account: string;
  connectorId: string;
};
type Group = { id: string; name: string; keys: string[] };
const PAGE = 50;
export function StoreTemplateForm({
  workspaceId,
  initialConnectionId,
}: {
  workspaceId: string;
  initialConnectionId?: string;
}) {
  const t = useT("storeTemplate"),
    locale = useLocale(),
    router = useRouter(),
    id = useId();
  const [options, setOptions] = useState<StoreTemplateOptions | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [revision, setRevision] = useState(0);
  const [name, setName] = useState(t("defaultName")),
    [mode, setMode] = useState<"portfolio" | "app">("portfolio"),
    [scope, setScope] = useState("");
  const [groups, setGroups] = useState<Group[]>([]),
    [step, setStep] = useState<"edit" | "review">("edit"),
    [suggestionPage, setSuggestionPage] = useState(0);
  const [pending, setPending] = useState<"options" | "apps" | "create" | null>(
      "options",
    ),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false),
    [done, setDone] = useState(false),
    [requestId] = useState(() => crypto.randomUUID());
  const initialized = useRef(false);
  useLeaveGuard(dirty && !done, t("unsaved"));
  useEffect(() => {
    let alive = true;
    setPending("options");
    setError(null);
    listStoreTemplateOptions(workspaceId)
      .then((value) => {
        if (!alive) return;
        setOptions(value);
        if (!initialized.current) {
          setSelected(
            value.connections
              .filter(
                (connection) =>
                  !connection.setupPending &&
                  (!initialConnectionId ||
                    connection.id === initialConnectionId),
              )
              .map((connection) => connection.id),
          );
          initialized.current = true;
        }
      })
      .catch((cause: unknown) => {
        if (alive) setError(apiErrorMessage(cause, locale));
      })
      .finally(() => {
        if (alive) setPending(null);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, initialConnectionId, revision, locale]);
  const connections =
    options?.connections.filter((connection) =>
      selected.includes(connection.id),
    ) ?? [];
  const apps: Choice[] = connections.flatMap((connection) =>
    connection.apps.map((app) => ({
      key: connection.id + ":" + app.id,
      connectionId: connection.id,
      appId: app.id,
      name: app.name,
      account: connection.name,
      connectorId: connection.connectorId,
    })),
  );
  const assigned = new Set(groups.flatMap((group) => group.keys));
  const matching = new Map<string, Choice[]>();
  for (const app of apps) {
    if (assigned.has(app.key)) continue;
    const key = app.name.normalize("NFKC").trim().toLocaleLowerCase(locale);
    const values = matching.get(key) ?? [];
    values.push(app);
    matching.set(key, values);
  }
  const suggestions = [...matching.values()].filter(
    (values) =>
      values.length > 1 &&
      new Set(values.map((app) => app.connectorId)).size > 1,
  );
  const visibleSuggestionPage = Math.min(
    suggestionPage,
    Math.max(0, Math.ceil(suggestions.length / 5) - 1),
  );
  const scopeChoice = apps.find((app) => app.key === scope);
  const scopeGroup = groups.find((group) => group.keys.includes(scope));
  function update() {
    setDirty(true);
    setError(null);
    setNotice(null);
  }
  function chooseConnection(connectionId: string, checked: boolean) {
    update();
    setSelected((current) =>
      checked
        ? [...current, connectionId]
        : current.filter((id) => id !== connectionId),
    );
    if (!checked) {
      setGroups((current) =>
        current
          .map((group) => ({
            ...group,
            keys: group.keys.filter(
              (key) => !key.startsWith(connectionId + ":"),
            ),
          }))
          .filter((group) => group.keys.length),
      );
      if (scope.startsWith(connectionId + ":")) setScope("");
    }
  }
  async function refreshApps() {
    setPending("apps");
    setError(null);
    setNotice(null);
    let failed = false;
    for (let offset = 0; offset < connections.length; offset += 4) {
      const batch = connections.slice(offset, offset + 4),
        results = await Promise.allSettled(
          batch.map((connection) =>
            listConnectionResources(workspaceId, connection.id),
          ),
        );
      for (let index = 0; index < results.length; index++) {
        const result = results[index]!;
        if (result.status === "rejected") {
          failed = true;
          continue;
        }
        const connectionId = batch[index]!.id;
        setOptions((current) =>
          current
            ? {
                connections: current.connections.map((connection) =>
                  connection.id === connectionId
                    ? {
                        ...connection,
                        apps: [
                          ...new Map(
                            [...connection.apps, ...result.value.resources].map(
                              (app) => [app.id, { id: app.id, name: app.name }],
                            ),
                          ).values(),
                        ],
                      }
                    : connection,
                ),
              }
            : current,
        );
      }
    }
    if (failed) setNotice(t("cachedFallback"));
    setPending(null);
  }
  function addGroup(choices: Choice[] = []) {
    update();
    setGroups((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name: choices[0]?.name ?? "",
        keys: choices.map((app) => app.key),
      },
    ]);
  }
  function review() {
    setError(null);
    if (!name.trim() || !connections.length) {
      setError(t("invalid"));
      return;
    }
    if (mode === "app" && !scopeChoice) {
      setError(t("appRequired"));
      return;
    }
    if (groups.some((group) => !group.name.trim() || !group.keys.length)) {
      setError(t("mappingRequired"));
      return;
    }
    setStep("review");
  }
  async function create() {
    setPending("create");
    setError(null);
    try {
      const result = await installStoreTemplate(workspaceId, {
        requestId,
        name: name.trim(),
        connections: selected,
        groups: groups.map((group) => ({
          id: group.id,
          name: group.name.trim(),
          apps: group.keys.map((key) => {
            const at = key.indexOf(":");
            return { connectionId: key.slice(0, at), appId: key.slice(at + 1) };
          }),
        })),
        ...(mode === "app" && scopeChoice
          ? {
              appScope: {
                connectionId: scopeChoice.connectionId,
                appId: scopeChoice.appId,
              },
            }
          : {}),
      });
      setDone(true);
      setDirty(false);
      router.push(
        `/workspaces/${workspaceId}/dashboards/${result.dashboardId}`,
      );
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }
  if (!options)
    return (
      <div className="card">
        {pending === "options" ? (
          <p role="status">{t("loading")}</p>
        ) : (
          <>
            <p className="error" role="alert">
              {error ?? t("loadFailed")}
            </p>
            <button onClick={() => setRevision((value) => value + 1)}>
              {t("retry")}
            </button>
          </>
        )}
      </div>
    );
  if (!options.connections.length)
    return (
      <div className="card">
        <p>{t("empty")}</p>
        <Link href={`/workspaces/${workspaceId}/sources`}>{t("connect")}</Link>
      </div>
    );
  return (
    <div className="store-template-form">
      {step === "edit" ? (
        <>
          <section className="card stack">
            <h2>{t("connections")}</h2>
            <p className="muted">{t("connectionsHelp")}</p>
            <div className="field">
              <label htmlFor={`${id}-name`}>{t("name")}</label>
              <input
                id={`${id}-name`}
                required
                maxLength={100}
                value={name}
                disabled={!!pending}
                onChange={(event) => {
                  update();
                  setName(event.target.value);
                }}
              />
            </div>
            <div className="store-template-connections">
              {options.connections.map((connection) => (
                <div className="store-template-connection" key={connection.id}>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={selected.includes(connection.id)}
                      disabled={!!pending || connection.setupPending}
                      onChange={(event) =>
                        chooseConnection(connection.id, event.target.checked)
                      }
                    />
                    <span>
                      <strong>{connection.name}</strong>
                      <small className="help">
                        {connection.connectorId === "google-play"
                          ? t("googlePlay")
                          : t("appStoreConnect")}{" "}
                        · {t("appsCached", { count: connection.apps.length })}
                      </small>
                    </span>
                  </label>
                  <Link
                    href={`/workspaces/${workspaceId}/connections/${connection.id}`}
                  >
                    {connection.setupPending
                      ? t("finishSetup")
                      : connection.name}
                  </Link>
                </div>
              ))}
            </div>
            <div className="actions">
              <button
                disabled={!!pending || !selected.length}
                onClick={() => void refreshApps()}
              >
                {pending === "apps" ? t("refreshing") : t("refreshApps")}
              </button>
            </div>
            {notice ? (
              <p className="notice" role="status">
                {notice}
              </p>
            ) : null}
          </section>
          <section className="card stack">
            <h2>{t("scope")}</h2>
            <label className="checkbox-row">
              <input
                type="radio"
                name={`${id}-scope`}
                checked={mode === "portfolio"}
                disabled={!!pending}
                onChange={() => {
                  update();
                  setMode("portfolio");
                }}
              />
              {t("portfolio")}
            </label>
            <label className="checkbox-row">
              <input
                type="radio"
                name={`${id}-scope`}
                checked={mode === "app"}
                disabled={!!pending}
                onChange={() => {
                  update();
                  setMode("app");
                }}
              />
              {t("single")}
            </label>
            {mode === "app" ? (
              <div className="field">
                <MappingApps
                  apps={apps}
                  selected={scope ? [scope] : []}
                  assigned={new Set()}
                  disabled={!!pending}
                  single
                  onChange={(keys) => {
                    update();
                    setScope(keys[0] ?? "");
                  }}
                />
                <p className="help">{t("scopeHelp")}</p>
              </div>
            ) : null}
          </section>
          <section className="card stack">
            <h2>{t("mapping")}</h2>
            <p className="muted">{t("mappingHelp")}</p>
            {suggestions.length ? (
              <div className="actions">
                {suggestions
                  .slice(
                    visibleSuggestionPage * 5,
                    visibleSuggestionPage * 5 + 5,
                  )
                  .map((choices) => (
                    <button
                      key={choices[0]!.key}
                      disabled={!!pending}
                      onClick={() => addGroup(choices)}
                    >
                      {t("suggestion", { name: choices[0]!.name })}
                    </button>
                  ))}
                {suggestions.length > 5 ? (
                  <button
                    disabled={!!pending}
                    onClick={() =>
                      setSuggestionPage(
                        (value) =>
                          (value + 1) % Math.ceil(suggestions.length / 5),
                      )
                    }
                  >
                    {t("moreSuggestions")}
                  </button>
                ) : null}
              </div>
            ) : null}
            {groups.map((group) => (
              <div className="store-template-group stack" key={group.id}>
                <div className="field">
                  <label htmlFor={`product-${group.id}`}>
                    {t("groupName")}
                  </label>
                  <input
                    id={`product-${group.id}`}
                    value={group.name}
                    required
                    maxLength={100}
                    disabled={!!pending}
                    onChange={(event) => {
                      update();
                      setGroups((current) =>
                        current.map((entry) =>
                          entry.id === group.id
                            ? { ...entry, name: event.target.value }
                            : entry,
                        ),
                      );
                    }}
                  />
                </div>
                <MappingApps
                  apps={apps}
                  selected={group.keys}
                  disabled={!!pending}
                  assigned={
                    new Set(
                      groups
                        .filter((entry) => entry.id !== group.id)
                        .flatMap((entry) => entry.keys),
                    )
                  }
                  onChange={(keys) => {
                    update();
                    setGroups((current) =>
                      current.map((entry) =>
                        entry.id === group.id
                          ? {
                              ...entry,
                              keys,
                              name:
                                entry.name ||
                                apps.find((app) => keys.includes(app.key))
                                  ?.name ||
                                "",
                            }
                          : entry,
                      ),
                    );
                  }}
                />
                <div className="actions">
                  <button
                    disabled={!!pending}
                    onClick={() => {
                      update();
                      setGroups((current) =>
                        current.filter((entry) => entry.id !== group.id),
                      );
                    }}
                  >
                    {t("removeGroup")}
                  </button>
                </div>
              </div>
            ))}
            <div className="actions">
              <button
                disabled={!!pending || !apps.length}
                onClick={() => addGroup()}
              >
                {t("addGroup")}
              </button>
            </div>
          </section>
          <div className="actions">
            <button className="primary" disabled={!!pending} onClick={review}>
              {t("review")}
            </button>
          </div>
        </>
      ) : (
        <section className="card stack">
          <h2>{t("reviewTitle")}</h2>
          <h3>{name}</h3>
          <p>{connections.map((connection) => connection.name).join(" · ")}</p>
          <p>
            {mode === "app"
              ? (scopeGroup?.name ?? scopeChoice?.name)
              : t("portfolio")}
          </p>
          {groups.map((group) => (
            <p key={group.id}>
              <strong>{group.name}</strong>:{" "}
              {group.keys
                .map((key) => {
                  const app = apps.find((app) => app.key === key);
                  return app ? `${app.name} (${app.account})` : key;
                })
                .join(" · ")}
            </p>
          ))}
          <p className="muted">{t("reviewHelp")}</p>
          <ul className="store-template-definitions">
            {(
              [
                "downloadsDefinition",
                "proceedsDefinition",
                "ratingsDefinition",
                "missingDefinition",
              ] as const
            ).map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
          <p className="notice">{t("allHistory")}</p>
          <div className="actions">
            <button disabled={!!pending} onClick={() => setStep("edit")}>
              {t("edit")}
            </button>
            <button
              className="primary"
              disabled={!!pending}
              onClick={() => void create()}
            >
              {pending === "create" ? t("creating") : t("create")}
            </button>
          </div>
        </section>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
function MappingApps({
  apps,
  selected,
  assigned,
  disabled,
  onChange,
  single = false,
}: {
  apps: Choice[];
  selected: string[];
  assigned: Set<string>;
  disabled: boolean;
  onChange: (keys: string[]) => void;
  single?: boolean;
}) {
  const t = useT("storeTemplate"),
    id = useId(),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0);
  const filtered = apps.filter((app) =>
    `${app.name} ${app.appId} ${app.account}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE)),
    current = Math.min(page, pages - 1);
  return (
    <fieldset className="app-picker stack" disabled={disabled}>
      <legend>
        {single
          ? t("chooseApp")
          : t("selectedApps", { count: selected.length })}
      </legend>
      <div className="field">
        <label htmlFor={`${id}-search`}>{t("searchApps")}</label>
        <input
          id={`${id}-search`}
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
      </div>
      <div className="app-picker-list">
        {filtered.slice(current * PAGE, (current + 1) * PAGE).map((app) => (
          <label className="checkbox-row" key={app.key}>
            <input
              type={single ? "radio" : "checkbox"}
              name={id}
              checked={selected.includes(app.key)}
              disabled={disabled || assigned.has(app.key)}
              onChange={(event) =>
                onChange(
                  single
                    ? [app.key]
                    : event.target.checked
                      ? [...selected, app.key]
                      : selected.filter((key) => key !== app.key),
                )
              }
            />
            <span>
              {app.name}
              <small className="help">
                {app.account} · {app.appId}
              </small>
            </span>
          </label>
        ))}
      </div>
      {!filtered.length ? <p className="muted">{t("noApps")}</p> : null}
      {pages > 1 ? (
        <nav className="actions" aria-label={t("searchApps")}>
          <button
            type="button"
            disabled={disabled || !current}
            onClick={() => setPage(current - 1)}
          >
            {t("previous")}
          </button>
          <span>{t("page", { page: current + 1, pages })}</span>
          <button
            type="button"
            disabled={disabled || current + 1 >= pages}
            onClick={() => setPage(current + 1)}
          >
            {t("next")}
          </button>
        </nav>
      ) : null}
    </fieldset>
  );
}
