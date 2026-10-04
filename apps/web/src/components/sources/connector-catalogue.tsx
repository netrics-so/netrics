"use client";

import Link from "next/link";
import { useState } from "react";

import type {
  ConnectorCatalogEntry,
  ConnectorCategory,
} from "@netrics/contracts";

import { ConnectorIcon } from "./connector-icon";
import { useLocale, useT } from "@/lib/i18n/client";
import { providerName, unavailableCopy } from "@/lib/oauth-connection";
import {
  catalogueCta,
  filterCatalogue,
  presentCategories,
  primaryAuthStrategy,
  refreshInterval,
  type ConnectorStanding,
} from "@/lib/sources";

/** Where the custom API connector is planned (milestone 13). */
export const CUSTOM_API_PLAN_URL =
  "https://github.com/netrics-so/netrics/blob/main/docs/milestones/13-custom-api-connector.md";

/** At most this many metric chips per card; the rest is "+N". */
const MAX_CHIPS = 4;

/**
 * Cards link to the wizard and to connections (Sources page), or pick a
 * connector in place (the new-connection wizard's first step).
 */
export type CatalogueMode =
  | { kind: "links"; canCreate: boolean }
  | {
      kind: "pick";
      selectedId: string | null;
      onPick: (connector: ConnectorCatalogEntry) => void;
    };

interface ConnectorCatalogueProps {
  workspaceId: string;
  connectors: readonly ConnectorCatalogEntry[];
  /** How each connector stands in this workspace, by connector id. */
  standings: Readonly<Record<string, ConnectorStanding>>;
  mode: CatalogueMode;
  /** The category shown first (tests; the page starts with "all"). */
  initialFilter?: ConnectorCategory | "all";
}

/**
 * The connector catalogue (design 3c, #306): category pills that filter
 * instantly, then a card per connector with its metrics, how it signs in,
 * how often it refreshes and what to do: connect, add another, or fix the
 * connection that needs attention. "Custom API" always shows, as a plan.
 */
export function ConnectorCatalogue({
  workspaceId,
  connectors,
  standings,
  mode,
  initialFilter = "all",
}: ConnectorCatalogueProps) {
  const t = useT("sources");
  const [filter, setFilter] = useState<ConnectorCategory | "all">(
    initialFilter,
  );
  const categories = presentCategories(connectors);
  const shown = filterCatalogue(connectors, filter);

  return (
    <div className="catalogue">
      {categories.length > 1 ? (
        <div className="catalogue-filter" role="group" aria-label={t("filter")}>
          {(["all", ...categories] as const).map((category) => (
            <button
              key={category}
              type="button"
              className="catalogue-pill"
              aria-pressed={filter === category}
              onClick={() => setFilter(category)}
            >
              {t(`categories.${category}`)}
            </button>
          ))}
        </div>
      ) : null}
      <ul className="catalogue-grid">
        {shown.map((connector) => (
          <li key={connector.id}>
            <CatalogueCard
              workspaceId={workspaceId}
              connector={connector}
              standing={standings[connector.id]}
              mode={mode}
            />
          </li>
        ))}
        <li>
          <CustomApiCard />
        </li>
      </ul>
    </div>
  );
}

