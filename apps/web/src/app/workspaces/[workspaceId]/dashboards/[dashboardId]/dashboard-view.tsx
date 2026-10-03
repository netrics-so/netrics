"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  MAX_DASHBOARD_TILES,
  type Dashboard,
  type MetricAggregation,
  type MetricPeriod,
  type WorkspaceMetric,
} from "@netrics/contracts";
import {
  DEFAULT_RESOURCE_NOUN,
  RESOURCE_DIMENSION,
  tileLabel,
  type ResourceNoun,
} from "@netrics/domain";

import {
  ApiError,
  apiErrorMessage,
  deleteDashboard,
  duplicateDashboard,
  listMetricCurrencies,
  listMetricResources,
  saveDashboard,
} from "@/lib/api";
import {
  AGGREGATION_LABELS,
  PERIOD_LABELS,
  aggregationLabel,
  metricPickerLabel,
  pickableMetrics,
} from "@/lib/format-metric";
import {
  choiceValue,
  currencyOptionLabel,
  effectiveChoice,
  needsCurrency,
  tileCurrencyFields,
  tileCurrencySummary,
  workspaceChoiceLabel,
  type CurrencyTotals,
} from "@/lib/tile-currency";
import {
  allResourcesOption,
  effectiveResource,
  hasResources,
  newTileScope,
  offersResourceChoice,
  resourceFieldLabel,
  resourceOptionLabel,
  withResource,
  type TileResources,
} from "@/lib/tile-resource";

import { MetricTile, type TileConnection } from "./metric-tile";
import { useServerRefresh } from "./use-server-refresh";

interface DraftTile {
  /** Client-side identity for React keys while editing. */
  key: string;
  connectionId: string;
  metricKey: string;
  aggregation: MetricAggregation;
  period: MetricPeriod;
  dimensions: Record<string, string>;
  title: string | null;
  /** The tile's own display currency (#191). */
  displayCurrency: string | null;
  /** Name of the resource the tile shows, if it shows one (#194). */
  resourceName: string | null;
  /** "All apps" for a tile of several resources added up (#208). */
  allResourcesName: string | null;
}

const PERIODS = Object.keys(PERIOD_LABELS) as MetricPeriod[];

function metricId(metric: WorkspaceMetric) {
  return `${metric.connectionId}|${metric.key}`;
}

/** Same identity as metricId, for a tile (whose `key` is a React key). */
function tileMetricId(tile: { connectionId: string; metricKey: string }) {
  return `${tile.connectionId}|${tile.metricKey}`;
}

function toDraft(dashboard: Dashboard): DraftTile[] {
  return dashboard.tiles.map((tile) => ({ ...tile, key: tile.id }));
}

