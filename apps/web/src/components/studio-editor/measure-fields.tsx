"use client";
import { useId, useState } from "react";
import Link from "next/link";
import type {
  DashboardWidget,
  PublishedModelCatalog,
} from "@netrics/contracts";
import {
  allowedTimeGrains,
  formatDataFormula,
  measureBindingGrains,
  measureFixedGrainDimensions,
  measureInteractionDimension,
  measureOptionsForBinding,
  parseDataFormula,
  TIME_GRAINS,
  type DashboardDataFilter,
  type TimeGrain,
} from "@netrics/domain";
import { dataErrorKey } from "@/lib/data-editing";
import { useT } from "@/lib/i18n/client";
import type { StudioAction } from "@/lib/studio-document";
import { FilterExclusions } from "./shared-filters";

type CatalogModel = PublishedModelCatalog["models"][number];
/** Rolling windows and day/week comparisons have one value per date, which
 * no filter reduces to one. An ordinary grain on a date can be fixed by the
 * widget filter, so it does not count. */
function perDateMeasure(model: CatalogModel | undefined, measureId: string) {
  return !!model?.measures.find((measure) => measure.id === measureId)
    ?.perDateDimensions?.length;
}
/** The measure the single-value view keeps: a chosen one with a single
 * value, else the model's first such, else the first chosen. */
/**
 * A measure widget's options when its model changes: the new model's first
 * measure in a table where it needs a grouping, else a value; no order,
 * labels or own period of the old model (#768, #784), as exclusions go.
 */
export function optionsForModel<
  O extends Extract<DashboardWidget, { type: "measure" }>["options"],
>(
  options: O,
  next: { measures: { id: string; requiredDimensions?: string[] }[] },
): O {
  const required = next.measures[0]?.requiredDimensions ?? [];
  const { period: _period, ...rest } = options;
  return {
    ...measureOptionsForBinding(
      {
        measureIds: next.measures.slice(0, 1).map((measure) => measure.id),
        groupBy: required.slice(0, 3),
      },
      rest as O,
    ),
    view: required.length && required.length <= 3 ? "table" : "value",
  };
}

/** A new measure widget's "Maximum rows" (the options schema's default). */
const DEFAULT_MEASURE_LIMIT = 20;
/**
 * A line chart's "Maximum rows" when the view switches to it with the
 * default untouched: a year of days, so a daily series is not cut to its
 * last 20 points without anyone choosing that (#835).
 */
export const LINE_VIEW_LIMIT = 365;
/** The "Maximum rows" a view switch leaves; only an untouched default moves. */
export function limitForView(
  view: Extract<DashboardWidget, { type: "measure" }>["options"]["view"],
  limit: number,
): number {
  if (view === "line" && limit === DEFAULT_MEASURE_LIMIT)
    return LINE_VIEW_LIMIT;
  if (view !== "line" && limit === LINE_VIEW_LIMIT)
    return DEFAULT_MEASURE_LIMIT;
  return limit;
}
type MeasureView = Extract<
  DashboardWidget,
  { type: "measure" }
>["options"]["view"];
/** Tables and value views group by several dimensions; charts by one. */
const groupsBySeveral = (view: MeasureView) =>
  view === "table" || view === "value";
/**
 * The grouping a view switch leaves (#788): what the widget groups by
 * stays wherever the new view can show it. A value keeps it all (its total
 * with a line per group, #784), a table its first three, a chart its
 * first. Only a table or chart without any gets the model's first
 * dimension (a line chart's first date); a plain value stays plain.
 */
export function groupByForView(
  view: MeasureView,
  groupBy: string[],
  model: CatalogModel | undefined,
): string[] {
  if (view === "value") return groupBy;
  if (groupBy.length) return groupBy.slice(0, view === "table" ? 3 : 1);
  return (
    model?.dimensions
      .filter(
        (dimension) =>
          view !== "line" ||
          dimension.type === "date" ||
          dimension.type === "timestamp",
      )
      .slice(0, 1)
      .map((dimension) => dimension.id) ?? []
  );
}
/**
 * A binding with the time grains it can keep (#838): those of dimensions it
 * still groups by, that change their values ("day" on a date is none) and
 * that its measures allow, so adding a rolling measure resets a week or
 * month on its date instead of leaving a widget the server refuses.
 */
