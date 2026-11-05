"use client";
import { useId, useState } from "react";
import Link from "next/link";
import type {
  DashboardWidget,
  PublishedModelCatalog,
} from "@netrics/contracts";
import {
  formatDataFormula,
  parseDataFormula,
  type DashboardDataFilter,
} from "@netrics/domain";
import { dataErrorKey } from "@/lib/data-editing";
import { useT } from "@/lib/i18n/client";
import type { StudioAction } from "@/lib/studio-document";
import { FilterExclusions } from "./shared-filters";
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
  const update = (patch: Partial<typeof widget.binding>) =>
    dispatch({
      type: "updateWidget",
      widgetId: widget.id,
      patch: { binding: { ...widget.binding, ...patch } },
    });
  function changeView(view: typeof widget.options.view) {
    dispatch({
      type: "updateWidget",
      widgetId: widget.id,
      patch: {
        options: { ...widget.options, view },
        binding: {
          ...widget.binding,
          measureIds:
            view === "table"
              ? widget.binding.measureIds
              : widget.binding.measureIds.slice(0, 1),
          groupBy:
            view === "value"
              ? []
              : widget.binding.groupBy.length
                ? widget.binding.groupBy.slice(0, view === "table" ? 3 : 1)
                : (model?.dimensions
                    .filter(
                      (dimension) =>
                        view !== "line" ||
                        dimension.type === "date" ||
                        dimension.type === "timestamp",
                    )
                    .slice(0, 1)
                    .map((dimension) => dimension.id) ?? []),
        },
      },
    });
  }
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
            dispatch({
              type: "updateWidget",
              widgetId: widget.id,
              patch: {
                binding: {
                  modelId: next.modelId,
                  measureIds: next.measures
                    .slice(0, 1)
                    .map((measure) => measure.id),
                  groupBy: [],
                  exclusions: [],
                },
                options: { ...widget.options, view: "value" },
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
      <div className="field">
        <label htmlFor={`${id}-view`}>{t("view")}</label>
        <select
          id={`${id}-view`}
          value={widget.options.view}
          onChange={(event) =>
            changeView(event.target.value as typeof widget.options.view)
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
      </fieldset>
      {widget.options.view !== "value" ? (
        <fieldset>
          <legend>{t("groupBy")}</legend>
          {model?.dimensions
            .filter(
              (dimension) =>
                widget.options.view !== "line" ||
                dimension.type === "date" ||
                dimension.type === "timestamp",
            )
            .map((dimension) => (
              <label key={dimension.id} className="check">
                <input
                  type={widget.options.view === "table" ? "checkbox" : "radio"}
                  name={`${id}-group`}
                  checked={widget.binding.groupBy.includes(dimension.id)}
                  onChange={(event) =>
                    update({
                      groupBy:
                        widget.options.view === "table"
                          ? event.target.checked
                            ? [...widget.binding.groupBy, dimension.id]
                            : widget.binding.groupBy.filter(
                                (id) => id !== dimension.id,
                              )
                          : [dimension.id],
                    })
                  }
                />
                {dimension.name}
              </label>
            ))}
        </fieldset>
      ) : null}
      {widget.options.view !== "value" ? (
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
    </fieldset>
  );
}
