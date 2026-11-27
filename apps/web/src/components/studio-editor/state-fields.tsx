"use client";
import { useEffect, useId, useState } from "react";
import Link from "next/link";
import type {
  DashboardWidget,
  PublishedModelCatalog,
} from "@netrics/contracts";
import { STATE_LIST_MAX } from "@netrics/contracts";
import {
  SERVICE_STATES,
  SERVICE_STATE_OVERRIDES_MAX,
  isKnownServiceStateValue,
  serviceStateKey,
  type DashboardDataFilter,
  type ServiceState,
} from "@netrics/domain";

import { useDashboardData } from "@/components/studio/dashboard-data-provider";
import { useT } from "@/lib/i18n/client";
import type { StudioAction } from "@/lib/studio-document";
import {
  stateBindingFor,
  stateFieldChoices,
  stateItemNames,
  stateModels,
  withStateField,
} from "@/lib/studio-state";

import { FilterExclusions } from "./shared-filters";

type StateWidget = Extract<DashboardWidget, { type: "state" }>;

/**
 * The single form's item as typed, committed on blur or Enter exactly as
 * written (#900: an item's name may begin or end with a space, and the
 * server matches it whole); empty or only spaces is none (the summary).
 */
export function commitStateItem(draft: string): string | null {
  return draft.trim() === "" ? null : draft.slice(0, 200);
}

/**
 * The source values a state widget's mapping lists (#875): those it already
 * maps, then each value of the live preview that no built-in word knows,
 * once per `serviceStateKey`, at most `SERVICE_STATE_OVERRIDES_MAX`.
 */
export function stateMappingValues(
  mapped: Readonly<Record<string, ServiceState>>,
  previewValues: readonly (string | null)[],
): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const value of [...Object.keys(mapped), ...previewValues]) {
    if (value === null || value.trim() === "") continue;
    const key = serviceStateKey(value);
    if (seen.has(key)) continue;
    if (!Object.hasOwn(mapped, value) && isKnownServiceStateValue(value))
      continue;
    seen.add(key);
    values.push(value);
  }
  return values.slice(0, SERVICE_STATE_OVERRIDES_MAX);
}

/**
 * The inspector of a state widget (#875): its model, which dimensions give
 * each item's name, state, change time and rollback flag, the list or one
 * item, how source values map to states, and the shared filters it
 * ignores.
 */