export function bindingWithGrains<
  B extends Extract<DashboardWidget, { type: "measure" }>["binding"],
>(binding: B, model: CatalogModel | undefined): B {
  return measureBindingGrains(
    binding,
    model && {
      dimensions: model.dimensions,
      reset: measureFixedGrainDimensions(model.measures, binding.measureIds),
    },
  );
}
export function valueViewMeasureId(
  model: CatalogModel | undefined,
  measureIds: string[],
): string {
  return (
    measureIds.find((measureId) => !perDateMeasure(model, measureId)) ??
    model?.measures.find((measure) => !perDateMeasure(model, measure.id))?.id ??
    measureIds[0]!
  );
}
/**
 * A measure widget switched to another view: the measures and grouping the
 * view can show (`groupByForView`), and the options that still name them.
 */
export function patchForView(
  widget: Pick<
    Extract<DashboardWidget, { type: "measure" }>,
    "binding" | "options"
  >,
  view: MeasureView,
  model: CatalogModel | undefined,
) {
  // A time grain stays with its dimension, like the grouping itself (#838).
  const binding = bindingWithGrains(
    {
      ...widget.binding,
      measureIds:
        view === "table"
          ? widget.binding.measureIds
          : view === "value"
            ? [valueViewMeasureId(model, widget.binding.measureIds)]
            : widget.binding.measureIds.slice(0, 1),
      groupBy: groupByForView(view, widget.binding.groupBy, model),
    },
    model,
  );
  return {
    binding,
    options: measureOptionsForBinding(binding, {
      ...widget.options,
      view,
      limit: limitForView(view, widget.options.limit),
    }),
  };
}
export function MeasureFields({
  widget,
  models,
  filters,
  dispatch,
  workspaceId,
  filterDraft,
  onFilterDraftChange,
}: {
  widget: Extract<DashboardWidget, { type: "measure" }>;
  models: PublishedModelCatalog["models"];
  filters: DashboardDataFilter[];
  dispatch: (action: StudioAction) => void;
  workspaceId: string;
  filterDraft?: string;
  onFilterDraftChange?: (value: string | undefined) => void;
}) {
  const t = useT("data.dashboard"),
    errors = useT("data.errors"),
    id = useId();
  const model = models.find(
    (model) => model.modelId === widget.binding.modelId,
  );
  const required = [
    ...new Set(
      model?.measures
        .filter((measure) => widget.binding.measureIds.includes(measure.id))
        .flatMap((measure) => measure.requiredDimensions ?? []) ?? [],
    ),
  ];
  // Rolling and day/week comparisons have no single value: the value view
  // offers them only once already chosen.
  const perDate = (measure: CatalogModel["measures"][number]) =>
    widget.options.view !== "value" ||
    widget.binding.measureIds.includes(measure.id)
      ? []
      : (model?.dimensions.filter((dimension) =>
          measure.perDateDimensions?.includes(dimension.id),
        ) ?? []);
  const refs =
    model?.dimensions.map((dimension) => ({
      id: dimension.id,
      name: dimension.name,
    })) ?? [];
  const [localFormula, setFormula] = useState(
    widget.binding.filter ? formatDataFormula(widget.binding.filter, refs) : "",
  );
  const publishedFormula = widget.binding.filter
    ? formatDataFormula(widget.binding.filter, refs)
    : "";
  const formula = onFilterDraftChange
    ? (filterDraft ?? publishedFormula)
    : localFormula;
  const unapplied = onFilterDraftChange
    ? filterDraft !== undefined
    : formula !== publishedFormula;
  const [error, setError] = useState<string | null>(null);
  // A binding that loses a measure or dimension drops the table order and
  // column labels it named (#768): a template's top N by a measure, or its
  // short heads, never outlive what the widget shows.
  const update = (patch: Partial<typeof widget.binding>) => {
    const binding = bindingWithGrains({ ...widget.binding, ...patch }, model);
    dispatch({
      type: "updateWidget",
      widgetId: widget.id,
      patch: {
        binding,
        options: measureOptionsForBinding(binding, widget.options),
      },
    });
  };
  return (
    <fieldset className="measure-fields">
      <legend>{t("binding")}</legend>
      <div className="field">
        <label htmlFor={`${id}-model`}>{t("model")}</label>
        <select
          id={`${id}-model`}
          value={widget.binding.modelId}
          onChange={(event) => {
            const next = models.find(
              (model) => model.modelId === event.target.value,
            );
            if (!next) return;
            setFormula("");
            onFilterDraftChange?.(undefined);
            setError(null);
            const required = next.measures[0]?.requiredDimensions ?? [];
            dispatch({
              type: "updateWidget",
              widgetId: widget.id,
              patch: {
                binding: {
                  modelId: next.modelId,
                  measureIds: next.measures
                    .slice(0, 1)
                    .map((measure) => measure.id),
                  groupBy: required.slice(0, 3),
                  exclusions: [],
                },
                options: optionsForModel(widget.options, next),
              },
            });
          }}
        >
          {!model ? (
            <option value={widget.binding.modelId}>{t("missingModel")}</option>
          ) : null}
          {models.map((model) => (
            <option key={model.modelId} value={model.modelId}>
              {model.modelName}
            </option>
          ))}
        </select>
        <p className="help">
          {t("publishedOnly")}{" "}
          <Link href={`/workspaces/${workspaceId}/data`}>
            {t("editModels")}
          </Link>
        </p>
      </div>
      {required.length ? (
        <p className="help">
          {t("requiresScope", {
            dimensions: required
              .map(
                (id) =>
                  model?.dimensions.find((dimension) => dimension.id === id)
                    ?.name ?? id,
              )
              .join(", "),
          })}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={`${id}-view`}>{t("view")}</label>
        <select
          id={`${id}-view`}
          value={widget.options.view}
          onChange={(event) =>
            dispatch({
              type: "updateWidget",
              widgetId: widget.id,
              patch: patchForView(
                widget,
                event.target.value as MeasureView,
                model,
              ),
            })
          }
        >
          {(["value", "table", "bar", "line"] as const).map((view) => (
            <option key={view} value={view}>
              {t(`views.${view}`)}
            </option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend>{t("measures")}</legend>
        {model?.measures.map((measure) => (
          <label key={measure.id} className="check">
            <input
              type={widget.options.view === "table" ? "checkbox" : "radio"}
              name={`${id}-measure`}
              disabled={perDate(measure).length > 0}
              aria-describedby={
                perDate(measure).length
                  ? `${id}-per-date-${measure.id}`
                  : undefined
              }
              checked={widget.binding.measureIds.includes(measure.id)}
              onChange={(event) =>
                update({
                  measureIds:
                    widget.options.view === "table"
                      ? event.target.checked
                        ? model.measures
                            .filter(
                              (item) =>
                                widget.binding.measureIds.includes(item.id) ||
                                item.id === measure.id,
                            )
                            .map((item) => item.id)
                        : widget.binding.measureIds.filter(
                            (id) => id !== measure.id,
                          )
                      : [measure.id],
                })
              }
            />
            {measure.name}
          </label>
        ))}
        {model?.measures.map((measure) =>
          perDate(measure).length ? (
            <p
              key={measure.id}
              className="help"
              id={`${id}-per-date-${measure.id}`}
            >
              {t("perDateMeasure", {
                name: measure.name,
                dimensions: perDate(measure)
                  .map((dimension) => dimension.name)
                  .join(", "),
              })}
            </p>
          ) : null,
        )}
      </fieldset>
      <GroupByField
        view={widget.options.view}
        dimensions={model?.dimensions ?? []}
        groupBy={widget.binding.groupBy}
        grains={widget.binding.groupByGrain ?? {}}
        fixed={measureFixedGrainDimensions(
          model?.measures ?? [],
          widget.binding.measureIds,
        )}
        onChange={(groupBy) => update({ groupBy })}
        onGrainChange={(groupByGrain) => update({ groupByGrain })}
      />
      {/* A plain value has no rows; a split shows up to this many lines. */}
      {widget.options.view !== "value" || widget.binding.groupBy.length ? (
        <div className="field">
          <label htmlFor={`${id}-limit`}>{t("limit")}</label>
          <input
            id={`${id}-limit`}
            type="number"
            min="1"
            max="1000"
            value={widget.options.limit}
            onChange={(event) =>
              dispatch({
                type: "updateWidget",
                widgetId: widget.id,
                patch: {
                  options: {
                    ...widget.options,
                    limit: Number(event.target.value),
                  },
                },
              })
            }
          />
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={`${id}-filter`}>{t("widgetFilter")}</label>
        <textarea
          id={`${id}-filter`}
          value={formula}
          placeholder={t("formulaPlaceholder")}
          onChange={(event) => {
            setFormula(event.target.value);
            onFilterDraftChange?.(
              event.target.value === publishedFormula
                ? undefined
                : event.target.value,
            );
          }}
        />
        <button
          type="button"
          onClick={() => {
            try {
              const filter = formula.trim()
                ? parseDataFormula(formula, refs)
                : undefined;
              update({ filter });
              onFilterDraftChange?.(undefined);
              setError(null);
            } catch (failure) {
              setError(errors(dataErrorKey(failure)));
            }
          }}
        >
          {t("applyFilter")}
        </button>
        {unapplied ? (
          <>
            <p className="help" role="status">
              {t("applyBeforeSave")}
            </p>
            <button
              type="button"
              onClick={() => {
                setFormula(publishedFormula);
                onFilterDraftChange?.(undefined);
                setError(null);
              }}
            >
              {t("discardFilter")}
            </button>
          </>
        ) : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <FilterExclusions
        filters={filters}
        exclusions={widget.binding.exclusions}
        onChange={(exclusions) => update({ exclusions })}
      />
      <InteractionField widget={widget} filters={filters} update={update} />
    </fieldset>
  );
}

/**
 * What the widget groups by. Every view has it (#788): a value view with a
 * grouping is its total with a line per group (#784), and without one a
 * single value. Its choices are the model's dimensions as the view can
 * show them. A chosen date or timestamp dimension has its time grain next
 * to it (#838): each value, or one group per day, week or month.
 */
function GroupByField({
  view,
  dimensions,
  groupBy,
  grains,
  fixed,
  onChange,
  onGrainChange,
}: {
  view: MeasureView;
  dimensions: CatalogModel["dimensions"];
  groupBy: string[];
  grains: Record<string, TimeGrain>;
  /** The dimensions the chosen measures are read per value of. */
  fixed: ReadonlySet<string>;
  onChange: (groupBy: string[]) => void;
  onGrainChange: (grains: Record<string, TimeGrain>) => void;
}) {
  const t = useT("data.dashboard"),
    id = useId();
  const several = groupsBySeveral(view);
  const offered = dimensions.filter(
    (dimension) =>
      view !== "line" ||
      dimension.type === "date" ||
      dimension.type === "timestamp",
  );
  return (
    <fieldset aria-describedby={view === "value" ? `${id}-help` : undefined}>
      <legend>{t(view === "value" ? "splitBy" : "groupBy")}</legend>
      {offered.map((dimension) => {
        const temporal =
          dimension.type === "date" || dimension.type === "timestamp";
        const shown = temporal && groupBy.includes(dimension.id);
        // Only what the query accepts with the chosen measures (#838).
        const allowed = allowedTimeGrains(dimension, fixed);
        const limited = shown && allowed.length < TIME_GRAINS.length;
        return (
          <div key={dimension.id} className="group-by-choice">
            <label className="check">
              <input
                type={several ? "checkbox" : "radio"}
                name={`${id}-group`}
                checked={groupBy.includes(dimension.id)}
                onChange={(event) =>
                  onChange(
                    several
                      ? event.target.checked
                        ? [...groupBy, dimension.id]
                        : groupBy.filter((id) => id !== dimension.id)
                      : [dimension.id],
                  )
                }
              />
              {dimension.name}
            </label>
            {shown ? (
              <select
                aria-label={t("grain.label", { name: dimension.name })}
                aria-describedby={
                  limited ? `${id}-grain-${dimension.id}` : undefined
                }
                // A date is its own day: "day" and no grain are one choice.
                value={
                  dimension.type === "date" && grains[dimension.id] === "day"
                    ? ""
                    : (grains[dimension.id] ?? "")
                }
                onChange={(event) => {
                  const { [dimension.id]: _previous, ...rest } = grains;
                  onGrainChange(
                    event.target.value
                      ? {
                          ...rest,
                          [dimension.id]: event.target.value as TimeGrain,
                        }
                      : rest,
                  );
                }}
              >
                <option value="">
                  {t(dimension.type === "date" ? "grain.day" : "grain.none")}
                </option>
                {TIME_GRAINS.filter(
                  (grain) => dimension.type !== "date" || grain !== "day",
                ).map((grain) => (
                  <option
                    key={grain}
                    value={grain}
                    disabled={!allowed.includes(grain)}
                  >
                    {t(`grain.${grain}`)}
                  </option>
                ))}
              </select>
            ) : null}
            {limited ? (
              <p className="help" id={`${id}-grain-${dimension.id}`}>
                {t("grain.fixed", { name: dimension.name })}
              </p>
            ) : null}
          </div>
        );
      })}
      {view === "value" ? (
        <p className="help" id={`${id}-help`}>
          {t("splitByHelp")}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Declares which shared filter a click on a category, point or row value
 * sets. Lists only filters that apply; an invalid saved choice stays visible
 * (and is a dashboard problem) until the editor changes it. */
function InteractionField({
  widget,
  filters,
  update,
}: {
  widget: Extract<DashboardWidget, { type: "measure" }>;
  filters: DashboardDataFilter[];
  update: (
    patch: Partial<Extract<DashboardWidget, { type: "measure" }>["binding"]>,
  ) => void;
}) {
  const t = useT("data.dashboard"),
    id = useId();
  const current = widget.binding.interaction?.filterId;
  const applicable = filters.filter((filter) => {
    try {
      measureInteractionDimension(
        filters,
        { ...widget.binding, interaction: { filterId: filter.id } },
        widget.options.view,
      );
      return true;
    } catch {
      return false;
    }
  });
  if (widget.options.view === "value" && current === undefined) return null;
  const invalid =
    current !== undefined &&
    !applicable.some((filter) => filter.id === current);
  return (
    <div className="field">
      <label htmlFor={`${id}-interaction`}>{t("interaction")}</label>
      <select
        id={`${id}-interaction`}
        value={current ?? ""}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-interaction-help`}
        onChange={(event) =>
          update({
            interaction: event.target.value
              ? { filterId: event.target.value }
              : undefined,
          })
        }
      >
        <option value="">{t("interactionNone")}</option>
        {invalid ? (
          <option value={current}>
            {filters.find((filter) => filter.id === current)?.name ?? current}
          </option>
        ) : null}
        {applicable.map((filter) => (
          <option key={filter.id} value={filter.id}>
            {filter.name}
          </option>
        ))}
      </select>
      <p className="help" id={`${id}-interaction-help`}>
        {applicable.length || current !== undefined
          ? t("interactionHelp")
          : t("interactionUnavailable")}
      </p>
      {invalid ? (
        <p className="error" role="alert">
          {t("interactionProblem", {
            name: widget.title ?? t("binding"),
            filter:
              filters.find((filter) => filter.id === current)?.name ?? current,
          })}
        </p>
      ) : null}
    </div>
  );
}
