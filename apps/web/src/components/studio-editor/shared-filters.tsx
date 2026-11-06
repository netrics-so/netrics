"use client";
import { useId } from "react";
import type { PublishedModelCatalog } from "@netrics/contracts";
import type {
  DashboardDataFilter,
  DashboardFilterExclusion,
  DashboardFilterValue,
} from "@netrics/domain";
import { newDataId } from "@/lib/data-editing";
import { useT } from "@/lib/i18n/client";
import { DashboardFilterInput } from "@/components/studio/shared-filters";
export function FilterExclusions({
  filters,
  exclusions,
  onChange,
}: {
  filters: DashboardDataFilter[];
  exclusions: DashboardFilterExclusion[];
  onChange: (value: DashboardFilterExclusion[]) => void;
}) {
  const t = useT("data.dashboard");
  return filters.length ? (
    <fieldset>
      <legend>{t("applicability")}</legend>
      <p className="help">{t("applicabilityHint")}</p>
      {filters.map((filter) => {
        const excluded = exclusions.find(
          (exclusion) => exclusion.filterId === filter.id,
        );
        return (
          <div className="field" key={filter.id}>
            <label className="check">
              <input
                type="checkbox"
                checked={!excluded}
                disabled={
                  filter.fixedValue !== undefined && filter.fixedValue !== null
                }
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? exclusions.filter(
                          (exclusion) => exclusion.filterId !== filter.id,
                        )
                      : [
                          ...exclusions,
                          {
                            filterId: filter.id,
                            reason: t("independentTotal"),
                          },
                        ],
                  )
                }
              />
              {filter.name}
            </label>
            {excluded ? (
              <input
                aria-label={t("exclusionReason", { name: filter.name })}
                value={excluded.reason}
                maxLength={200}
                onChange={(event) =>
                  onChange(
                    exclusions.map((exclusion) =>
                      exclusion.filterId === filter.id
                        ? { ...exclusion, reason: event.target.value }
                        : exclusion,
                    ),
                  )
                }
              />
            ) : null}
          </div>
        );
      })}
    </fieldset>
  ) : null;
}
export function SharedFilterEditor({
  workspaceId,
  filters,
  models,
  onChange,
}: {
  workspaceId?: string;
  filters: DashboardDataFilter[];
  models: PublishedModelCatalog["models"];
  onChange: (value: DashboardDataFilter[]) => void;
}) {
  const t = useT("data.dashboard"),
    id = useId();
  function update(key: string, patch: Partial<DashboardDataFilter>) {
    onChange(
      filters.map((filter) =>
        filter.id === key ? { ...filter, ...patch } : filter,
      ),
    );
  }
  function add() {
    const model = models.find((model) => model.dimensions.length),
      dimension = model?.dimensions[0];
    if (!model || !dimension || dimension.type === "json") return;
    const type = dimension.type;
    onChange([
      ...filters,
      {
        id: newDataId(),
        name: dimension.name,
        type,
        mode: type === "date" || type === "timestamp" ? "range" : "values",
        mappings: [{ modelId: model.modelId, dimensionId: dimension.id }],
        defaultValue: null,
      },
    ]);
  }
  return (
    <section className="inspector-section">
      <h2>{t("sharedFilters")}</h2>
      <p className="help">{t("sharedFiltersHint")}</p>
      {filters.map((filter, index) => (
        <fieldset key={filter.id}>
          <legend>
            {filter.name || t("filterNumber", { number: index + 1 })}
          </legend>
          <div className="field">
            <label htmlFor={`${id}-${filter.id}-name`}>{t("name")}</label>
            <input
              id={`${id}-${filter.id}-name`}
              value={filter.name}
              maxLength={100}
              onChange={(event) =>
                update(filter.id, { name: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-${filter.id}-type`}>{t("type")}</label>
            <select
              id={`${id}-${filter.id}-type`}
              value={filter.type}
              onChange={(event) => {
                const type = event.target.value as DashboardDataFilter["type"];
                update(filter.id, {
                  type,
                  mode:
                    type === "date" || type === "timestamp"
                      ? "range"
                      : "values",
                  mappings: [],
                  defaultValue: null,
                  fixedValue: null,
                });
              }}
            >
              {(
                [
                  "string",
                  "boolean",
                  "date",
                  "timestamp",
                  "integer",
                  "decimal",
                  "number",
                ] as const
              ).map((type) => (
                <option key={type} value={type}>
                  {t(`types.${type}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-${filter.id}-mode`}>{t("control")}</label>
            <select
              id={`${id}-${filter.id}-mode`}
              value={filter.mode}
              onChange={(event) =>
                update(filter.id, {
                  mode: event.target.value as DashboardDataFilter["mode"],
                  defaultValue: null,
                  fixedValue: null,
                })
              }
            >
              <option value="values">{t("values")}</option>
              {filter.type !== "boolean" ? (
                <option value="range">{t("range")}</option>
              ) : null}
            </select>
          </div>
          <fieldset>
            <legend>{t("mapModels")}</legend>
            {models.map((model) => (
              <div className="field" key={model.modelId}>
                <label htmlFor={`${id}-${filter.id}-${model.modelId}`}>
                  {model.modelName}
                </label>
                <select
                  id={`${id}-${filter.id}-${model.modelId}`}
                  value={
                    filter.mappings.find(
                      (mapping) => mapping.modelId === model.modelId,
                    )?.dimensionId ?? ""
                  }
                  onChange={(event) =>
                    update(filter.id, {
                      mappings: [
                        ...filter.mappings.filter(
                          (mapping) => mapping.modelId !== model.modelId,
                        ),
                        ...(event.target.value
                          ? [
                              {
                                modelId: model.modelId,
                                dimensionId: event.target.value,
                              },
                            ]
                          : []),
                      ],
                    })
                  }
                >
                  <option value="">{t("notMapped")}</option>
                  {model.dimensions
                    .filter((dimension) => dimension.type === filter.type)
                    .map((dimension) => (
                      <option key={dimension.id} value={dimension.id}>
                        {dimension.name}
                      </option>
                    ))}
                </select>
              </div>
            ))}
          </fieldset>
          <fieldset>
            <legend>{t("defaultValue")}</legend>
            <DashboardFilterInput
              workspaceId={workspaceId}
              filter={filter}
              value={filter.defaultValue}
              onChange={(defaultValue: DashboardFilterValue) =>
                update(filter.id, { defaultValue })
              }
            />
          </fieldset>
          <fieldset>
            <legend>{t("fixedScope")}</legend>
            <p className="help">{t("fixedScopeHint")}</p>
            <DashboardFilterInput
              workspaceId={workspaceId}
              filter={filter}
              value={filter.fixedValue ?? null}
              onChange={(fixedValue: DashboardFilterValue) =>
                update(filter.id, { fixedValue })
              }
            />
          </fieldset>
          <button
            type="button"
            className="danger"
            onClick={() =>
              onChange(filters.filter((item) => item.id !== filter.id))
            }
          >
            {t("removeFilter")}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={!models.some((model) => model.dimensions.length)}
        onClick={add}
      >
        {t("addFilter")}
      </button>
    </section>
  );
}
