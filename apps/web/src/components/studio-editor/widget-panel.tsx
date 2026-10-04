"use client";

import { useEffect } from "react";

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
  WIDGET_TYPES,
  allResourcesName,
  isDataWidgetType,
  parseTextWidget,
} from "@netrics/domain";

import { Spans } from "@/components/studio/text-widget";
import {
  PERIOD_LABELS,
  aggregationLabel,
  metricPickerLabel,
} from "@/lib/format-metric";
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
import type { DataWidget } from "@/lib/studio-widgets";
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

const PERIODS = Object.keys(PERIOD_LABELS) as MetricPeriod[];

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
  dispatch: (action: StudioAction) => void;
  onUploadImage?: (file: File) => Promise<string | null>;
  /** Resolves to null when deleted, else why not. */
  onDeleteImage?: (imageId: string) => Promise<string | null>;
}

function Problems({ problems }: { problems: StudioProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="inspector-problems" aria-label="Problems">
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
  const update = (patch: WidgetPatch) =>
    dispatch({ type: "updateWidget", widgetId: widget.id, patch });
  const metric = isDataWidgetType(widget.type)
    ? findMetric(metrics, widget as DataWidget)
    : undefined;
  const preview = labelPreview(widget, metric, props.fontScale ?? 1);

  return (
    <section className="inspector-section" aria-labelledby="inspector-widget">
      <h2 id="inspector-widget">{widgetTypeName(widget.type)}</h2>
      <p className="help">
        Column {widget.x + 1}, row {widget.y + 1} · {widget.w} × {widget.h}{" "}
        cells
        {metric ? ` · ${metric.connectionName}` : ""}
      </p>
      <Problems problems={problems} />
      <TypeField {...props} />

      <div className="field">
        <label htmlFor="widget-title">
          Title{preview ? " (optional)" : ""}
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
              Shown as <strong>{preview.label}</strong>
            </p>
            {preview.warning ? (
              <p className="help contrast-warn" role="status">
                {preview.warning}
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      {isDataWidgetType(widget.type) ? (
        <DataFields {...props} widget={widget as DataWidget} metric={metric} />
      ) : null}
      <StyleFields {...props} />

      <div className="actions">
        <button
          type="button"
          onClick={() => dispatch({ type: "selectWidget", widgetId: null })}
        >
          Done
        </button>
        <button
          type="button"
          className="danger"
          onClick={() =>
            dispatch({ type: "deleteWidget", widgetId: widget.id })
          }
        >
          Delete widget
        </button>
      </div>
    </section>
  );
}

function TypeField({ widget, metrics, images, dispatch }: WidgetPanelProps) {
  const context = { metrics, imageIds: images.map((image) => image.id) };
  const options = WIDGET_TYPES.map((type) => ({
    type,
    made: convertWidget(widget, type, context),
  }));
  const blocked = options.filter(
    (option) => option.type !== widget.type && "reason" in option.made,
  );
  return (
    <div className="field">
      <label htmlFor="widget-type">Type</label>
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
            {widgetTypeName(type)}
          </option>
        ))}
      </select>
      {blocked.length > 0 ? (
        <p id="widget-type-help" className="help">
          {blocked
            .map(
              (option) =>
                `${widgetTypeName(option.type)}: ${"reason" in option.made ? option.made.reason : ""}`,
            )
            .join(" ")}
        </p>
      ) : (
        <p className="help">
          Changing the type keeps the title and, between charts, the metric.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data binding

function DataFields({
  widget,
  metric,
  metrics,
  workspaceId,
  currency,
  dispatch,
}: WidgetPanelProps & { widget: DataWidget; metric?: WorkspaceMetric }) {
  const update = (patch: WidgetPatch) =>
    dispatch({ type: "updateWidget", widgetId: widget.id, patch });
  const updateOptions = (patch: object) =>
    dispatch({ type: "updateWidgetOptions", widgetId: widget.id, patch });

  const candidates = metricsForType(metrics, widget.type);
  const connections = connectionsForType(metrics, widget.type);
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
    widget.type === "bar" && widget.options.groupBy === RESOURCE_DIMENSION;

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
  // A saved choice stays selectable while its options load.
  const choice =
    currencies.totals === null
      ? saved
      : effectiveChoice(
          choiceValue(saved),
          currencies.totals,
          conversion.convertible,
        );

  return (
    <>
      <fieldset>
        <legend>Data</legend>
        <div className="field">
          <label htmlFor="widget-connection">Connection</label>
          <select
            id="widget-connection"
            value={widget.connectionId}
            onChange={(event) =>
              bind(
                candidates.find(
                  (candidate) => candidate.connectionId === event.target.value,
                ),
              )
            }
          >
            {connections.some((c) => c.id === widget.connectionId) ? null : (
              <option value={widget.connectionId}>
                {metric?.connectionName ?? "Removed connection"}
              </option>
            )}
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="widget-metric">Metric</label>
          <select
            id="widget-metric"
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
                {metric ? metricPickerLabel(metric) : widget.metricKey} (not
                available)
              </option>
            ) : null}
            {ofConnection.map((candidate) => (
              <option key={metricIdOf(candidate)} value={metricIdOf(candidate)}>
                {metricPickerLabel(candidate)}
              </option>
            ))}
          </select>
          {metric?.description ? (
            <p className="help">{metric.description}</p>
          ) : null}
          {widget.type === "bar" ? (
            <p className="help">
              Bar charts list metrics that can be broken down.
            </p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="widget-aggregation">Show</label>
          <select
            id="widget-aggregation"
            value={widget.aggregation}
            onChange={(event) =>
              update({
                aggregation: event.target.value as MetricAggregation,
              })
            }
          >
            {(metric?.aggregations ?? [widget.aggregation]).map((option) => (
              <option key={option} value={option}>
                {metric ? aggregationLabel(option, metric) : option}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="widget-period">Period</label>
          <select
            id="widget-period"
            value={widget.period}
            onChange={(event) =>
              update({ period: event.target.value as MetricPeriod })
            }
          >
            {PERIODS.map((option) => (
              <option key={option} value={option}>
                {PERIOD_LABELS[option]}
              </option>
            ))}
          </select>
        </div>
        {!groupedByResource &&
        (offersResourceChoice(resources.resources) ||
          resources.error ||
          resourceId) ? (
          <div className="field">
            <label htmlFor="widget-resource">{resourceFieldLabel(noun)}</label>
            <select
              id="widget-resource"
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
                    allResourcesName(noun, resources.resources?.length ?? 0),
                  ),
                );
              }}
            >
              <option value="">{allResourcesOption(noun)}</option>
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
                `All ${resources.resources?.length ?? 0} ${noun.plural} of ${metric?.connectionName ?? "the connection"} added up, or one of them.`}
            </p>
          </div>
        ) : null}
        {perCurrency ? (
          <div className="field">
            <label htmlFor="widget-currency">Currency</label>
            <select
              id="widget-currency"
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
              <optgroup label="One currency, exact">
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
                    {currencyOptionLabel(option)}
                  </option>
                ))}
              </optgroup>
            </select>
            <p className="help">
              {currencies.error
                ? currencies.error
                : !currencies.totals
                  ? "Loading currencies…"
                  : choice.kind === "only"
                    ? `Only amounts in ${choice.currency}, exact.`
                    : choice.kind === "convert" ||
                        (choice.kind === "workspace" && workspaceCurrency)
                      ? "Approximate: each day converted at that day's ECB reference rate. Currencies without a rate are shown apart."
                      : "Amounts are not added up across currencies: the widget shows the largest one."}
            </p>
          </div>
        ) : null}
        {metric
          ? filterDimensions(metric, widget).map((dimension) => (
              <DimensionFilter
                key={dimension}
                workspaceId={workspaceId}
                widget={widget}
                dimension={dimension}
                onChange={(value) =>
                  update(dimensionPatch(widget, dimension, value))
                }
              />
            ))
          : null}
      </fieldset>

      {widget.type === "bar" ? (
        <fieldset>
          <legend>Bars</legend>
          <div className="field">
            <label htmlFor="widget-group-by">Group by</label>
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
                      : dimensionLabel(dimension)}
                  </option>
                ),
              )}
            </select>
          </div>
          <div className="field">
            <label htmlFor="widget-limit">
              Bars shown: {widget.options.limit}
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
              The largest groups, the rest added up as “Others”.
            </p>
          </div>
        </fieldset>
      ) : null}
    </>
  );
}