export function DashboardView({
  workspaceId,
  dashboard: initial,
  metrics,
  connections,
  canEdit,
  canDuplicate,
  canDelete,
  currency,
}: {
  workspaceId: string;
  dashboard: Dashboard;
  metrics: WorkspaceMetric[];
  connections: Record<string, TileConnection>;
  /**
   * The workspace's display currency and the currencies a tile can be
   * converted into (none when the instance fetches no rates, #191).
   */
  currency: { displayCurrency: string | null; convertible: string[] };
  canEdit: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  useServerRefresh();
  const [dashboard, setDashboard] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initial.name);
  const [tiles, setTiles] = useState<DraftTile[]>(() => toDraft(initial));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  // Follow the server's copy when it changes (refreshed every minute), so
  // changes saved elsewhere show up, but never under an open editor.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    if (!editingRef.current) {
      setDashboard(initial);
    }
  }, [initial]);

  const metricsById = useMemo(
    () => new Map(metrics.map((metric) => [metricId(metric), metric])),
    [metrics],
  );
  const pickable = pickableMetrics(metrics);

  function startEditing() {
    setName(dashboard.name);
    setTiles(toDraft(dashboard));
    setError(null);
    setConflict(false);
    setEditing(true);
  }

  function move(index: number, by: -1 | 1) {
    setTiles((current) => {
      const next = [...current];
      const [tile] = next.splice(index, 1);
      next.splice(index + by, 0, tile!);
      return next;
    });
  }

  async function onSave() {
    setError(null);
    setPending(true);
    try {
      const saved = await saveDashboard(workspaceId, dashboard.id, {
        version: dashboard.version,
        name,
        projectId: dashboard.projectId,
        tiles: tiles.map(
          ({
            key: _key,
            resourceName: _resourceName,
            allResourcesName: _allResourcesName,
            ...tile
          }) => tile,
        ),
      });
      setDashboard(saved.dashboard);
      setEditing(false);
      router.refresh();
    } catch (cause) {
      setConflict(
        cause instanceof ApiError &&
          (cause.code === "version_conflict" ||
            cause.code === "studio_dashboard"),
      );
      setError(apiErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function onDuplicate() {
    setPending(true);
    try {
      const copy = await duplicateDashboard(workspaceId, dashboard.id);
      router.push(`/workspaces/${workspaceId}/dashboards/${copy.dashboard.id}`);
    } catch (cause) {
      setError(apiErrorMessage(cause));
      setPending(false);
    }
  }

  async function onDelete() {
    if (!window.confirm(`Delete dashboard "${dashboard.name}"?`)) {
      return;
    }
    setPending(true);
    try {
      await deleteDashboard(workspaceId, dashboard.id);
      router.push(`/workspaces/${workspaceId}`);
    } catch (cause) {
      setError(apiErrorMessage(cause));
      setPending(false);
    }
  }

  const shownTiles = editing ? tiles : toDraft(dashboard);

  return (
    <>
      <div className="dashboard-header">
        {editing ? (
          <input
            aria-label="Dashboard name"
            className="dashboard-name-input"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
        ) : (
          <h1>{dashboard.name}</h1>
        )}
        <div className="actions">
          {editing ? (
            <>
              <button
                type="button"
                className="primary"
                disabled={pending || name.trim() === ""}
                onClick={() => void onSave()}
              >
                {pending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <Link
                href={`/workspaces/${workspaceId}/dashboards/${dashboard.id}/tv`}
              >
                <button type="button">TV mode</button>
              </Link>
              {canEdit ? (
                <button type="button" onClick={startEditing}>
                  Edit
                </button>
              ) : null}
              {canDuplicate ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void onDuplicate()}
                >
                  Duplicate
                </button>
              ) : null}
              {canDelete ? (
                <button
                  type="button"
                  className="danger"
                  disabled={pending}
                  onClick={() => void onDelete()}
                >
                  Delete
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {error ? (
        <div className="error" role="alert">
          {error}{" "}
          {conflict ? (
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                router.refresh();
              }}
            >
              Reload
            </button>
          ) : null}
        </div>
      ) : null}

      {shownTiles.length === 0 && !editing ? (
        <div className="card">
          <p>This dashboard has no tiles yet.</p>
          {pickable.length === 0 ? (
            <p className="muted">
              Tiles show metrics from your connections.{" "}
              <Link href={`/workspaces/${workspaceId}/connections/new`}>
                Add a connection
              </Link>{" "}
              first.
            </p>
          ) : canEdit ? (
            <button type="button" className="primary" onClick={startEditing}>
              Add tiles
            </button>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <div className="card">
          <h2>Tiles</h2>
          {tiles.length === 0 ? (
            <p className="muted">No tiles yet. Add one below.</p>
          ) : (
            <ol className="tile-edit-list">
              {tiles.map((tile, index) => {
                const metric = metricsById.get(tileMetricId(tile));
                const currencySummary = tileCurrencySummary(tile);
                return (
                  <li key={tile.key}>
                    <span>
                      <strong>
                        {tileLabel({
                          title: tile.title,
                          metricName: metric?.name ?? tile.metricKey,
                          dimensions: tile.dimensions,
                          resourceName: tile.resourceName,
                          allResourcesName: tile.allResourcesName,
                        })}
                      </strong>{" "}
                      <span className="muted">
                        {PERIOD_LABELS[tile.period]} ·{" "}
                        {metric
                          ? aggregationLabel(tile.aggregation, metric)
                          : AGGREGATION_LABELS[tile.aggregation]}{" "}
                        {currencySummary ? `· ${currencySummary} ` : null}·{" "}
                        {metric?.connectionName ?? "removed connection"}
                      </span>
                    </span>
                    <span className="actions">
                      <button
                        type="button"
                        aria-label="Move up"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label="Move down"
                        disabled={index === tiles.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() =>
                          setTiles((current) =>
                            current.filter((other) => other.key !== tile.key),
                          )
                        }
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          {tiles.length < MAX_DASHBOARD_TILES ? (
            <AddTileForm
              workspaceId={workspaceId}
              metrics={pickable}
              currency={currency}
              onAdd={(tile) => setTiles((current) => [...current, tile])}
            />
          ) : (
            <p className="muted">
              A dashboard holds at most {MAX_DASHBOARD_TILES} tiles.
            </p>
          )}
        </div>
      ) : (
        <div className="tile-grid">
          {shownTiles.map((tile) => (
            <MetricTile
              key={tile.key}
              workspaceId={workspaceId}
              tile={{ ...tile, id: tile.key, position: 0 }}
              metric={metricsById.get(tileMetricId(tile))}
              connection={connections[tile.connectionId]}
            />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The currencies of a per-currency amount metric over a period, largest
 * total first; null while loading or for other metrics.
 */
function useCurrencies(
  workspaceId: string,
  metric: WorkspaceMetric | undefined,
  period: MetricPeriod,
  /** The tile's resource: its currencies only. */
  resourceId: string | null,
): { totals: CurrencyTotals | null; error: string | null } {
  const [state, setState] = useState<{
    key: string;
    totals: CurrencyTotals | null;
    error: string | null;
  }>({ key: "", totals: null, error: null });
  const perCurrency = needsCurrency(metric);
  const key =
    metric && perCurrency
      ? `${metricId(metric)}|${period}|${resourceId ?? ""}`
      : "";

  useEffect(() => {
    if (!metric || !perCurrency) {
      return;
    }
    let current = true;
    listMetricCurrencies(workspaceId, {
      connectionId: metric.connectionId,
      metricKey: metric.key,
      period,
      ...(resourceId
        ? { dimensions: { [RESOURCE_DIMENSION]: resourceId } }
        : {}),
    })
      .then((response) => {
        if (current) {
          setState({ key, totals: response.currencies, error: null });
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setState({ key, totals: null, error: apiErrorMessage(cause) });
        }
      });
    return () => {
      current = false;
    };
  }, [workspaceId, metric, perCurrency, period, resourceId, key]);

  return state.key === key && key !== ""
    ? { totals: state.totals, error: state.error }
    : { totals: null, error: null };
}

/**
 * The resources a tile of the metric can show (#194), named first; null
 * while loading or for metrics without resources.
 */
function useResources(
  workspaceId: string,
  metric: WorkspaceMetric | undefined,
): {
  resources: TileResources | null;
  noun: ResourceNoun | null;
  error: string | null;
} {
  const [state, setState] = useState<{
    key: string;
    resources: TileResources | null;
    noun: ResourceNoun | null;
    error: string | null;
  }>({ key: "", resources: null, noun: null, error: null });
  const applies = hasResources(metric);
  const key = metric && applies ? metricId(metric) : "";

  useEffect(() => {
    if (!metric || !applies) {
      return;
    }
    let current = true;
    listMetricResources(workspaceId, {
      connectionId: metric.connectionId,
      metricKey: metric.key,
    })
      .then((response) => {
        if (current) {
          setState({
            key,
            resources: response.resources,
            noun: response.resourceNoun,
            error: null,
          });
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setState({
            key,
            resources: null,
            noun: null,
            error: apiErrorMessage(cause),
          });
        }
      });
    return () => {
      current = false;
    };
  }, [workspaceId, metric, applies, key]);

  return state.key === key && key !== ""
    ? { resources: state.resources, noun: state.noun, error: state.error }
    : { resources: null, noun: null, error: null };
}

function AddTileForm({
  workspaceId,
  metrics,
  currency: conversion,
  onAdd,
}: {
  workspaceId: string;
  metrics: WorkspaceMetric[];
  currency: { displayCurrency: string | null; convertible: string[] };
  onAdd: (tile: DraftTile) => void;
}) {
  const [selected, setSelected] = useState(
    metrics[0] ? metricId(metrics[0]) : "",
  );
  const metric = metrics.find((candidate) => metricId(candidate) === selected);
  const [aggregation, setAggregation] = useState<MetricAggregation | "">("");
  const [period, setPeriod] = useState<MetricPeriod>("last_7_days");
  const [title, setTitle] = useState("");
  // All resources added up (the default), or one app or project (#194).
  const resources = useResources(workspaceId, metric);
  const [pickedResource, setPickedResource] = useState("");
  const resource = effectiveResource(resources.resources, pickedResource);
  // "Downloads · All apps" when the tile adds up several (#208).
  const scope = newTileScope(resources.resources, resource, resources.noun);
  const noun = resources.noun ?? DEFAULT_RESOURCE_NOUN;
  // Amounts in several currencies: the tile follows the workspace, converts
  // into a display currency, or shows one currency exactly (#191).
  const perCurrency = needsCurrency(metric);
  const currencies = useCurrencies(
    workspaceId,
    metric,
    period,
    resource?.id ?? null,
  );
  const [pickedCurrency, setPickedCurrency] = useState("");
  const choice = effectiveChoice(
    pickedCurrency,
    currencies.totals ?? [],
    conversion.convertible,
  );
  // The workspace's display currency applies only where rates are fetched.
  const workspaceCurrency =
    conversion.convertible.length > 0 ? conversion.displayCurrency : null;

  if (metrics.length === 0) {
    return (
      <p className="muted">
        No metrics to show yet. Tiles need a connection that provides metrics.
      </p>
    );
  }

  // Only aggregations that fit the metric are offered; the first is the
  // metric's default.
  const effectiveAggregation =
    metric && aggregation && metric.aggregations.includes(aggregation)
      ? aggregation
      : (metric?.aggregations[0] ?? "");

  const byConnection = new Map<string, WorkspaceMetric[]>();
  for (const candidate of metrics) {
    const list = byConnection.get(candidate.connectionName) ?? [];
    list.push(candidate);
    byConnection.set(candidate.connectionName, list);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!metric || !effectiveAggregation) {
      return;
    }
    const currencyFields = tileCurrencyFields(metric, choice);
    onAdd({
      key: crypto.randomUUID(),
      connectionId: metric.connectionId,
      metricKey: metric.key,
      aggregation: effectiveAggregation,
      period,
      dimensions: withResource(currencyFields.dimensions, resource),
      title: title.trim() === "" ? null : title.trim(),
      displayCurrency: currencyFields.displayCurrency,
      resourceName: resource?.name ?? null,
      allResourcesName: scope,
    });
    setTitle("");
  }

  return (
    <form className="inline add-tile" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="tile-metric">Metric</label>
        <select
          id="tile-metric"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setAggregation("");
            setPickedResource("");
          }}
        >
          {[...byConnection.entries()].map(([connectionName, list]) => (
            <optgroup key={connectionName} label={connectionName}>
              {list.map((candidate) => (
                <option key={metricId(candidate)} value={metricId(candidate)}>
                  {metricPickerLabel(candidate)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="tile-aggregation">Show</label>
        <select
          id="tile-aggregation"
          value={effectiveAggregation}
          onChange={(event) =>
            setAggregation(event.target.value as MetricAggregation)
          }
        >
          {(metric?.aggregations ?? []).map((option) => (
            <option key={option} value={option}>
              {aggregationLabel(option, metric!)}
            </option>
          ))}
        </select>
        {metric?.description ? (
          <p className="help">{metric.description}</p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="tile-period">Period</label>
        <select
          id="tile-period"
          value={period}
          onChange={(event) => setPeriod(event.target.value as MetricPeriod)}
        >
          {PERIODS.map((option) => (
            <option key={option} value={option}>
              {PERIOD_LABELS[option]}
            </option>
          ))}
        </select>
      </div>
      {offersResourceChoice(resources.resources) || resources.error ? (
        <div className="field">
          <label htmlFor="tile-resource">{resourceFieldLabel(noun)}</label>
          <select
            id="tile-resource"
            value={resource?.id ?? ""}
            disabled={!resources.resources}
            onChange={(event) => setPickedResource(event.target.value)}
          >
            <option value="">{allResourcesOption(noun)}</option>
            {(resources.resources ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {resourceOptionLabel(option)}
              </option>
            ))}
          </select>
          <p className="help">
            {resources.error ??
              `All ${resources.resources?.length ?? 0} ${noun.plural} of ${metric?.connectionName ?? "the connection"} added up, or one of them.`}
          </p>
        </div>
      ) : null}
      {perCurrency ? (
        <div className="field">
          <label htmlFor="tile-currency">Currency</label>
          <select
            id="tile-currency"
            value={choiceValue(choice)}
            onChange={(event) => setPickedCurrency(event.target.value)}
          >
            <option value="">
              {workspaceChoiceLabel(workspaceCurrency, currencies.totals)}
            </option>
            {conversion.convertible.length > 0 ? (
              <optgroup label="Converted with ECB reference rates (≈)">
                {conversion.convertible.map((code) => (
                  <option key={code} value={`convert:${code}`}>
                    Converted to {code}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {(currencies.totals ?? []).length > 0 ? (
              <optgroup label="One currency, exact">
                {(currencies.totals ?? []).map((option) => (
                  <option
                    key={option.currency}
                    value={`only:${option.currency}`}
                  >
                    {currencyOptionLabel(option)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <p className="help">
            {currencies.error
              ? currencies.error
              : !currencies.totals
                ? "Loading currencies…"
                : choice.kind === "only"
                  ? `Only amounts in ${choice.currency}, exact. Totals for ${PERIOD_LABELS[period].toLowerCase()}.`
                  : choice.kind === "convert" ||
                      (choice.kind === "workspace" && workspaceCurrency)
                    ? "Approximate: each day converted at that day's ECB reference rate. Currencies without a rate are shown apart."
                    : conversion.convertible.length > 0
                      ? "Amounts are not added up across currencies. Set a display currency in the workspace settings, or convert this tile."
                      : "Amounts are not added up across currencies: the tile shows the largest one."}
          </p>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="tile-title">Title (optional)</label>
        <input
          id="tile-title"
          value={title}
          maxLength={100}
          placeholder={
            metric
              ? tileLabel({
                  title: null,
                  metricName: metric.name,
                  dimensions: withResource({}, resource),
                  resourceName: resource?.name ?? null,
                  allResourcesName: scope,
                })
              : undefined
          }
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <button type="submit">Add tile</button>
    </form>
  );
}
