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
  ApiError,
  apiErrorMessage,
  deleteDashboard,
  duplicateDashboard,
  listMetricCurrencies,
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
  currencyOptionLabel,
  effectiveCurrency,
  needsCurrency,
  tileCurrency,
  tileDimensions,
  type CurrencyTotals,
} from "@/lib/tile-currency";

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
}: {
  workspaceId: string;
  dashboard: Dashboard;
  metrics: WorkspaceMetric[];
  connections: Record<string, TileConnection>;
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
        tiles: tiles.map(({ key: _key, ...tile }) => tile),
      });
      setDashboard(saved.dashboard);
      setEditing(false);
      router.refresh();
    } catch (cause) {
      setConflict(
        cause instanceof ApiError && cause.code === "version_conflict",
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
                const currency = tileCurrency(tile.dimensions);
                return (
                  <li key={tile.key}>
                    <span>
                      <strong>
                        {tile.title ?? metric?.name ?? tile.metricKey}
                      </strong>{" "}
                      <span className="muted">
                        {PERIOD_LABELS[tile.period]} ·{" "}
                        {metric
                          ? aggregationLabel(tile.aggregation, metric)
                          : AGGREGATION_LABELS[tile.aggregation]}{" "}
                        {currency ? `· ${currency} ` : null}·{" "}
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
): { totals: CurrencyTotals | null; error: string | null } {
  const [state, setState] = useState<{
    key: string;
    totals: CurrencyTotals | null;
    error: string | null;
  }>({ key: "", totals: null, error: null });
  const perCurrency = needsCurrency(metric);
  const key = metric && perCurrency ? `${metricId(metric)}|${period}` : "";

  useEffect(() => {
    if (!metric || !perCurrency) {
      return;
    }
    let current = true;
    listMetricCurrencies(workspaceId, {
      connectionId: metric.connectionId,
      metricKey: metric.key,
      period,
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
  }, [workspaceId, metric, perCurrency, period, key]);

  return state.key === key && key !== ""
    ? { totals: state.totals, error: state.error }
    : { totals: null, error: null };
}

function AddTileForm({
  workspaceId,
  metrics,
  onAdd,
}: {
  workspaceId: string;
  metrics: WorkspaceMetric[];
  onAdd: (tile: DraftTile) => void;
}) {
  const [selected, setSelected] = useState(
    metrics[0] ? metricId(metrics[0]) : "",
  );
  const metric = metrics.find((candidate) => metricId(candidate) === selected);
  const [aggregation, setAggregation] = useState<MetricAggregation | "">("");
  const [period, setPeriod] = useState<MetricPeriod>("last_7_days");
  const [title, setTitle] = useState("");
  // Amounts in several currencies: the tile shows one (ADR 0014).
  const perCurrency = needsCurrency(metric);
  const currencies = useCurrencies(workspaceId, metric, period);
  const [pickedCurrency, setPickedCurrency] = useState("");
  const currency = currencies.totals
    ? effectiveCurrency(currencies.totals, pickedCurrency)
    : null;

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
    if (!metric || !effectiveAggregation || (perCurrency && !currency)) {
      return;
    }
    onAdd({
      key: crypto.randomUUID(),
      connectionId: metric.connectionId,
      metricKey: metric.key,
      aggregation: effectiveAggregation,
      period,
      dimensions: tileDimensions(metric, currency),
      title: title.trim() === "" ? null : title.trim(),
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
      {perCurrency ? (
        <div className="field">
          <label htmlFor="tile-currency">Currency</label>
          <select
            id="tile-currency"
            value={currency ?? ""}
            disabled={!currencies.totals || currencies.totals.length === 0}
            onChange={(event) => setPickedCurrency(event.target.value)}
          >
            {(currencies.totals ?? []).map((option) => (
              <option key={option.currency} value={option.currency}>
                {currencyOptionLabel(option)}
              </option>
            ))}
          </select>
          <p className="help">
            {currencies.error
              ? currencies.error
              : !currencies.totals
                ? "Loading currencies…"
                : currencies.totals.length === 0
                  ? "No amounts yet. Pick a currency once the connection has synced."
                  : `Amounts are not converted: a tile shows one currency. Totals for ${PERIOD_LABELS[period].toLowerCase()}.`}
          </p>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="tile-title">Title (optional)</label>
        <input
          id="tile-title"
          value={title}
          maxLength={100}
          placeholder={metric?.name}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <button type="submit" disabled={perCurrency && !currency}>
        Add tile
      </button>
    </form>
  );
}