function CatalogueCard({
  workspaceId,
  connector,
  standing,
  mode,
}: {
  workspaceId: string;
  connector: ConnectorCatalogEntry;
  standing: ConnectorStanding | undefined;
  mode: CatalogueMode;
}) {
  const t = useT("sources");
  const locale = useLocale();
  const chips = connector.metrics.slice(0, MAX_CHIPS);
  const more = connector.metrics.length - chips.length;
  const auth = primaryAuthStrategy(connector);
  const interval = refreshInterval(connector.minRefreshIntervalSeconds);
  const selected = mode.kind === "pick" && mode.selectedId === connector.id;
  return (
    <article
      className={`catalogue-card${selected ? " catalogue-card--selected" : ""}`}
    >
      <div className="catalogue-card-head">
        <ConnectorIcon
          name={connector.name}
          brandColor={connector.brandColor}
          size="large"
        />
        <div className="catalogue-card-title">
          <h3>{connector.name}</h3>
          <span className="catalogue-tag">
            {t(`categories.${connector.category}`)}
          </span>
        </div>
      </div>
      <p className="catalogue-description">{connector.description}</p>
      {connector.unavailable ? (
        <p className="catalogue-unavailable">
          {unavailableCopy(connector.unavailable, locale).summary}
        </p>
      ) : chips.length > 0 ? (
        <ul className="catalogue-chips">
          {chips.map((metric) => (
            <li key={metric.key}>{metric.name}</li>
          ))}
          {more > 0 ? <li>{t("moreMetrics", { count: more })}</li> : null}
        </ul>
      ) : null}
      <div className="catalogue-card-foot">
        <span className="catalogue-facts">
          {auth
            ? t(`auth.${auth.strategy}`, {
                provider: auth.provider ? providerName(auth.provider) : "",
              })
            : null}
          {auth ? <span aria-hidden="true">·</span> : null}
          {t(`refresh.${interval.unit}`, { count: interval.count })}
        </span>
        <CardActions
          workspaceId={workspaceId}
          connector={connector}
          standing={standing}
          mode={mode}
          selected={selected}
        />
      </div>
    </article>
  );
}

function CardActions({
  workspaceId,
  connector,
  standing,
  mode,
  selected,
}: {
  workspaceId: string;
  connector: ConnectorCatalogEntry;
  standing: ConnectorStanding | undefined;
  mode: CatalogueMode;
  selected: boolean;
}) {
  const t = useT("sources");
  const cta = catalogueCta(standing);
  const name = connector.name;
  const fix =
    cta === "fix" && standing?.attentionId ? (
      <Link
        className="catalogue-cta catalogue-cta--fix"
        href={`/workspaces/${workspaceId}/connections/${standing.attentionId}`}
        aria-label={t("fixName", { name })}
      >
        {t("cta.fix")}
      </Link>
    ) : null;
  const label = !connector.available
    ? t("cta.details")
    : cta === "connect"
      ? t("cta.connect")
      : t("cta.addAnother");
  const ariaLabel = !connector.available
    ? t("detailsName", { name })
    : cta === "connect"
      ? t("connectName", { name })
      : t("addAnotherName", { name });
  const primary = connector.available && cta === "connect";

  if (mode.kind === "pick") {
    // In the wizard a broken connection can still be fixed, and another
    // one of the same connector added.
    return (
      <span className="catalogue-actions">
        {fix}
        <button
          type="button"
          className={`catalogue-cta${primary ? " primary" : ""}`}
          aria-pressed={selected}
          aria-label={ariaLabel}
          onClick={() => mode.onPick(connector)}
        >
          {selected ? t("cta.selected") : label}
        </button>
      </span>
    );
  }
  if (fix) {
    return <span className="catalogue-actions">{fix}</span>;
  }
  if (!mode.canCreate) {
    return null;
  }
  return (
    <span className="catalogue-actions">
      <Link
        className={`catalogue-cta${primary ? " primary" : ""}`}
        href={`/workspaces/${workspaceId}/connections/new?connector=${encodeURIComponent(connector.id)}`}
        aria-label={ariaLabel}
      >
        {label}
      </Link>
    </span>
  );
}

/** Custom API connections arrive with milestone 13; until then, the plan. */
function CustomApiCard() {
  const t = useT("sources");
  const name = t("customApi.name");
  return (
    <article className="catalogue-card catalogue-card--planned">
      <div className="catalogue-card-head">
        <ConnectorIcon name={name} brandColor={null} size="large" />
        <div className="catalogue-card-title">
          <h3>{name}</h3>
          <span className="catalogue-tag">{t("customApi.tag")}</span>
        </div>
      </div>
      <p className="catalogue-description">{t("customApi.description")}</p>
      <div className="catalogue-card-foot">
        <a
          className="catalogue-facts"
          href={CUSTOM_API_PLAN_URL}
          target="_blank"
          rel="noreferrer"
        >
          {t("customApi.plan")} ↗
        </a>
        <span className="catalogue-actions">
          <span
            className="catalogue-cta catalogue-cta--disabled"
            aria-disabled="true"
          >
            {t("cta.comingLater")}
          </span>
        </span>
      </div>
    </article>
  );
}
