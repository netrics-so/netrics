"use client";
import Link from "next/link";
import { useDashboardData } from "./dashboard-data-provider";
import { useEffect, useState, type CSSProperties } from "react";
import {
  SOURCE_HISTORY_INCOMPLETE_WARNING,
  type DashboardWidget,
  type DashboardWidgetData,
} from "@netrics/contracts";
import type { StudioEnv } from "@/lib/studio-widgets";
import { previewDashboardMeasures } from "@/lib/dashboard-data-api";
import { useLocale, useT } from "@/lib/i18n/client";
import { dataErrorKey } from "@/lib/data-editing";
import { ApiError } from "@/lib/api";
import { formatPercentChange } from "@/lib/format-metric";
import { freshnessParts, type FreshnessClock } from "@/lib/freshness";
import { useViewerTimeZone } from "@/lib/viewer-time-zone";
import { contentBox, type ScreenPlacement } from "@/lib/studio-render";
import { useNow } from "./clock-widget";
import {
  currencyExponent,
  displayMeasureAmount,
  formatDataDate,
  MEASURE_UNIT_FRACTION_DIGITS,
  roundDecimalText,
  measureInteractionDimension,
  measureInteractionSelected,
  measureInteractionValue,
  measureTableRowsShown,
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
  unit: string | undefined,
  /** The viewer's zone (#749), for timestamps; days are never converted. */
  timeZone: string,
): string {
  value = displayMeasureAmount(value, unit, currency);
  if (value === null || value === undefined) return "—";
  if (type === "boolean") return value ? yes : no;
  // Days and timestamps as people read them; the viewer's time zone for times.
  const date = formatDataDate(value, type, locale, timeZone);
  if (date !== null) return date;
  // A unit with a display precision (ratings) is rounded; the value stays exact.
  const fractionDigits = unit ? MEASURE_UNIT_FRACTION_DIGITS[unit] : undefined;
  // Decimal strings must never pass through Number, including beyond IEEE-754 precision.
  let text: string;
  if (
    (typeof value === "string" ||
      (typeof value === "number" && Number.isSafeInteger(value))) &&
    (type === "decimal" || currency) &&
    /^-?\d+(?:\.\d+)?$/.test(String(value))
  ) {
    const raw =
      fractionDigits === undefined
        ? String(value)
        : roundDecimalText(String(value), fractionDigits);
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
        ? new Intl.NumberFormat(locale, {
            maximumFractionDigits: fractionDigits ?? 18,
          }).format(value)
        : String(value);
  return currency
    ? `${text} ${currency}`
    : unit === "percent"
      ? `${text}%`
      : unit === "stars"
        ? `${text} ★`
        : text;
}
/** Source states that are the measure widget's warnings (precedence 1). */
const FAILING_SOURCES = new Set([
  "auth_failed",
  "needs_reauthorization",
  "outage",
]);

/**
 * A measure widget's freshness line (ADR 0025 section 8), as parts to
 * drop from the end: none without freshness, for a failed read or without
 * data (precedence 2); only the covered day under a warning (a failing
 * source or a stale widget), in the warning style when the provider is
 * overdue; else the normal or late wording, muted.
 */
export function measureFreshnessLine(
  data: DashboardWidgetData | null,
  clock: FreshnessClock,
): { parts: string[]; warning: boolean } | null {
  const freshness = data?.freshness;
  if (!data || !freshness || data.error || data.status === "no_data") {
    return null;
  }
  const failing =
    data.status === "stale" ||
    data.status === "outage" ||
    (data.sourceHealth ?? []).some((source) =>
      FAILING_SOURCES.has(source.status),
    );
  const parts = freshnessParts(freshness, clock, { warning: failing });
  if (parts.length === 0) return null;
  return {
    parts,
    warning: data.status === "stale" && freshness.late === true,
  };
}

export function MeasureWidgetView({
  widget,
  data,
  loading = false,
  interaction,
  fontScale = 1,
  workspaceId,
  audience = "editor",
  placement,
  showHeader = true,
}: {
  widget: Pick<MeasureWidget, "title" | "options"> & {
    binding: Pick<MeasureWidget["binding"], "measureIds" | "groupBy">;
  };
  fontScale?: number;
  workspaceId?: string;
  data: DashboardWidgetData | null;
  loading?: boolean;
  interaction?: MeasureInteraction;
  /**
   * Who reads it: "viewer" on paired screens (kiosk), where nobody can act
   * on editor instructions ("Check the model preview."); short wording as
   * on tvOS instead (#649). Defaults to the signed-in dashboard and Studio.
   */
  audience?: "editor" | "viewer";
  /**
   * Where the widget sits on a slide (#768): a table then shows the rows
   * that fit its tile above its footer lines, and says "N of M". Absent
   * (scroll views, whose cards grow with their content): every row.
   */
  placement?: ScreenPlacement;
  showHeader?: boolean;
}) {
  const t = useT("data"),
    common = useT("common"),
    locale = useLocale();
  const viewer = audience === "viewer";
  // Relative times in the freshness line, worded anew every minute.
  const clock = useNow();
  // Times (values, the source refresh, the next update) in the viewer's
  // zone (#749); covered days and date values stay as they are.
  const timeZone = useViewerTimeZone();
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
  // A source still loading its history gets its own note (#635); the other
  // warnings are counted.
  const warnings = data?.result?.warnings ?? [];
  const historyIncomplete = warnings.includes(
    SOURCE_HISTORY_INCOMPLETE_WARNING,
  );
  const otherWarnings = warnings.filter(
    (warning) => warning !== SOURCE_HISTORY_INCOMPLETE_WARNING,
  );
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
      timeZone,
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
  const freshness = expired
    ? null
    : measureFreshnessLine(data, { locale, now: clock.getTime(), timeZone });
  const errorKey = expired
    ? "expired"
    : data?.error
      ? dataErrorKey(new ApiError(400, data.error))
      : null;
  // A wall screen says only the state: nobody there can check connections
  // or preparations (#649).
  const error =
    errorKey === null
      ? null
      : viewer
        ? t(
            errorKey === "pending"
              ? "dashboard.viewer.pending"
              : "dashboard.viewer.unavailable",
          )
        : t(`errors.${errorKey}`);
  const fields: DataField[] = [
    ...widget.binding.groupBy.map((id) => {
      const dimension = data?.metadata?.dimensions.find(
        (dimension) => dimension.id === id,
      );
      return {
        id,
        // A table's shorter head (#768), else the model's name.
        name: widget.options.labels?.[id] ?? dimension?.name ?? id,
        type: dimension?.type ?? "string",
        nullable: true,
      } as DataField;
    }),
    ...widget.binding.measureIds.map(
      (id) =>
        ({
          id: `measure.${id}`,
          name:
            widget.options.labels?.[id] ??
            data?.metadata?.measures.find((measure) => measure.id === id)
              ?.name ??
            id,
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
        cellText(id, row.measures[id]),
      ]),
    ),
  }));
  const groupType = widget.binding.groupBy.length ? fields[0]!.type : "string";
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
  // The lines the widget shows besides its rows (#768), in the order it
  // renders them; null is the one-line freshness line. They decide how
  // many rows fit: rows give way first, so the footer is never cut.
  const receivedAt =
    data?.result?.receivedAt && !freshness
      ? t("dashboard.receivedAt", {
          at: new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone,
          }).format(new Date(data.result.receivedAt)),
        })
      : null;
  const notices = [
    data?.result?.stale
      ? t(viewer ? "dashboard.viewer.stale" : "dashboard.staleModel")
      : null,
    data?.result?.pendingSources?.length ? t("dashboard.pendingResult") : null,
    rows.some((row) =>
      Object.values(row.measures).some((cell) => cell.status === "partial"),
    )
      ? t(viewer ? "dashboard.viewer.partial" : "dashboard.partialResult")
      : null,
    historyIncomplete
      ? t(
          viewer
            ? "dashboard.viewer.historyIncomplete"
            : "dashboard.historyIncomplete",
        )
      : null,
    otherWarnings.length
      ? t(viewer ? "dashboard.viewer.warnings" : "dashboard.resultWarnings", {
          count: otherWarnings.length,
        })
      : null,
  ].filter((notice): notice is string => notice !== null);
  const sourceNotices = (data?.sourceHealth ?? [])
    .filter((source) => source.status !== "ok")
    .map((source) => ({
      connectionId: source.connectionId,
      message: t(
        viewer
          ? `dashboard.${source.status === "needs_reauthorization" || source.status === "auth_failed" ? "viewer.sourcePaused" : source.status === "paused" ? "sourcePaused" : source.status === "pending" ? "sourcePending" : "viewer.sourceOutage"}`
          : `dashboard.${source.status === "needs_reauthorization" ? "sourceReconnect" : source.status === "auth_failed" ? "sourceAccess" : source.status === "paused" ? "sourcePaused" : source.status === "pending" ? "sourcePending" : "sourceOutage"}`,
        { name: source.name },
      ),
    }));
  const interactionHint =
    interaction && rows.length > 0 && widget.options.view !== "value"
      ? t("dashboard.interactionHint", { filter: interaction.filterName })
      : null;
  const showsTable =
    !error &&
    data !== null &&
    widget.options.view !== "value" &&
    rows.length > 0 &&
    (widget.options.view === "table" || unsafe);
  const total = Math.max(data?.result?.totalRows ?? 0, rows.length);
  const rowsLine = (shown: number, all: number) =>
    t("dashboard.shownRows", { shown, total: all });
  const cellTexts = tableRows.map((row) =>
    fields.map((field, column) =>
      column >= widget.binding.groupBy.length
        ? String(row[field.id])
        : format(row[field.id], field.type),
    ),
  );
  const fit =
    showsTable && placement
      ? measureTableRowsShown({
          label,
          ...contentBox(placement, showHeader),
          ...(placement.unitPx ? { pixel: 1 / placement.unitPx } : {}),
          fontScale,
          columns: fields.map((field) => field.name),
          rows: cellTexts,
          total,
          footer: [
            ...(interactionHint ? [interactionHint] : []),
            ...(data?.scope ?? []),
            ...(receivedAt ? [receivedAt] : []),
            ...notices,
            ...sourceNotices.map((notice) => notice.message),
            ...(freshness ? [null] : []),
            ...(data?.exclusions ?? []).map((exclusion) => exclusion.reason),
          ],
          rowsLine,
        })
      : {
          shown: rows.length,
          rowsLine: total > rows.length ? rowsLine(rows.length, total) : null,
        };
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
      {interactionHint ? (
        <p className="sw-measure-scope">{interactionHint}</p>
      ) : null}
      {error ? (
        <p className="sw-notice" role="status">
          {error}
        </p>
      ) : !data ? (
        // A screen's wording, not the data editor's "Loading preview…" (#768).
        <p>{loading ? common("loading") : "—"}</p>
      ) : widget.options.view === "value" ? (
        <p className="sw-measure-value">
          {cellText(widget.binding.measureIds[0]!, cell)}
        </p>
      ) : rows.length === 0 ? (
        <p>{viewer ? t("dashboard.viewer.noData") : t("noRows")}</p>
      ) : (widget.options.view === "table" || unsafe) &&
        fit.shown ===
          0 ? null : widget // and no column heads are cut off. // Not even a row fits the tile (#768): its footer says "0 of N",
        .options.view === "table" || unsafe ? (
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
              {/* The rows that fit (#768); measure cells are already shown
                  text (units, rounding). */}
              {cellTexts.slice(0, fit.shown).map((texts, index) => (
                <tr key={index}>
                  {fields.map((field, column) => (
                    <td key={field.id}>
                      {choice(
                        field.id,
                        rows[index]!.dimensions[field.id] ?? null,
                        texts[column]!,
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
                  label ?? format(dimension, groupType),
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
                    format(dimension, groupType),
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
      {/* The freshness line replaces the refresh age (ADR 0025 section 8),
          as on tvOS: they measure different things and read as a
          contradiction side by side (#769). Where no line renders (no
          freshness, a continuous stream under a warning, an expired
          result), the refresh age is the widget's only time. */}
      {receivedAt ? <p className="sw-measure-scope">{receivedAt}</p> : null}
      {fit.rowsLine ? <p className="sw-measure-scope">{fit.rowsLine}</p> : null}
      {notices.map((notice) => (
        <p className="sw-notice" key={notice}>
          {notice}
        </p>
      ))}
      {sourceNotices.map(({ connectionId, message }) => (
        <p className="sw-notice" key={connectionId}>
          {workspaceId ? (
            <Link
              href={`/workspaces/${workspaceId}/connections/${connectionId}`}
            >
              {message}
            </Link>
          ) : (
            message
          )}
        </p>
      ))}
      {freshness ? (
        <p
          className={
            freshness.warning
              ? "sw-measure-freshness sw-measure-freshness--overdue"
              : "sw-measure-freshness"
          }
          title={freshness.parts.join(" · ")}
          suppressHydrationWarning
        >
          {/* Whole parts only: those that do not fit wrap out of sight,
              so a narrow widget drops them from the end. */}
          {freshness.parts.map((part, index) => (
            <span key={index}>{index === 0 ? part : ` · ${part}`}</span>
          ))}
        </p>
      ) : null}
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
  fit = false,
}: {
  widget: MeasureWidget &
    Partial<Pick<ScreenPlacement, "unitBox" | "unitPx" | "format">>;
  env: StudioEnv;
  /** On a slide: a table shows the rows that fit its tile (#768). */
  fit?: boolean;
}) {
  const batch = useDashboardData();
  const [data, setData] = useState<DashboardWidgetData | null>(null),
    [loading, setLoading] = useState(true);
  // The query: the widget without where it sits on a screen.
  const {
    unitBox: _unitBox,
    unitPx: _unitPx,
    format: _format,
    ...query
  } = widget;
  const key = JSON.stringify({
    widget: query,
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
      audience={env.audience}
      {...(fit ? { placement: widget, showHeader: env.showHeader } : {})}
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
