"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { DeveloperTemplateOptions } from "@netrics/contracts";
import { apiErrorMessage, installDeveloperTemplate } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";

/**
 * Installing the Developer Portfolio (#876): a name and the sources to
 * read. Every set-up source starts chosen; any subset installs. Resources
 * belong to their connection's project (the links table under Data
 * relinks them); a one-flow "add a product" comes with #879.
 */
export function DeveloperTemplateForm({
  workspaceId,
  projectId,
  options,
}: {
  workspaceId: string;
  /** The active project the dashboard and data records start in. */
  projectId: string | null;
  options: DeveloperTemplateOptions;
}) {
  const t = useT("developerTemplate"),
    locale = useLocale(),
    router = useRouter(),
    id = useId();
  const [name, setName] = useState(t("defaultName"));
  const [selected, setSelected] = useState<string[]>(() =>
    options.connections
      .filter((connection) => !connection.setupPending)
      .map((connection) => connection.id),
  );
  const [requestId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [omitted, setOmitted] = useState<{
      dashboardId: string;
      names: string[];
    } | null>(null);
  const projectName = new Map(
    options.projects.map((project) => [project.id, project.name]),
  );
  if (!options.connections.length)
    return (
      <div className="card">
        <p>{t("empty")}</p>
        <Link href={`/workspaces/${workspaceId}/sources`}>{t("connect")}</Link>
      </div>
    );
  async function install() {
    setPending(true);
    setError(null);
    try {
      const result = await installDeveloperTemplate(workspaceId, {
        requestId,
        name: name.trim(),
        connections: selected,
        links: [],
        ...(projectId ? { projectId } : {}),
      });
      if (result.omittedProjects?.length)
        setOmitted({
          dashboardId: result.dashboardId,
          names: result.omittedProjects,
        });
      else
        router.push(
          `/workspaces/${workspaceId}/dashboards/${result.dashboardId}`,
        );
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }
  if (omitted)
    return (
      <div className="card stack">
        <p className="notice" role="status">
          {t("omitted", { names: omitted.names.join(", ") })}
        </p>
        <Link
          href={`/workspaces/${workspaceId}/dashboards/${omitted.dashboardId}`}
        >
          {t("open")}
        </Link>
      </div>
    );
  return (
    <div className="store-template-form">
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
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="store-template-connections">
          {options.connections.map((connection) => (
            <div className="store-template-connection" key={connection.id}>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selected.includes(connection.id)}
                  disabled={pending || connection.setupPending}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, connection.id]
                        : current.filter((entry) => entry !== connection.id),
                    )
                  }
                />
                <span>
                  <strong>{connection.name}</strong>
                  <small className="help">
                    {t(`connectors.${connection.connectorId}`)} ·{" "}
                    {t("resources", { count: connection.resources.length })} ·{" "}
                    {connection.projectId &&
                    projectName.has(connection.projectId)
                      ? t("inProject", {
                          name: projectName.get(connection.projectId)!,
                        })
                      : t("noProject")}
                  </small>
                </span>
              </label>
              {connection.setupPending ? (
                <Link
                  href={`/workspaces/${workspaceId}/connections/${connection.id}`}
                >
                  {t("setupPending")}
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      <section className="card stack">
        <h2>{t("projectsTitle")}</h2>
        <p className="muted">
          {options.projects.length ? t("projectsHelp") : t("noProjects")}
        </p>
        {options.projects.length ? (
          <ul>
            {options.projects.map((project) => (
              <li key={project.id}>{project.name}</li>
            ))}
          </ul>
        ) : null}
      </section>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button
          className="primary"
          disabled={pending || !selected.length || !name.trim()}
          onClick={() => void install()}
        >
          {pending ? t("installing") : t("install")}
        </button>
      </div>
    </div>
  );
}
