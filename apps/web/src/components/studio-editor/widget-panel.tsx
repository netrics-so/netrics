"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  DashboardWidget,
  MetricAggregation,
  MetricPeriod,
  WorkspaceMetric,
} from "@netrics/contracts";
import {
  DEFAULT_RESOURCE_NOUN,
  RESOURCE_DIMENSION,
  STUDIO_LIMITS,
  GOAL_PERIODS,
  STATUS_MAX_CONNECTIONS,
  PERIODS,
  WIDGET_TYPES,
  isGoalAggregation,
  aggregationName,
  allResourcesName,
  countdownDoneText,
  periodLabel,
  isDataWidgetType,
  parseCountdownTarget,
  parseTextWidget,
} from "@netrics/domain";

import { Spans } from "@/components/studio/text-widget";
import { metricPickerLabel } from "@/lib/format-metric";
import { goalMetrics } from "@/lib/goals";
import { useLocale, useT } from "@/lib/i18n/client";
import {
  widgetTypeName,
  type StudioAction,
  type StudioProblem,
  type WidgetPatch,
} from "@/lib/studio-document";
import {
  bindMetricPatch,
  clockTimeZones,
  connectionsForType,
  convertWidget,
  currencyChoiceOf,
  currencyPatch,
  denominatorPatch,
  denominatorView,
  type CompareWidget,
  dimensionLabel,
  dimensionPatch,
  filterDimensions,
  findMetric,
  groupByOptions,
  groupByPatch,
  labelPreview,
  metricIdOf,
  metricsForType,
  resourcePatch,
  scopePatch,
} from "@/lib/studio-inspector";
import { fitCheck } from "@/lib/studio-fit-check";
import type { UnreadableLabel } from "@/lib/studio-readability";
import type { DataWidget, StudioConnection } from "@/lib/studio-widgets";
import {
  choiceValue,
  currencyOptionLabel,
  effectiveChoice,
  needsCurrency,
  workspaceChoiceLabel,
} from "@/lib/tile-currency";
import {
  allResourcesOption,
  offersResourceChoice,
  resourceFieldLabel,
  resourceOptionLabel,
} from "@/lib/tile-resource";

import { ImageLibrary, ImagePicker, type PickableImage } from "./image-picker";
import {
  useCurrencies,
  useDimensionValues,
  useResources,
} from "./use-metric-choices";

/** The workspace's display currency and the currencies rates exist for. */
export interface StudioCurrency {
  displayCurrency: string | null;
  convertible: string[];
}

export interface WidgetPanelProps {
  widget: DashboardWidget;
  workspaceId: string;
  metrics: readonly WorkspaceMetric[];
  images: PickableImage[];
  /** Images the draft uses; they cannot be deleted from here. */
  imagesInUse?: ReadonlySet<string>;
  problems: StudioProblem[];
  /** The workspace's time zone (clocks default to it). */
  timeZone?: string;
  /** The theme's text scale, for the label fit. */
  fontScale?: number;
  currency?: StudioCurrency;
  /** Whether the dashboard shows its header (the fit check's grid). */
  showHeader?: boolean;
  /** The canvas's readability warning for this widget, if any (#241). */
  unreadable?: UnreadableLabel;
  /** The workspace's connections, by id: a status board's sources. */
  connections?: Readonly<Record<string, StudioConnection>>;
  dispatch: (action: StudioAction) => void;
  onUploadImage?: (file: File) => Promise<string | null>;
  /** Resolves to null when deleted, else why not. */
  onDeleteImage?: (imageId: string) => Promise<string | null>;
}

function Problems({ problems }: { problems: StudioProblem[] }) {
  const t = useT("studio.settings");
  if (problems.length === 0) return null;
  return (
    <ul className="inspector-problems" aria-label={t("problems")}>
      {problems.map((problem, index) => (
        <li key={index}>{problem.message}</li>
      ))}
    </ul>
  );
}

/**
 * The selected widget (ADR 0015 sections 2 and 9; #225): its type, data
 * binding, title with the label as TVs show it, and style per type. Every
 * change goes to the draft, so the canvas previews it live; nothing
 * reaches the screens before Save.
 */
