"use client";

import Link from "next/link";

import type { Connection, ConnectorCatalogEntry } from "@netrics/contracts";

import { ConnectorIcon } from "./connector-icon";
import { useLocale, useT } from "@/lib/i18n/client";
import { relativeTime } from "@/lib/relative-time";
import { sourceAttention } from "@/lib/sources";

interface ConnectedStripProps {
  workspaceId: string;
  connections: readonly Connection[];
  connectors: readonly ConnectorCatalogEntry[];
  /** For tests: the clock relative times are worded against. */
  now?: number;
}

/**
 * The workspace's connections as compact cards (design 3c, #306): icon,
 * name, last sync and a health dot. Ones that need attention are washed
 * amber and say what to do; each card opens the connection.
 */
export function ConnectedStrip({
  workspaceId,
  connections,
  connectors,
  now,
}: ConnectedStripProps) {
  const t = useT("sources");
  const locale = useLocale();
  const byId = new Map(
    connectors.map((connector) => [connector.id, connector]),
  );
  return (
    <ul className="source-strip">
      {connections.map((connection) => {
        const connector = byId.get(connection.connectorId);
        const attention = sourceAttention(connection, connector);
        const health = connection.state.health;
        const meta = attention
          ? t("strip.action", {
              problem: t(`strip.${attention.problem}`),
              action: t(`actions.${attention.action}`),
            })
          : health === "pending" || connection.state.lastSuccessAt === null
            ? t("strip.firstSync")
            : t("strip.synced", {
                time: relativeTime(connection.state.lastSuccessAt, locale, now),
              });
        const dot = attention ? "warning" : health === "ok" ? "up" : "unknown";
        return (
          <li key={connection.id}>
            <Link
              className={`source-chip${attention ? " source-chip--attention" : ""}`}
              href={`/workspaces/${workspaceId}/connections/${connection.id}${attention?.anchor ?? ""}`}
            >
              <ConnectorIcon
                name={connector?.name ?? connection.connectorName}
                brandColor={connector?.brandColor ?? null}
                size="small"
              />
              <span className="source-chip-text">
                <span className="source-chip-name">{connection.name}</span>
                <span className="source-chip-meta">{meta}</span>
              </span>
              <span className={`dot ${dot}`} aria-hidden="true" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
