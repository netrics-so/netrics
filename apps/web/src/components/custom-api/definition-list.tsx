"use client";

import Link from "next/link";

import type { CustomApiDefinitionSummary } from "@netrics/contracts";

import { useLocale, useT } from "@/lib/i18n/client";
import { relativeTime } from "@/lib/relative-time";

/**
 * The workspace's custom APIs (#807): name, version, connections, last
 * change, with "Edit" (or "View" for viewers) and "Connect".
 */
export function CustomApiDefinitionList({
  workspaceId,
  definitions,
  canCreate,
  canEdit,
  now,
}: {
  workspaceId: string;
  definitions: readonly CustomApiDefinitionSummary[];
  canCreate: boolean;
  canEdit: boolean;
  /** Tests pin the clock. */
  now?: number;
}) {
  const t = useT("customApi.list");
  const locale = useLocale();
  if (definitions.length === 0) return <p className="muted">{t("empty")}</p>;
  const base = `/workspaces/${workspaceId}/custom-apis`;
  return (
    <div className="table-scroll">
      <table className="table custom-api-list">
        <thead>
          <tr>
            <th>{t("columns.name")}</th>
            <th>{t("columns.version")}</th>
            <th>{t("columns.connections")}</th>
            <th>{t("columns.changed")}</th>
            <th>
              <span className="visually-hidden">{t("edit")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {definitions.map((definition) => (
            <tr key={definition.id}>
              <td>
                <Link href={`${base}/${definition.id}`}>{definition.name}</Link>
              </td>
              <td className="muted">
                {t("version", { version: definition.currentVersion })}
              </td>
              <td>{definition.connectionCount}</td>
              <td className="muted">
                {relativeTime(definition.updatedAt, locale, now)}
              </td>
              <td className="custom-api-list-actions">
                <Link href={`${base}/${definition.id}`}>
                  {canEdit ? t("edit") : t("view")}
                </Link>
                {canCreate ? (
                  <Link
                    className="button"
                    href={`${base}/${definition.id}/connect`}
                  >
                    {t("connect")}
                  </Link>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