export function StateFields({
  widget,
  models,
  filters,
  dispatch,
  workspaceId,
}: {
  widget: StateWidget;
  models: PublishedModelCatalog["models"];
  filters: DashboardDataFilter[];
  dispatch: (action: StudioAction) => void;
  workspaceId: string;
}) {
  const t = useT("studio.state"),
    words = useT("screen.state"),
    data = useT("data.dashboard"),
    id = useId();
  const preview = useDashboardData()?.states?.get(widget.id);
  const [itemDraft, setItemDraft] = useState(widget.options.item ?? "");
  // A change from elsewhere (undo, another widget) replaces the draft.
  useEffect(
    () => setItemDraft(widget.options.item ?? ""),
    [widget.options.item],
  );
  const candidates = stateModels(models);
  const model = models.find(
    (model) => model.modelId === widget.binding.modelId,
  );
  const update = (patch: Partial<StateWidget["binding"]>) =>
    dispatch({
      type: "updateWidget",
      widgetId: widget.id,
      patch: { binding: { ...widget.binding, ...patch } },
    });
  /** Sets or clears an optional dimension. */
  const optional = (
    key: "changedAtDimensionId" | "rolledBackDimensionId",
    value: string | undefined,
  ) => {
    const { [key]: _old, ...rest } = widget.binding;
    dispatch({
      type: "updateWidget",
      widgetId: widget.id,
      patch: { binding: value ? { ...rest, [key]: value } : rest },
    });
  };
  const options = (patch: Partial<StateWidget["options"]>) =>
    dispatch({
      type: "updateWidgetOptions",
      widgetId: widget.id,
      patch,
    });
  const dimensionSelect = (
    key: "name" | "state" | "changed" | "rolledBack",
    value: string | undefined,
    choices: ReadonlyArray<{ id: string; name: string }>,
    onChange: (value: string | undefined) => void,
    noneAllowed = false,
  ) => (
    <div className="field">
      <label htmlFor={`${id}-${key}`}>{t(key)}</label>
      <select
        id={`${id}-${key}`}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        {noneAllowed ? <option value="">{t("none")}</option> : null}
        {value !== undefined && !choices.some((c) => c.id === value) ? (
          <option value={value}>{value}</option>
        ) : null}
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.name}
          </option>
        ))}
      </select>
    </div>
  );
  // The source values no built-in word knows, over every matching item,
  // not only the rows shown (review).
  const mapping = stateMappingValues(
    widget.options.states,
    preview?.sourceValues ?? [],
  );
  const choices = model
    ? stateFieldChoices(model, widget.binding)
    : { names: [], states: [], changed: [], flags: [] };
  const commitItem = () => {
    const item = commitStateItem(itemDraft);
    if (item !== widget.options.item) options({ item });
  };
  const names = stateItemNames(preview?.items ?? []);
  /** Sets name or state; the other role's field swaps them at once. */
  const setRole = (
    role: "nameDimensionId" | "stateDimensionId",
    value: string | undefined,
  ) => {
    if (!value) return;
    dispatch({
      type: "updateWidget",
      widgetId: widget.id,
      patch: {
        binding: withStateField(widget.binding, role, value, model),
      },
    });
  };
  return (
    <fieldset className="state-fields">
      <legend>{t("legend")}</legend>
      <p className="help">{t("help")}</p>
      <div className="field">
        <label htmlFor={`${id}-model`}>{t("model")}</label>
        <select
          id={`${id}-model`}
          value={widget.binding.modelId}
          onChange={(event) => {
            const next = candidates.find(
              (model) => model.modelId === event.target.value,
            );
            const binding = next ? stateBindingFor(next, filters) : null;
            if (binding)
              dispatch({
                type: "updateWidget",
                widgetId: widget.id,
                patch: { binding },
              });
          }}
        >
          {!model ? (
            <option value={widget.binding.modelId}>
              {data("missingModel")}
            </option>
          ) : null}
          {candidates.map((model) => (
            <option key={model.modelId} value={model.modelId}>
              {model.modelName}
            </option>
          ))}
        </select>
        <p className="help">
          {data("publishedOnly")}{" "}
          <Link href={`/workspaces/${workspaceId}/data`}>
            {data("editModels")}
          </Link>
        </p>
      </div>
      {dimensionSelect(
        "name",
        widget.binding.nameDimensionId,
        choices.names,
        (value) => setRole("nameDimensionId", value),
      )}
      {dimensionSelect(
        "state",
        widget.binding.stateDimensionId,
        choices.states,
        (value) => setRole("stateDimensionId", value),
      )}
      {dimensionSelect(
        "changed",
        widget.binding.changedAtDimensionId,
        choices.changed,
        (value) => optional("changedAtDimensionId", value),
        true,
      )}
      {dimensionSelect(
        "rolledBack",
        widget.binding.rolledBackDimensionId,
        choices.flags,
        (value) => optional("rolledBackDimensionId", value),
        true,
      )}
      <div className="field">
        <label htmlFor={`${id}-layout`}>{t("layout")}</label>
        <select
          id={`${id}-layout`}
          value={widget.options.layout}
          onChange={(event) =>
            options({
              layout: event.target.value as StateWidget["options"]["layout"],
            })
          }
        >
          <option value="list">{t("list")}</option>
          <option value="single">{t("single")}</option>
        </select>
      </div>
      {widget.options.layout === "single" ? (
        <div className="field">
          <label htmlFor={`${id}-item`}>{t("item")}</label>
          <input
            id={`${id}-item`}
            type="text"
            list={`${id}-items`}
            maxLength={200}
            placeholder={t("itemWorst")}
            value={itemDraft}
            onChange={(event) => setItemDraft(event.target.value)}
            onBlur={() => commitItem()}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitItem();
            }}
          />
          <datalist id={`${id}-items`}>
            {names.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      ) : (
        <div className="field">
          <label htmlFor={`${id}-limit`}>{t("limit")}</label>
          <input
            id={`${id}-limit`}
            type="number"
            min="1"
            max={STATE_LIST_MAX}
            value={widget.options.limit}
            onChange={(event) => {
              const limit = Math.round(Number(event.target.value));
              if (limit >= 1 && limit <= STATE_LIST_MAX) options({ limit });
            }}
          />
        </div>
      )}
      {widget.binding.changedAtDimensionId ? (
        <label className="check">
          <input
            type="checkbox"
            checked={widget.options.showChanged}
            onChange={(event) => options({ showChanged: event.target.checked })}
          />
          {t("showChanged")}
        </label>
      ) : null}
      {mapping.length ? (
        <fieldset className="state-mapping">
          <legend>{t("mapping")}</legend>
          <p className="help">{t("mappingHelp")}</p>
          {mapping.map((value, index) => (
            <div className="field" key={value}>
              <label htmlFor={`${id}-map-${index}`}>{value}</label>
              <select
                id={`${id}-map-${index}`}
                value={widget.options.states[value] ?? ""}
                onChange={(event) => {
                  const { [value]: _old, ...rest } = widget.options.states;
                  const state = event.target.value as ServiceState | "";
                  options({
                    states: state ? { ...rest, [value]: state } : rest,
                  });
                }}
              >
                <option value="">{words("unknown")}</option>
                {SERVICE_STATES.filter((state) => state !== "unknown").map(
                  (state) => (
                    <option key={state} value={state}>
                      {words(state)}
                    </option>
                  ),
                )}
              </select>
            </div>
          ))}
        </fieldset>
      ) : null}
      <FilterExclusions
        filters={filters}
        exclusions={widget.binding.exclusions}
        onChange={(exclusions) => update({ exclusions })}
      />
    </fieldset>
  );
}
