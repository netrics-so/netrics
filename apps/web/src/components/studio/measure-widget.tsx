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
import { formatPercentChange } from "@/lib/format-metric";
import {
  currencyExponent,
  displayMeasureAmount,
  measureInteractionDimension,
  measureInteractionSelected,
  measureInteractionValue,
  type DataField,
} from "@netrics/domain";

export type MeasureWidget = Extract<DashboardWidget, { type: "measure" }>;
/** A declared chart-to-filter interaction, ready for the viewer to click. */
export interface MeasureInteraction {
  /** The grouping dimension whose values are clickable. */
  dimensionId: string;
  filterName: string;
  /** Whether clicking `value` can set the filter (a range has no "missing"). */
  selectable: (value: unknown) => boolean;
  selected: (value: unknown) => boolean;
  /** Sets the filter to `value`, or restores its default when already set. */
  toggle: (value: unknown) => void;
}
type ModelCell = NonNullable<
  DashboardWidgetData["result"]
>["rows"][number]["measures"][string];
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
  interaction,
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
  interaction?: MeasureInteraction;
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
  const percentChange = new Set(
    data?.metadata?.measures
      .filter((measure) => measure.percentChange)
      .map((measure) => measure.id) ?? [],
  );
  /** A measure cell as shown; percent changes read as signed percentages. */
  const cellText = (id: string, cell: ModelCell | undefined) =>
    percentChange.has(id)
      ? formatPercentChange(cell?.value, locale)
      : format(
          cell?.value,
          cell?.type ?? "decimal",
          cell?.currency,
          cell?.unit,
        );
  /** A dimension value as a filter button when the widget declares it. */
  const choice = (dimensionId: string, value: unknown, text: string) =>
    interaction && interaction.dimensionId === dimensionId ? (
      <button
        type="button"
        className="sw-measure-choice"
        disabled={!interaction.selectable(value)}
        aria-pressed={interaction.selected(value)}
        title={t("dashboard.interactionChoice", {
          filter: interaction.filterName,
          value: text,
        })}
        onClick={() => interaction.toggle(value)}
      >
        {text}
      </button>
    ) : (
      text
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
        percentChange.has(id)
          ? cellText(id, row.measures[id])
          : row.measures[id]?.currency
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
      {interaction && rows.length > 0 && widget.options.view !== "value" ? (
        <p className="sw-measure-scope">
          {t("dashboard.interactionHint", {
            filter: interaction.filterName,
          })}
        </p>
      ) : null}
      {error ? (
        <p className="sw-notice" role="status">
          {error}
        </p>
      ) : !data ? (
        <p>{loading ? t("loading") : "—"}</p>
      ) : widget.options.view === "value" ? (
        <p className="sw-measure-value">
          {cellText(widget.binding.measureIds[0]!, cell)}
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
                    <td key={field.id}>
                      {choice(
                        field.id,
                        rows[index]!.dimensions[field.id] ?? null,
                        format(row[field.id], field.type),
                      )}
                    </td>
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
              <span>
                {choice(
                  widget.binding.groupBy[0]!,
                  dimension ?? null,
                  label ?? String(dimension ?? "—"),
                )}
              </span>
              <div className="sw-measure-track">
                <span
                  style={{
                    width: `${(Math.abs(numeric[index] ?? 0) / extent) * 50}%`,
                    left: `${(numeric[index] ?? 0) >= 0 ? 50 : 50 - (Math.abs(numeric[index] ?? 0) / extent) * 50}%`,
                  }}
                />
              </div>
              <span>{cellText(widget.binding.measureIds[0]!, cell)}</span>
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
                <span>
                  {choice(
                    widget.binding.groupBy[0]!,
                    dimension ?? null,
                    String(dimension ?? "—"),
                  )}
                </span>
                <span>{cellText(widget.binding.measureIds[0]!, cell)}</span>
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
      interaction={liveInteraction(widget, env)}
      workspaceId={env.workspaceId}
      fontScale={env.fontScale}
      data={batch ? (batch.widgets.get(widget.id) ?? null) : data}
      loading={batch ? batch.loading : loading}
    />
  );
}

/** The viewer side of a declared interaction; none where the environment is
 * not interactive or the declaration does not apply (Studio lists that). */
export function liveInteraction(
  widget: MeasureWidget,
  env: StudioEnv,
): MeasureInteraction | undefined {
  const filterId = widget.binding.interaction?.filterId,
    onFilterValue = env.onFilterValue;
  const filter = env.dataFilters?.find((filter) => filter.id === filterId);
  if (!filter || !onFilterValue) return undefined;
  let dimensionId: string;
  try {
    dimensionId = measureInteractionDimension(
      env.dataFilters!,
      widget.binding,
      widget.options.view,
    );
  } catch {
    return undefined;
  }
  const current = () =>
    Object.hasOwn(env.filterValues ?? {}, filter.id)
      ? env.filterValues![filter.id]!
      : filter.defaultValue;
  return {
    dimensionId,
    filterName: filter.name,
    selectable: (value) => measureInteractionValue(filter, value) !== null,
    selected: (value) => measureInteractionSelected(filter, current(), value),
    toggle: (value) => {
      const next = measureInteractionValue(filter, value);
      if (!next) return;
      // Clicking the selected value again clears it: back to the saved
      // default, or to all values when the default is that same value.
      onFilterValue(
        filter.id,
        !measureInteractionSelected(filter, current(), value)
          ? next
          : measureInteractionSelected(filter, filter.defaultValue, value)
            ? null
            : undefined,
      );
    },
  };
}
