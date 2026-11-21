"use client";

import Link from "next/link";

import type { CustomApiDefinitionConnectionsResponse } from "@netrics/contracts";

import { useT } from "@/lib/i18n/client";

/** A custom API's connections with their version and "Update available". */
export function DefinitionConnections({
  workspaceId,
  connections,
  canUpdate,
}: {
  workspaceId: string;
  connections: CustomApiDefinitionConnectionsResponse["connections"];
  canUpdate: boolean;
}) {
  const t = useT("customApi.connections");
  return (
    <section className="card custom-api-connections">
      <h2>{t("title")}</h2>
      {connections.length === 0 ? (
        <p className="muted">{t("empty")}</p>
      ) : (
        <ul>
          {connections.map((connection) => (
            <li key={connection.id}>
              <Link
                href={`/workspaces/${workspaceId}/connections/${connection.id}`}
              >
                {connection.name}
              </Link>{" "}
              <span className="page-meta">
                {t("version", { version: connection.version })}
              </span>{" "}
              {connection.updateAvailable ? (
                <>
                  <span className="badge">{t("updateAvailable")}</span>{" "}
                  {canUpdate ? (
                    <Link
                      href={`/workspaces/${workspaceId}/connections/${connection.id}/custom-api-update`}
                    >
                      {t("review")}
                    </Link>
                  ) : null}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