function DimensionFilter({
  workspaceId,
  widget,
  dimension,
  onChange,
}: {
  workspaceId: string;
  widget: DataWidget;
  dimension: string;
  onChange: (value: string | null) => void;
}) {
  const current = widget.dimensions[dimension] ?? null;
  const { values, error } = useDimensionValues(workspaceId, widget, dimension);
  const id = `widget-filter-${dimension}`;
  return (
    <div className="field">
      <label htmlFor={id}>{dimensionLabel(dimension)}</label>
      <select
        id={id}
        value={current ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">All</option>
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
        {error ??
          (values === null
            ? "Loading values…"
            : "Everything, or only one of the largest values.")}
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
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: string;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {children}
    </label>
  );
}

const ALIGN_LABELS = { start: "Left", center: "Centre", end: "Right" } as const;

function AlignField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: keyof typeof ALIGN_LABELS;
  onChange: (value: keyof typeof ALIGN_LABELS) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>Align</label>
      <select
        id={id}
        value={value}
        onChange={(event) =>
          onChange(event.target.value as keyof typeof ALIGN_LABELS)
        }
      >
        {Object.entries(ALIGN_LABELS).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

function StyleFields({
  widget,
  images,
  imagesInUse,
  timeZone,
  dispatch,
  onUploadImage,
  onDeleteImage,
}: WidgetPanelProps) {
  const update = (patch: WidgetPatch) =>
    dispatch({ type: "updateWidget", widgetId: widget.id, patch });
  const options = (patch: object) =>
    dispatch({ type: "updateWidgetOptions", widgetId: widget.id, patch });

  switch (widget.type) {
    case "metric":
      return (
        <fieldset>
          <legend>Style</legend>
          <Check
            checked={widget.options.showChange}
            onChange={(showChange) => options({ showChange })}
          >
            Change against the previous period
          </Check>
          <Check
            checked={widget.options.showSparkline}
            onChange={(showSparkline) => options({ showSparkline })}
          >
            Sparkline
          </Check>
        </fieldset>
      );
    case "line":
      return (
        <fieldset>
          <legend>Style</legend>
          <Check
            checked={widget.options.showPrevious}
            onChange={(showPrevious) => options({ showPrevious })}
          >
            Previous period (dashed)
          </Check>
          <Check
            checked={widget.options.showAxis}
            onChange={(showAxis) => options({ showAxis })}
          >
            Axis labels
          </Check>
        </fieldset>
      );
    case "bar":
      return null;
    case "text":
      return (
        <fieldset>
          <legend>Text</legend>
          <div className="field">
            <label htmlFor="widget-text">Text</label>
            <textarea
              id="widget-text"
              rows={6}
              value={widget.text}
              maxLength={STUDIO_LIMITS.textLength}
              aria-describedby="widget-text-help widget-text-count"
              onChange={(event) => update({ text: event.target.value })}
            />
            <p id="widget-text-help" className="help">
              # and ## start headings, **bold**, *italic*; an empty line starts
              a paragraph. Links and HTML show as typed.
            </p>
            <p
              id="widget-text-count"
              className={
                widget.text.length >= STUDIO_LIMITS.textLength
                  ? "help contrast-warn"
                  : "help"
              }
            >
              {widget.text.length}/{STUDIO_LIMITS.textLength} characters
            </p>
          </div>
          <TextPreview text={widget.text} />
          <div className="field">
            <label htmlFor="widget-size">Size</label>
            <select
              id="widget-size"
              value={widget.options.size}
              onChange={(event) =>
                options({
                  size: event.target.value as typeof widget.options.size,
                })
              }
            >
              <option value="body">Body</option>
              <option value="heading">Heading</option>
              <option value="display">Display</option>
            </select>
            <p className="help">
              Smaller sizes are used when the text does not fit.
            </p>
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
          <legend>Clock</legend>
          <div className="field">
            <label htmlFor="widget-time-zone">Time zone</label>
            <select
              id="widget-time-zone"
              value={widget.options.timeZone ?? ""}
              onChange={(event) =>
                options({ timeZone: event.target.value || null })
              }
            >
              <option value="">Workspace ({workspaceZone})</option>
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
            <label htmlFor="widget-hour-cycle">Hours</label>
            <select
              id="widget-hour-cycle"
              value={widget.options.hour12 ? "12" : "24"}
              onChange={(event) =>
                options({ hour12: event.target.value === "12" })
              }
            >
              <option value="24">24-hour (14:05)</option>
              <option value="12">12-hour (2:05 PM)</option>
            </select>
          </div>
          <Check
            checked={widget.options.showDate}
            onChange={(showDate) => options({ showDate })}
          >
            Date
          </Check>
        </fieldset>
      );
    }
    case "image":
      return (
        <fieldset>
          <legend>Image</legend>
          <ImagePicker
            id="widget-image"
            label="Image"
            images={images}
            value={widget.imageId}
            onChange={(imageId) => {
              if (imageId) update({ imageId });
            }}
            onUpload={onUploadImage}
          />
          <div className="field">
            <label htmlFor="widget-fit">Fit</label>
            <select
              id="widget-fit"
              value={widget.options.fit}
              onChange={(event) =>
                options({
                  fit: event.target.value as typeof widget.options.fit,
                })
              }
            >
              <option value="contain">Whole image (contain)</option>
              <option value="cover">Fill the widget, cropped (cover)</option>
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
  const blocks = parseTextWidget(text);
  return (
    <div className="text-preview" aria-label="Preview">
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