export function WidgetPanel(props: WidgetPanelProps) {
  const { widget, metrics, problems, dispatch } = props;
  const locale = useLocale();
  const t = useT("studio.widgetPanel");
  const common = useT("common");
  const update = (patch: WidgetPatch) =>
    dispatch({ type: "updateWidget", widgetId: widget.id, patch });
  const metric = isDataWidgetType(widget.type)
    ? findMetric(metrics, widget as DataWidget)
    : undefined;
  const preview = labelPreview(widget, metric, locale, props.fontScale ?? 1);

  return (
    <section className="inspector-section" aria-labelledby="inspector-widget">
      <div className="inspector-head">
        <h2 id="inspector-widget">{widgetTypeName(widget.type, locale)}</h2>
        <span className="inspector-head-meta">
          {t("position", {
            column: widget.x + 1,
            row: widget.y + 1,
            w: widget.w,
            h: widget.h,
          })}
        </span>
      </div>
      <Problems problems={problems} />
      <TypeField {...props} />

      <div className="field">
        <label htmlFor="widget-title">
          {preview ? t("titleOptional") : t("title")}
        </label>
        <input
          id="widget-title"
          type="text"
          value={widget.title ?? ""}
          maxLength={STUDIO_LIMITS.widgetTitleLength}
          placeholder={preview?.defaultLabel || undefined}
          aria-describedby={preview ? "widget-label-preview" : undefined}
          onChange={(event) =>
            update({
              title: event.target.value === "" ? null : event.target.value,
            })
          }
        />
        {preview ? (
          <>
            <p id="widget-label-preview" className="help label-preview">
              {t.rich("shownAs", {
                label: <strong key="label">{preview.label}</strong>,
              })}
            </p>
            {preview.warning ? (
              <p className="help contrast-warn" role="status">
                {preview.warning}
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      {widget.type === "compare" ? (
        <CompareFields {...props} widget={widget} metric={metric} />
      ) : isDataWidgetType(widget.type) ? (
        <DataFields {...props} widget={widget as DataWidget} metric={metric} />
      ) : null}
      <StyleFields {...props} />

      <div className="actions inspector-actions">
        <button
          type="button"
          onClick={() => dispatch({ type: "selectWidget", widgetId: null })}
        >
          {common("done")}
        </button>
        <button
          type="button"
          className="danger"
          onClick={() =>
            dispatch({ type: "deleteWidget", widgetId: widget.id })
          }
        >
          {t("delete")}
        </button>
      </div>
      <FitCheckNote {...props} label={preview?.label ?? ""} />
    </section>
  );
}

/** The fit check at the inspector's foot (design 3b). */
function FitCheckNote({
  widget,
  unreadable,
  fontScale,
  showHeader,
  timeZone,
  label,
}: WidgetPanelProps & { label: string }) {
  const locale = useLocale();
  const check = fitCheck({
    widget,
    label,
    unreadable,
    fontScale: fontScale ?? 1,
    showHeader: showHeader ?? true,
    locale,
    ...(timeZone ? { timeZone } : {}),
  });
  if (!check) return null;
  const icon = { fits: "✓", cut: "⚠", partial: "ℹ" }[check.state];
  return (
    <p
      className={`fit-check fit-check--${check.state}`}
      role={check.state === "fits" ? undefined : "status"}
    >
      <span aria-hidden="true">{icon}</span> {check.text}
    </p>
  );
}

function TypeField({ widget, metrics, images, dispatch }: WidgetPanelProps) {
  const locale = useLocale();
  const t = useT("studio.widgetPanel");
  const context = {
    metrics,
    imageIds: images.map((image) => image.id),
    locale,
  };
  const options = WIDGET_TYPES.map((type) => ({
    type,
    made: convertWidget(widget, type, context),
  }));
  const blocked = options.filter(
    (option) => option.type !== widget.type && "reason" in option.made,
  );
  return (
    <div className="field">
      <label htmlFor="widget-type">{t("type")}</label>
      <select
        id="widget-type"
        value={widget.type}
        aria-describedby={blocked.length > 0 ? "widget-type-help" : undefined}
        onChange={(event) => {
          const option = options.find((o) => o.type === event.target.value);
          if (option && "widget" in option.made) {
            dispatch({
              type: "changeWidgetType",
              widgetId: widget.id,
              widget: option.made.widget,
            });
          }
        }}
      >
        {options.map(({ type, made }) => (
          <option
            key={type}
            value={type}
            disabled={type !== widget.type && "reason" in made}
          >
            {widgetTypeName(type, locale)}
          </option>
        ))}
      </select>
      {blocked.length > 0 ? (
        <p id="widget-type-help" className="help">
          {blocked
            .map(
              (option) =>
                `${widgetTypeName(option.type, locale)}: ${"reason" in option.made ? option.made.reason : ""}`,
            )
            .join(" ")}
        </p>
      ) : (
        <p className="help">{t("typeHelp")}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data binding

/**
 * A compare widget's two binding blocks (ADR 0019 section 10): the
 * numerator with the shared period and display currency, then the
 * denominator, edited through `denominatorView` so the same fields serve
 * both sides.
 */
function CompareFields(
  props: WidgetPanelProps & { widget: CompareWidget; metric?: WorkspaceMetric },
) {
  const { widget, metrics, dispatch } = props;
  const denominator = denominatorView(widget);
  const denominatorDispatch = useCallback(
    (action: StudioAction) => {
      if (action.type === "updateWidget") {
        dispatch({
          type: "updateWidget",
          widgetId: action.widgetId,
          patch: denominatorPatch(widget, action.patch),
        });
      } else {
        dispatch(action);
      }
    },
    [dispatch, widget],
  );
  return (
    <>
      <DataFields {...props} widget={widget} side="numerator" />
      <DataFields
        {...props}
        widget={denominator}
        metric={findMetric(metrics, denominator)}
        side="denominator"
        dispatch={denominatorDispatch}
      />
    </>
  );
}

/**
 * The metric binding of a data widget. Exported for the goal form
 * (ADR 0019 §4), which binds a goal with the same picker: with `goal`, only
 * metrics, periods and aggregations a goal can have are offered, and an
 * amount needs one fixed currency.
 */
export function DataFields({
  widget,
  metric,
  metrics,
  workspaceId,
  currency,
  dispatch,
  goal = false,
  side,
}: Pick<
  WidgetPanelProps,
  "metrics" | "workspaceId" | "currency" | "dispatch"
> & {
  widget: DataWidget;
  metric?: WorkspaceMetric | undefined;
  goal?: boolean;
  /** A compare widget's side; its fields get ids of their own. */
  side?: "numerator" | "denominator" | undefined;
}) {
  const locale = useLocale();
  const t = useT("studio.widgetPanel");
  const id = (name: string) =>
    side === "denominator" ? `widget-denominator-${name}` : `widget-${name}`;
  const update = (patch: WidgetPatch) =>
    dispatch({ type: "updateWidget", widgetId: widget.id, patch });
  const updateOptions = (patch: object) =>
    dispatch({ type: "updateWidgetOptions", widgetId: widget.id, patch });

  const candidates = goal
    ? goalMetrics(metricsForType(metrics, widget.type))
    : metricsForType(metrics, widget.type);
  const connections = goal
    ? connectionsForType(candidates, widget.type)
    : connectionsForType(metrics, widget.type);
  const ofConnection = candidates.filter(
    (candidate) => candidate.connectionId === widget.connectionId,
  );
  // Keep a metric that is no longer listed visible rather than switching it.
  const missing = !metric || !ofConnection.includes(metric);

  function bind(next: WorkspaceMetric | undefined) {
    if (!next) return;
    const patch = bindMetricPatch(widget, next);
    if (patch) update(patch);
  }

  const resources = useResources(workspaceId, metric);
  const noun = resources.noun ?? DEFAULT_RESOURCE_NOUN;
  // A widget of all resources is named by their scope ("Downloads · All
  // apps") on the canvas as soon as the resources are known.
  const scope = scopePatch(
    widget,
    resources.resources?.length ?? null,
    resources.noun,
    locale,
  );
  const scopeKey = scope ? JSON.stringify(scope) : "";
  useEffect(() => {
    if (scopeKey) {
      dispatch({
        type: "updateWidget",
        widgetId: widget.id,
        patch: JSON.parse(scopeKey) as WidgetPatch,
      });
    }
  }, [scopeKey, widget.id, dispatch]);
  const resourceId = widget.dimensions[RESOURCE_DIMENSION] ?? null;
  const groupedByResource =
    (widget.type === "bar" || widget.type === "table") &&
    widget.options.groupBy === RESOURCE_DIMENSION;

  const perCurrency = needsCurrency(metric);
  const currencies = useCurrencies(
    workspaceId,
    metric,
    widget.period,
    resourceId,
  );
  const conversion = currency ?? { displayCurrency: null, convertible: [] };
  const workspaceCurrency =
    conversion.convertible.length > 0 ? conversion.displayCurrency : null;
  const saved = currencyChoiceOf(widget);
  // A saved choice stays selectable while its options load; a goal keeps
  // its currency even in a period without amounts in it yet.
  const choice =
    goal || currencies.totals === null
      ? saved
      : effectiveChoice(
          choiceValue(saved),
          currencies.totals,
          conversion.convertible,
        );

  return (
    <>
      <fieldset>
        <legend>{side ? t(side) : t("data")}</legend>
        <div className="field">
          <label htmlFor={id("connection")}>{t("connection")}</label>
          <span className="field-swatch-row">
            <span className="field-swatch" aria-hidden="true" />
            <select
              id={id("connection")}
              value={widget.connectionId}
              onChange={(event) =>
                bind(
                  candidates.find(
                    (candidate) =>
                      candidate.connectionId === event.target.value,
                  ),
                )
              }
            >
              {connections.some((c) => c.id === widget.connectionId) ? null : (
                <option value={widget.connectionId}>
                  {metric?.connectionName ?? t("removedConnection")}
                </option>
              )}
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}
                </option>
              ))}
            </select>
          </span>
        </div>
        <div className="field">
          <label htmlFor={id("metric")}>{t("metric")}</label>
          <select
            id={id("metric")}
            value={`${widget.connectionId}|${widget.metricKey}`}
            onChange={(event) =>
              bind(
                ofConnection.find(
                  (candidate) => metricIdOf(candidate) === event.target.value,
                ),
              )
            }
          >
            {missing ? (
              <option value={`${widget.connectionId}|${widget.metricKey}`}>
                {t("notAvailable", {
                  name: metric
                    ? metricPickerLabel(metric, locale)
                    : widget.metricKey,
                })}
              </option>
            ) : null}
            {ofConnection.map((candidate) => (
              <option key={metricIdOf(candidate)} value={metricIdOf(candidate)}>
                {metricPickerLabel(candidate, locale)}
              </option>
            ))}
          </select>
          {metric?.description ? (
            <p className="help">{metric.description}</p>
          ) : null}
          {widget.type === "bar" ? (
            <p className="help">{t("barMetrics")}</p>
          ) : widget.type === "table" ? (
            <p className="help">{t("tableMetrics")}</p>
          ) : null}
        </div>
        <div className="field-pair">
          {side === "denominator" ? null : (
            <div className="field">
              <label htmlFor="widget-period">{t("period")}</label>
              <select
                id="widget-period"
                value={widget.period}
                aria-describedby={
                  side === "numerator" ? "widget-period-shared" : undefined
                }
                onChange={(event) =>
                  update({ period: event.target.value as MetricPeriod })
                }
              >
                {(goal ? GOAL_PERIODS : PERIODS).map((option) => (
                  <option key={option} value={option}>
                    {periodLabel(option, locale)}
                  </option>
                ))}
              </select>
              {side === "numerator" ? (
                <p id="widget-period-shared" className="help">
                  {t("sharedPeriod")}
                </p>
              ) : null}
            </div>
          )}
          <div className="field">
            <label htmlFor={id("aggregation")}>{t("show")}</label>
            <select
              id={id("aggregation")}
              value={widget.aggregation}
              onChange={(event) =>
                update({
                  aggregation: event.target.value as MetricAggregation,
                })
              }
            >
              {(metric?.aggregations ?? [widget.aggregation])
                .filter((option) => !goal || isGoalAggregation(option))
                .map((option) => (
                  <option key={option} value={option}>
                    {metric ? aggregationName(option, metric, locale) : option}
                  </option>
                ))}
            </select>
          </div>
        </div>
        {!groupedByResource &&
        (offersResourceChoice(resources.resources) ||
          resources.error ||
          resourceId) ? (
          <div className="field">
            <label htmlFor={id("resource")}>{resourceFieldLabel(noun)}</label>
            <select
              id={id("resource")}
              value={resourceId ?? ""}
              disabled={!resources.resources}
              onChange={(event) => {
                const picked =
                  resources.resources?.find(
                    (option) => option.id === event.target.value,
                  ) ?? null;
                update(
                  resourcePatch(
                    widget,
                    picked,
                    allResourcesName(
                      noun,
                      resources.resources?.length ?? 0,
                      locale,
                    ),
                  ),
                );
              }}
            >
              <option value="">{allResourcesOption(noun, locale)}</option>
              {resourceId &&
              !resources.resources?.some((r) => r.id === resourceId) ? (
                <option value={resourceId}>
                  {widget.resourceName ?? resourceId}
                </option>
              ) : null}
              {(resources.resources ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {resourceOptionLabel(option)}
                </option>
              ))}
            </select>
            <p className="help">
              {resources.error ??
                t("resourceHelp", {
                  count: resources.resources?.length ?? 0,
                  plural: noun.plural,
                  connection: metric?.connectionName ?? t("theConnection"),
                })}
            </p>
          </div>
        ) : null}
        {perCurrency ? (
          <div className="field">
            <label htmlFor={id("currency")}>{t("currency")}</label>
            <select
              id={id("currency")}
              value={choiceValue(choice)}
              onChange={(event) => {
                const [kind, code] = event.target.value.split(":");
                update(
                  currencyPatch(
                    widget,
                    kind === "only" || kind === "convert"
                      ? { kind, currency: code! }
                      : { kind: "workspace" },
                  ),
                );
              }}
            >
              {goal ? (
                // A goal's target is in one currency (ADR 0019 §4).
                <option value="" disabled>
                  {t("pickCurrency")}
                </option>
              ) : (
                <option value="">
                  {workspaceChoiceLabel(
                    workspaceCurrency,
                    currencies.totals,
                    locale,
                  )}
                </option>
              )}
              {conversion.convertible.length > 0 ? (
                <optgroup label={t("convertedGroup")}>
                  {conversion.convertible.map((code) => (
                    <option key={code} value={`convert:${code}`}>
                      {t("convertedTo", { currency: code })}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <optgroup label={t("exactGroup")}>
                {choice.kind === "only" &&
                !currencies.totals?.some(
                  (option) => option.currency === choice.currency,
                ) ? (
                  <option value={choiceValue(choice)}>{choice.currency}</option>
                ) : null}
                {(currencies.totals ?? []).map((option) => (
                  <option
                    key={option.currency}
                    value={`only:${option.currency}`}
                  >
                    {currencyOptionLabel(option, locale)}
                  </option>
                ))}
              </optgroup>
            </select>
            <p className="help">
              {currencies.error
                ? currencies.error
                : !currencies.totals
                  ? t("loadingCurrencies")
                  : goal && choice.kind === "workspace"
                    ? t("pickCurrencyHelp")
                    : choice.kind === "only"
                      ? t("onlyCurrency", { currency: choice.currency })
                      : choice.kind === "convert" ||
                          (choice.kind === "workspace" && workspaceCurrency)
                        ? t("approximate")
                        : t("largestCurrency")}
            </p>
          </div>
        ) : null}
        {metric ? (
          <FilterFields
            key={`${widget.id}:${side ?? ""}`}
            idPrefix={id("filter")}
            workspaceId={workspaceId}
            widget={widget}
            metric={metric}
            onChange={(dimension, value) =>
              update(dimensionPatch(widget, dimension, value))
            }
          />
        ) : null}
      </fieldset>

      {widget.type === "bar" || widget.type === "table" ? (
        <fieldset>
          <legend>{widget.type === "table" ? t("rows") : t("bars")}</legend>
          <div className="field">
            <label htmlFor="widget-group-by">{t("groupBy")}</label>
            <select
              id="widget-group-by"
              value={widget.options.groupBy}
              onChange={(event) =>
                update(groupByPatch(widget, event.target.value))
              }
            >
              {(metric ? groupByOptions(metric) : [widget.options.groupBy]).map(
                (dimension) => (
                  <option key={dimension} value={dimension}>
                    {dimension === RESOURCE_DIMENSION
                      ? resourceFieldLabel(noun)
                      : (metric?.dimensionNames?.[dimension] ??
                        dimensionLabel(dimension))}
                  </option>
                ),
              )}
            </select>
          </div>
          <div className="field">
            <label htmlFor="widget-limit">
              {widget.type === "table"
                ? t("rowsShown", { count: widget.options.limit })
                : t("barsShown", { count: widget.options.limit })}
            </label>
            <input
              id="widget-limit"
              type="range"
              min={3}
              max={10}
              step={1}
              value={widget.options.limit}
              aria-describedby="widget-limit-help"
              onChange={(event) =>
                updateOptions({ limit: Number(event.target.value) })
              }
            />
            <p id="widget-limit-help" className="help">
              {widget.type === "table" ? t("rowsHelp") : t("barsHelp")}
            </p>
          </div>
        </fieldset>
      ) : null}
    </>
  );
}

/**
 * Filters as chips (design 3b): one per dimension filtered on, with a
 * button to remove it, and "+ add" for the dimension pickers. The pickers
 * show at once while nothing is filtered.
 */
function FilterFields({
  idPrefix,
  workspaceId,
  widget,
  metric,
  onChange,
}: {
  /** Ids of this binding's pickers ("widget-filter"). */
  idPrefix: string;
  workspaceId: string;
  widget: DataWidget;
  metric: WorkspaceMetric;
  onChange: (dimension: string, value: string | null) => void;
}) {
  const t = useT("studio.widgetPanel");
  const dimensions = filterDimensions(metric, widget);
  const nameOf = (dimension: string) =>
    metric.dimensionNames?.[dimension] ?? dimensionLabel(dimension);
  const active = dimensions.filter(
    (dimension) => (widget.dimensions[dimension] ?? null) !== null,
  );
  const [open, setOpen] = useState(active.length === 0);
  const pickersId = `${idPrefix}s-${widget.id}`;
  if (dimensions.length === 0) {
    return null;
  }
  return (
    <div className="filter-group">
      <span className="field-label">{t("filter")}</span>
      <div className="filter-chips">
        {active.map((dimension) => {
          const name = nameOf(dimension);
          return (
            <span key={dimension} className="filter-chip">
              {t("filterChip", {
                name,
                value: widget.dimensions[dimension] ?? "",
              })}
              <button
                type="button"
                className="filter-chip-remove"
                aria-label={t("filterRemove", { name })}
                title={t("filterRemove", { name })}
                onClick={() => onChange(dimension, null)}
              >
                ×
              </button>
            </span>
          );
        })}
        <button
          type="button"
          className="filter-add"
          aria-expanded={open}
          aria-controls={pickersId}
          onClick={() => setOpen(!open)}
        >
          {open ? t("filterDone") : t("filterAdd")}
        </button>
      </div>
      {open ? (
        <div id={pickersId} className="filter-pickers">
          {dimensions.map((dimension) => (
            <DimensionFilter
              key={dimension}
              id={`${idPrefix}-${dimension}`}
              workspaceId={workspaceId}
              widget={widget}
              dimension={dimension}
              label={nameOf(dimension)}
              onChange={(value) => onChange(dimension, value)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DimensionFilter({
  id,
  workspaceId,
  widget,
  dimension,
  label,
  onChange,
}: {
  id: string;
  workspaceId: string;
  widget: DataWidget;
  dimension: string;
  /** The dimension's name in the viewer's language (from the connector). */
  label: string;
  onChange: (value: string | null) => void;
}) {
  const t = useT("studio.widgetPanel");
  const current = widget.dimensions[dimension] ?? null;
  const { values, error } = useDimensionValues(workspaceId, widget, dimension);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={current ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{t("all")}</option>
        {current !== null && !values?.some((v) => v.key === current) ? (
          <option value={current}>{current}</option>
        ) : null}
        {(values ?? []).map((value) => (
          <option key={value.key} value={value.key}>
            {value.label}
          </option>
        ))}
      </select>
      <p className="help">
        {error ?? (values === null ? t("loadingValues") : t("filterHelp"))}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style per type

function Check({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: string;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {children}
    </label>
  );
}

const ALIGNMENTS = ["start", "center", "end"] as const;
type Alignment = (typeof ALIGNMENTS)[number];

function AlignField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: Alignment;
  onChange: (value: Alignment) => void;
}) {
  const t = useT("studio.widgetPanel");
  return (
    <div className="field">
      <label htmlFor={id}>{t("align")}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as Alignment)}
      >
        {ALIGNMENTS.map((key) => (
          <option key={key} value={key}>
            {t(`alignments.${key}`)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * A status board's sources (ADR 0019 section 7): every connection, or a
 * checklist of up to 12; and whether rows show the age of the last sync.
 */
function StatusFields({
  widget,
  connections,
  onOptions,
}: {
  widget: Extract<DashboardWidget, { type: "status" }>;
  connections: Readonly<Record<string, StudioConnection>>;
  onOptions: (patch: object) => void;
}) {
  const t = useT("studio.widgetPanel");
  const locale = useLocale();
  const all = Object.entries(connections).sort(([, a], [, b]) =>
    a.name.localeCompare(b.name, locale),
  );
  const chosen = widget.options.connectionIds;
  const selected = new Set(chosen ?? []);
  const toggle = (id: string, on: boolean) => {
    const next = all
      .map(([key]) => key)
      .filter((key) => (key === id ? on : selected.has(key)));
    // At least one chosen source; none left means every source again.
    onOptions({ connectionIds: next.length > 0 ? next : null });
  };
  return (
    <>
      <fieldset>
        <legend>{t("sources")}</legend>
        {all.length === 0 ? <p className="help">{t("noSources")}</p> : null}
        <label className="check">
          <input
            type="radio"
            name="status-sources"
            checked={chosen === null}
            onChange={() => onOptions({ connectionIds: null })}
          />
          {t("allSources")}
        </label>
        <label className="check">
          <input
            type="radio"
            name="status-sources"
            checked={chosen !== null}
            disabled={all.length === 0}
            onChange={() =>
              onOptions({
                connectionIds: all
                  .slice(0, STATUS_MAX_CONNECTIONS)
                  .map(([id]) => id),
              })
            }
          />
          {t("chosenSources")}
        </label>
        {chosen !== null ? (
          <div className="status-sources" role="group">
            {all.map(([id, connection]) => (
              <Check
                key={id}
                checked={selected.has(id)}
                disabled={
                  !selected.has(id) && selected.size >= STATUS_MAX_CONNECTIONS
                }
                onChange={(on) => toggle(id, on)}
              >
                {connection.name}
              </Check>
            ))}
          </div>
        ) : null}
        <p className="help">
          {t("sourcesHelp", { max: STATUS_MAX_CONNECTIONS })}
        </p>
      </fieldset>
      <fieldset>
        <legend>{t("style")}</legend>
        <Check
          checked={widget.options.showAge}
          onChange={(showAge) => onOptions({ showAge })}
        >
          {t("showAge")}
        </Check>
      </fieldset>
    </>
  );
}

function StyleFields({
  widget,
  images,
  imagesInUse,
  timeZone,
  connections,
  dispatch,
  onUploadImage,
  onDeleteImage,
}: WidgetPanelProps) {
  const t = useT("studio.widgetPanel");
  const locale = useLocale();
  const update = (patch: WidgetPatch) =>
    dispatch({ type: "updateWidget", widgetId: widget.id, patch });
  const options = (patch: object) =>
    dispatch({ type: "updateWidgetOptions", widgetId: widget.id, patch });

  switch (widget.type) {
    case "metric":
      return (
        <fieldset>
          <legend>{t("style")}</legend>
          <Check
            checked={widget.options.showChange}
            onChange={(showChange) => options({ showChange })}
          >
            {t("showChange")}
          </Check>
          <Check
            checked={widget.options.showSparkline}
            onChange={(showSparkline) => options({ showSparkline })}
          >
            {t("sparkline")}
          </Check>
        </fieldset>
      );
    case "line":
      return (
        <fieldset>
          <legend>{t("style")}</legend>
          <Check
            checked={widget.options.showPrevious}
            onChange={(showPrevious) => options({ showPrevious })}
          >
            {t("showPrevious")}
          </Check>
          <Check
            checked={widget.options.showAxis}
            onChange={(showAxis) => options({ showAxis })}
          >
            {t("axisLabels")}
          </Check>
        </fieldset>
      );
    case "bar":
      return null;
    case "compare":
      return (
        <fieldset>
          <legend>{t("compare")}</legend>
          <div className="field">
            <label htmlFor="widget-compare-format">{t("format")}</label>
            <select
              id="widget-compare-format"
              value={widget.options.format}
              aria-describedby="widget-compare-format-help"
              onChange={(event) =>
                options({
                  format: event.target.value === "ratio" ? "ratio" : "percent",
                })
              }
            >
              <option value="percent">{t("formatPercent")}</option>
              <option value="ratio">{t("formatRatio")}</option>
            </select>
            <p id="widget-compare-format-help" className="help">
              {t("formatHelp")}
            </p>
          </div>
          <div className="field">
            <label htmlFor="widget-ratio-label">{t("ratioLabel")}</label>
            <input
              id="widget-ratio-label"
              type="text"
              maxLength={30}
              value={widget.options.ratioLabel ?? ""}
              placeholder={t("ratioLabelPlaceholder")}
              aria-describedby="widget-ratio-label-help"
              onChange={(event) =>
                options({
                  ratioLabel:
                    event.target.value.trim() === ""
                      ? null
                      : event.target.value,
                })
              }
            />
            <p id="widget-ratio-label-help" className="help">
              {t("ratioLabelHelp")}
            </p>
          </div>
          <Check
            checked={widget.options.showChange}
            onChange={(showChange) => options({ showChange })}
          >
            {t("compareChange")}
          </Check>
        </fieldset>
      );
    case "status":
      return (
        <StatusFields
          widget={widget}
          connections={connections ?? {}}
          onOptions={options}
        />
      );
    case "table":
      return (
        <fieldset>
          <legend>{t("style")}</legend>
          <Check
            checked={widget.options.showChange}
            onChange={(showChange) => options({ showChange })}
          >
            {t("showChange")}
          </Check>
          <Check
            checked={widget.options.showOthers}
            onChange={(showOthers) => options({ showOthers })}
          >
            {t("showOthers")}
          </Check>
        </fieldset>
      );
    case "text":
      return (
        <fieldset>
          <legend>{t("text")}</legend>
          <div className="field">
            <label htmlFor="widget-text">{t("text")}</label>
            <textarea
              id="widget-text"
              rows={6}
              value={widget.text}
              maxLength={STUDIO_LIMITS.textLength}
              aria-describedby="widget-text-help widget-text-count"
              onChange={(event) => update({ text: event.target.value })}
            />
            <p id="widget-text-help" className="help">
              {t("textHelp")}
            </p>
            <p
              id="widget-text-count"
              className={
                widget.text.length >= STUDIO_LIMITS.textLength
                  ? "help contrast-warn"
                  : "help"
              }
            >
              {t("characters", {
                count: widget.text.length,
                max: STUDIO_LIMITS.textLength,
              })}
            </p>
          </div>
          <TextPreview text={widget.text} />
          <div className="field">
            <label htmlFor="widget-size">{t("size")}</label>
            <select
              id="widget-size"
              value={widget.options.size}
              onChange={(event) =>
                options({
                  size: event.target.value as typeof widget.options.size,
                })
              }
            >
              <option value="body">{t("sizes.body")}</option>
              <option value="heading">{t("sizes.heading")}</option>
              <option value="display">{t("sizes.display")}</option>
            </select>
            <p className="help">{t("sizeHelp")}</p>
          </div>
          <AlignField
            id="widget-align"
            value={widget.options.align}
            onChange={(align) => options({ align })}
          />
        </fieldset>
      );
    case "clock": {
      const workspaceZone = timeZone ?? "UTC";
      return (
        <fieldset>
          <legend>{t("clock")}</legend>
          <div className="field">
            <label htmlFor="widget-time-zone">{t("timeZone")}</label>
            <select
              id="widget-time-zone"
              value={widget.options.timeZone ?? ""}
              onChange={(event) =>
                options({ timeZone: event.target.value || null })
              }
            >
              <option value="">
                {t("workspaceZone", { zone: workspaceZone })}
              </option>
              {clockTimeZones(workspaceZone)
                .slice(1)
                .map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll("_", " ")}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="widget-hour-cycle">{t("hours")}</label>
            <select
              id="widget-hour-cycle"
              value={widget.options.hour12 ? "12" : "24"}
              onChange={(event) =>
                options({ hour12: event.target.value === "12" })
              }
            >
              <option value="24">{t("hours24")}</option>
              <option value="12">{t("hours12")}</option>
            </select>
          </div>
          <Check
            checked={widget.options.showDate}
            onChange={(showDate) => options({ showDate })}
          >
            {t("date")}
          </Check>
          {widget.options.showDate ? (
            <div className="field">
              <label htmlFor="widget-date-style">{t("dateStyle")}</label>
              <select
                id="widget-date-style"
                value={widget.options.dateStyle}
                onChange={(event) =>
                  options({
                    dateStyle: event.target.value === "long" ? "long" : "short",
                  })
                }
              >
                <option value="short">{t("dateShort")}</option>
                <option value="long">{t("dateLong")}</option>
              </select>
            </div>
          ) : null}
          <Check
            checked={widget.options.showZone}
            onChange={(showZone) => options({ showZone })}
          >
            {t("showZone")}
          </Check>
          <p className="help">{t("zoneHelp")}</p>
        </fieldset>
      );
    }
    case "countdown": {
      // ADR 0019 section 8: a local date and time in a zone; a past one
      // still saves (the fit check and the formats say so).
      const workspaceZone = timeZone ?? "UTC";
      return (
        <fieldset>
          <legend>{t("countdown")}</legend>
          <div className="field">
            <label htmlFor="widget-countdown-target">
              {t("countdownTarget")}
            </label>
            <input
              id="widget-countdown-target"
              type="datetime-local"
              value={widget.options.target}
              min="2000-01-01T00:00"
              max="2100-12-31T23:59"
              required
              aria-describedby="widget-countdown-target-help"
              onChange={(event) => {
                const target = event.target.value.slice(0, 16);
                if (parseCountdownTarget(target)) options({ target });
              }}
            />
            <p id="widget-countdown-target-help" className="help">
              {t("countdownTargetHelp")}
            </p>
          </div>
          <div className="field">
            <label htmlFor="widget-time-zone">{t("timeZone")}</label>
            <select
              id="widget-time-zone"
              value={widget.options.timeZone ?? ""}
              onChange={(event) =>
                options({ timeZone: event.target.value || null })
              }
            >
              <option value="">
                {t("workspaceZone", { zone: workspaceZone })}
              </option>
              {clockTimeZones(workspaceZone)
                .slice(1)
                .map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll("_", " ")}
                  </option>
                ))}
            </select>
          </div>
          <Check
            checked={widget.options.showTarget}
            onChange={(showTarget) => options({ showTarget })}
          >
            {t("showTarget")}
          </Check>
          <div className="field">
            <label htmlFor="widget-done-text">{t("doneText")}</label>
            <input
              id="widget-done-text"
              type="text"
              value={widget.options.doneText ?? ""}
              maxLength={40}
              placeholder={countdownDoneText(null, locale)}
              aria-describedby="widget-done-text-help"
              onChange={(event) =>
                options({
                  doneText:
                    event.target.value.trim() === ""
                      ? null
                      : event.target.value,
                })
              }
            />
            <p id="widget-done-text-help" className="help">
              {t("doneTextHelp")}
            </p>
          </div>
        </fieldset>
      );
    }
    case "image":
      return (
        <fieldset>
          <legend>{t("image")}</legend>
          <ImagePicker
            id="widget-image"
            label={t("image")}
            images={images}
            value={widget.imageId}
            onChange={(imageId) => {
              if (imageId) update({ imageId });
            }}
            onUpload={onUploadImage}
          />
          <div className="field">
            <label htmlFor="widget-fit">{t("fit")}</label>
            <select
              id="widget-fit"
              value={widget.options.fit}
              onChange={(event) =>
                options({
                  fit: event.target.value as typeof widget.options.fit,
                })
              }
            >
              <option value="contain">{t("fitContain")}</option>
              <option value="cover">{t("fitCover")}</option>
            </select>
          </div>
          <AlignField
            id="widget-align"
            value={widget.options.align}
            onChange={(align) => options({ align })}
          />
          {onDeleteImage ? (
            <ImageLibrary
              images={images}
              inUse={imagesInUse ?? new Set([widget.imageId])}
              onDelete={onDeleteImage}
            />
          ) : null}
        </fieldset>
      );
  }
}

/** The text as markdown-lite renders it, without the TV's sizes. */
export function TextPreview({ text }: { text: string }) {
  const t = useT("studio.widgetPanel");
  const blocks = parseTextWidget(text);
  return (
    <div className="text-preview" aria-label={t("preview")}>
      {blocks.map((block, index) =>
        block.kind === "heading" ? (
          block.level === 1 ? (
            <h3 key={index}>
              <Spans spans={block.spans} />
            </h3>
          ) : (
            <h4 key={index}>
              <Spans spans={block.spans} />
            </h4>
          )
        ) : (
          <p key={index}>
            {block.lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 ? <br /> : null}
                <Spans spans={line} />
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}
