"use client";
import Link from "next/link";
import { useDashboardData } from "./dashboard-data-provider";
import { useEffect, useState, type CSSProperties } from "react";
import type { DashboardWidget, DashboardWidgetData } from "@netrics/contracts";
import type { StudioEnv } from "@/lib/studio-widgets";
import { previewDashboardMeasures } from "@/lib/dashboard-data-api";
import { useLocale, useT } from "@/lib/i18n/client";
import { dataErrorKey } from "@/lib/data-editing";
import { ApiError } from "@/lib/api";
import {
  currencyExponent,
  displayMeasureAmount,
  type DataField,
} from "@netrics/domain";

export type MeasureWidget = Extract<DashboardWidget, { type: "measure" }>;
export function formatMeasureCell(
  value: unknown,
  type: string,
  currency: string | undefined,
  locale: string,
  yes: string,
  no: string,
  unit?: string,
): string {
  value = displayMeasureAmount(value, unit, currency);
  if (value === null || value === undefined) return "—";
  if (type === "boolean") return value ? yes : no;
  // Decimal strings must never pass through Number, including beyond IEEE-754 precision.
  let text: string;
  if (
    (typeof value === "string" ||
      (typeof value === "number" && Number.isSafeInteger(value))) &&
    (type === "decimal" || currency) &&
    /^-?\d+(?:\.\d+)?$/.test(String(value))
  ) {
    const raw = String(value);
    const negative = raw.startsWith("-");
    const [whole = "0", fraction = ""] = (negative ? raw.slice(1) : raw).split(
      ".",
    );
    const digits = currency
      ? fraction.padEnd(currencyExponent(currency), "0")
      : fraction;
    const grouped = new Intl.NumberFormat(locale).format(BigInt(whole));
    const separator =
      new Intl.NumberFormat(locale)
        .formatToParts(1.1)
        .find((part) => part.type === "decimal")?.value ?? ".";
    text = `${negative ? "-" : ""}${grouped}${digits ? separator + digits : ""}`;
  } else
    text =
      typeof value === "number"
        ? new Intl.NumberFormat(locale, { maximumFractionDigits: 18 }).format(
            value,
          )
        : String(value);
  return currency
    ? `${text} ${currency}`
    : unit === "percent"
      ? `${text}%`
      : unit === "stars"
        ? `${text} ★`
        : text;
}
export function MeasureWidgetView({
  widget,
  data,
  loading = false,
  onFilter,
  fontScale = 1,
  workspaceId,
}: {
  widget: Pick<MeasureWidget, "title" | "options"> & {
    binding: Pick<MeasureWidget["binding"], "measureIds" | "groupBy">;
  };
  fontScale?: number;
  workspaceId?: string;
  data: DashboardWidgetData | null;
  loading?: boolean;
  onFilter?: (dimensionId: string, value: unknown) => void;
}) {
  const t = useT("data"),
    locale = useLocale();
  const [now, setNow] = useState(() => Date.now());
  const expiry = data?.result?.expiresAt;
  useEffect(() => {
    if (!expiry) return;
    const remaining = new Date(expiry).getTime() - Date.now();
    if (remaining <= 0) {
      if (now < new Date(expiry).getTime()) setNow(Date.now());
      return;
    }
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(remaining + 1, 86400000),
    );
    return () => clearTimeout(timer);
  }, [expiry, now]);
  const expired = data?.result?.expiresAt
    ? new Date(data.result.expiresAt).getTime() <= now
    : false;
  const rows = expired ? [] : (data?.result?.rows ?? []);
  const label =
    widget.title ??
    (data?.metadata
      ? widget.binding.measureIds
          .map(
            (id) =>
              data.metadata!.measures.find((measure) => measure.id === id)
                ?.name ?? id,
          )
          .join(" · ")
      : undefined) ??
    t("measures");
  const cell = rows[0]?.measures[widget.binding.measureIds[0]!];
  const format = (
    value: unknown,
    type: string,
    currency?: string,
    unit?: string,
  ) =>
    formatMeasureCell(
      value,
      type,
      currency,
      locale,
      t("true"),
      t("false"),
      unit,
    );
  const error = expired
    ? t("errors.expired")
    : data?.error
      ? t(`errors.${dataErrorKey(new ApiError(400, data.error))}`)
      : null;
  const fields: DataField[] = [
    ...widget.binding.groupBy.map((id) => {
      const dimension = data?.metadata?.dimensions.find(
        (dimension) => dimension.id === id,
      );
      return {
        id,
        name: dimension?.name ?? id,
        type: dimension?.type ?? "string",
        nullable: true,
      } as DataField;
    }),
    ...widget.binding.measureIds.map(
      (id) =>
        ({
          id: `measure.${id}`,
          name:
            data?.metadata?.measures.find((measure) => measure.id === id)
              ?.name ?? id,
          type: rows[0]?.measures[id]?.type ?? "decimal",
          nullable: true,
        }) as DataField,
    ),
  ];
  const tableRows = rows.map((row) => ({
    ...row.dimensions,
    ...row.dimensionLabels,
    ...Object.fromEntries(
      widget.binding.measureIds.map((id) => [
        `measure.${id}`,
        row.measures[id]?.currency
          ? format(
              row.measures[id]?.value,
              row.measures[id]!.type,
              row.measures[id]?.currency,
              row.measures[id]?.unit,
            )
          : (row.measures[id]?.value ?? null),
      ]),
    ),
  }));
  const chartRows = rows.map((row) => ({
    dimension: row.dimensions[widget.binding.groupBy[0]!],
    label: row.dimensionLabels?.[widget.binding.groupBy[0]!],
    cell: row.measures[widget.binding.measureIds[0]!],
  }));
  const numeric = chartRows.map(({ cell }) =>
    cell?.value === null ? null : Number(cell?.value),
  );
  const unsafe = numeric.some(
    (value, index) =>
      value !== null &&
      (!Number.isFinite(value) ||
        (chartRows[index]?.cell?.type === "integer" &&
          !Number.isSafeInteger(value)) ||
        Math.abs(value) > Number.MAX_SAFE_INTEGER),
  );
  const extent = Math.max(
    1,
    ...numeric.map((value) =>
      value === null || !Number.isFinite(value) ? 0 : Math.abs(value),
    ),
  );
  const times = chartRows.map((row) => Date.parse(String(row.dimension))),
    minTime = Math.min(...times),
    maxTime = Math.max(...times);
  const points = numeric.map((value, index) =>
    value === null
      ? null
      : `${maxTime > minTime && Number.isFinite(times[index]) ? ((times[index]! - minTime) / (maxTime - minTime)) * 580 + 10 : 300},${190 - ((value / extent + 1) / 2) * 180}`,
  );
  let continuing = false;
  const path = points
    .map((point) => {
      if (point === null) {
        continuing = false;
        return "";
      }
      const segment = `${continuing ? "L" : "M"}${point}`;
      continuing = true;
      return segment;
    })
    .join(" ");
  return (
    <article
      className={`sw sw-measure${data?.result?.stale ? " sw-stale" : ""}`}
      style={{ "--measure-scale": fontScale } as CSSProperties}
      aria-busy={loading}
    >
      <h3 className="sw-measure-title">{label}</h3>
      {error ? (
        <p className="sw-notice" role="status">
          {error}
        </p>
      ) : !data ? (
        <p>{loading ? t("loading") : "—"}</p>
      ) : widget.options.view === "value" ? (
        <p className="sw-measure-value">
          {format(
            cell?.value,
            cell?.type ?? "decimal",
            cell?.currency,
            cell?.unit,
          )}
        </p>
      ) : rows.length === 0 ? (
        <p>{t("noRows")}</p>
      ) : widget.options.view === "table" || unsafe ? (
        <div className="sw-measure-table-scroll">
          <table className="sw-measure-table">
            <thead>
              <tr>
                {fields.map((field) => (
                  <th key={field.id}>{field.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, index) => (
                <tr key={index}>
                  {fields.map((field) => (
                    <td key={field.id}>{format(row[field.id], field.type)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : widget.options.view === "bar" ? (
        <div className="sw-measure-bars">
          {chartRows.map(({ dimension, label, cell }, index) => (
            <div className="sw-measure-bar" key={index}>
              <button
                type="button"
                disabled={!onFilter}
                onClick={() =>
                  onFilter?.(widget.binding.groupBy[0]!, dimension)
                }
              >
                {label ?? String(dimension ?? "—")}
              </button>
              <div className="sw-measure-track">
                <span
                  style={{
                    width: `${(Math.abs(numeric[index] ?? 0) / extent) * 50}%`,
                    left: `${(numeric[index] ?? 0) >= 0 ? 50 : 50 - (Math.abs(numeric[index] ?? 0) / extent) * 50}%`,
                  }}
                />
              </div>
              <span>
                {format(
                  cell?.value,
                  cell?.type ?? "decimal",
                  cell?.currency,
                  cell?.unit,
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="sw-measure-line">
          <svg viewBox="0 0 600 200" role="img" aria-label={label}>
            <path fill="none" stroke="currentColor" strokeWidth="3" d={path} />
            {points.map((point, index) =>
              point ? (
                <circle
                  key={index}
                  cx={point.split(",")[0]}
                  cy={point.split(",")[1]}
                  r="2.5"
                  fill="currentColor"
                />
              ) : null,
            )}
          </svg>
          <ol>
            {chartRows.map(({ dimension, cell }, index) => (
              <li key={index}>
                <button
                  type="button"
                  disabled={!onFilter}
                  onClick={() =>
                    onFilter?.(widget.binding.groupBy[0]!, dimension)
                  }
                >
                  {String(dimension ?? "—")}
                </button>
                <span>
                  {format(
                    cell?.value,
                    cell?.type ?? "decimal",
                    cell?.currency,
                    cell?.unit,
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {data?.scope?.map((scope) => (
        <p className="sw-measure-scope" key={scope}>
          {scope}
        </p>
      ))}
      {data?.result?.receivedAt ? (
        <p className="sw-measure-scope">
          {t("dashboard.receivedAt", {
            at: new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(data.result.receivedAt)),
          })}
        </p>
      ) : null}
      {data?.result?.totalRows !== undefined &&
      data.result.totalRows > rows.length ? (
        <p className="sw-measure-scope">
          {t("dashboard.shownRows", {
            shown: rows.length,
            total: data.result.totalRows,
          })}
        </p>
      ) : null}
      {data?.result?.stale ? (
        <p className="sw-notice">{t("dashboard.staleModel")}</p>
      ) : null}
      {data?.result?.pendingSources?.length ? (
        <p className="sw-notice">{t("dashboard.pendingResult")}</p>
      ) : null}
      {rows.some((row) =>
        Object.values(row.measures).some((cell) => cell.status === "partial"),
      ) ? (
        <p className="sw-notice">{t("dashboard.partialResult")}</p>
      ) : null}
      {data?.result?.warnings.length ? (
        <p className="sw-notice">
          {t("dashboard.resultWarnings", {
            count: data.result.warnings.length,
          })}
        </p>
      ) : null}
      {data?.sourceHealth
        ?.filter((source) => source.status !== "ok")
        .map((source) => {
          const message = t(
            `dashboard.${source.status === "needs_reauthorization" ? "sourceReconnect" : source.status === "auth_failed" ? "sourceAccess" : source.status === "paused" ? "sourcePaused" : source.status === "pending" ? "sourcePending" : "sourceOutage"}`,
            { name: source.name },
          );
          return (
            <p className="sw-notice" key={source.connectionId}>
              {workspaceId ? (
                <Link
                  href={`/workspaces/${workspaceId}/connections/${source.connectionId}`}
                >
                  {message}
                </Link>
              ) : (
                message
              )}
            </p>
          );
        })}
      {data?.exclusions.map((exclusion) => (
        <p className="sw-measure-scope" key={exclusion.filterId}>
          {exclusion.reason}
        </p>
      ))}
    </article>
  );
}
export function LiveMeasureWidget({
  widget,
  env,
}: {
  widget: MeasureWidget;
  env: StudioEnv;
}) {
  const batch = useDashboardData();
  const [data, setData] = useState<DashboardWidgetData | null>(null),
    [loading, setLoading] = useState(true);
  const key = JSON.stringify({
    widget,
    filters: env.dataFilters ?? [],
    values: env.filterValues ?? {},
  });
  useEffect(() => {
    if (batch !== null) return;
    let alive = true;
    const input = JSON.parse(key) as {
      widget: MeasureWidget;
      filters: NonNullable<StudioEnv["dataFilters"]>;
      values: NonNullable<StudioEnv["filterValues"]>;
    };
    async function refresh() {
      setLoading(true);
      try {
        const response = await previewDashboardMeasures(
          env.workspaceId,
          input.filters,
          input.values,
          [input.widget],
        );
        if (alive) setData(response.widgets[0] ?? null);
      } catch {
        if (alive)
          setData({
            widgetId: widget.id,
            metadata: null,
            result: null,
            error: "data_storage_failed",
            exclusions: widget.binding.exclusions,
          });
      } finally {
        if (alive) setLoading(false);
      }
    }
    // A filter or definition change must not show a result from the previous scope.
    setData(null);
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [env.workspaceId, key, widget.id, batch !== null]);
  return (
    <MeasureWidgetView
      widget={widget}
      workspaceId={env.workspaceId}
      fontScale={env.fontScale}
      data={batch ? (batch.widgets.get(widget.id) ?? null) : data}
      loading={batch ? batch.loading : loading}
    />
  );
}
