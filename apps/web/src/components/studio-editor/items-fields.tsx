"use client";
import { useId } from "react";
import Link from "next/link";
import type {
  DashboardWidget,
  PublishedModelCatalog,
} from "@netrics/contracts";
import { CUSTOM_API_IMAGE_NEWEST_MAX } from "@netrics/contracts";
import type { DashboardDataFilter } from "@netrics/domain";

import { useT } from "@/lib/i18n/client";
import type { StudioAction } from "@/lib/studio-document";
import {
  imageDimensions,
  itemsBindingFor,
  itemsModels,
  timeDimensions,
} from "@/lib/studio-items";

import { FilterExclusions } from "./shared-filters";

type ItemsWidget = Extract<DashboardWidget, { type: "items" }>;

/**
 * The inspector of a latest-items widget (#810): its model (only those with
 * an image and a time), which dimensions give each item's image, title,
 * subtitle and time, how the items show, and the shared filters it ignores.
 */
export function ItemsFields({
  widget,
  models,
  filters,
  dispatch,
  workspaceId,
}: {
  widget: ItemsWidget;
  models: PublishedModelCatalog["models"];
  filters: DashboardDataFilter[];
  dispatch: (action: StudioAction) => void;
  workspaceId: string;
}) {
  const t = useT("studio.items"),
    data = useT("data.dashboard"),
    id = useId();
  const candidates = itemsModels(models);
  const model = models.find(
    (model) => model.modelId === widget.binding.modelId,
  );
  const update = (patch: Partial<ItemsWidget["binding"]>) =>
    dispatch({
      type: "updateWidget",
      widgetId: widget.id,
      patch: { binding: { ...widget.binding, ...patch } },
    });
  const options = (patch: Partial<ItemsWidget["options"]>) =>
    dispatch({
      type: "updateWidgetOptions",
      widgetId: widget.id,
      patch,
    });
  const strings =
    model?.dimensions.filter((dimension) => dimension.type !== "json") ?? [];
  const dimensionSelect = (
    key: "image" | "title" | "subtitle" | "time",
    value: string | undefined,
    choices: ReadonlyArray<{ id: string; name: string }>,
    onChange: (value: string | undefined) => void,
  ) => (
    <div className="field">
      <label htmlFor={`${id}-${key}`}>{t(key)}</label>
      <select
        id={`${id}-${key}`}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        {key === "subtitle" ? <option value="">{t("none")}</option> : null}
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
  return (
    <fieldset className="items-fields">
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
            const binding = next ? itemsBindingFor(next) : null;
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
        "image",
        widget.binding.imageDimensionId,
        model ? imageDimensions(model) : [],
        (value) => value && update({ imageDimensionId: value }),
      )}
      {dimensionSelect(
        "title",
        widget.binding.titleDimensionId,
        strings,
        (value) => value && update({ titleDimensionId: value }),
      )}
      {dimensionSelect(
        "subtitle",
        widget.binding.subtitleDimensionId,
        strings,
        (value) => {
          const { subtitleDimensionId: _subtitle, ...rest } = widget.binding;
          dispatch({
            type: "updateWidget",
            widgetId: widget.id,
            patch: {
              binding: value ? { ...rest, subtitleDimensionId: value } : rest,
            },
          });
        },
      )}
      {dimensionSelect(
        "time",
        widget.binding.timeDimensionId,
        model ? timeDimensions(model) : [],
        (value) => value && update({ timeDimensionId: value }),
      )}
      <div className="field">
        <label htmlFor={`${id}-layout`}>{t("layout")}</label>
        <select
          id={`${id}-layout`}
          value={widget.options.layout}
          onChange={(event) =>
            options({
              layout: event.target.value as ItemsWidget["options"]["layout"],
            })
          }
        >
          <option value="grid">{t("grid")}</option>
          <option value="rotate">{t("rotate")}</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-count`}>{t("count")}</label>
        <input
          id={`${id}-count`}
          type="number"
          min="1"
          max={CUSTOM_API_IMAGE_NEWEST_MAX}
          value={widget.options.count}
          onChange={(event) => {
            const count = Math.round(Number(event.target.value));
            if (count >= 1 && count <= CUSTOM_API_IMAGE_NEWEST_MAX)
              options({ count });
          }}
        />
      </div>
      {widget.options.layout === "rotate" ? (
        <div className="field">
          <label htmlFor={`${id}-seconds`}>{t("rotateSeconds")}</label>
          <input
            id={`${id}-seconds`}
            type="number"
            min="3"
            max="60"
            value={widget.options.rotateSeconds}
            onChange={(event) => {
              const rotateSeconds = Math.round(Number(event.target.value));
              if (rotateSeconds >= 3 && rotateSeconds <= 60)
                options({ rotateSeconds });
            }}
          />
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={`${id}-fit`}>{t("imageFit")}</label>
        <select
          id={`${id}-fit`}
          value={widget.options.imageFit}
          onChange={(event) =>
            options({
              imageFit: event.target
                .value as ItemsWidget["options"]["imageFit"],
            })
          }
        >
          <option value="cover">{t("cover")}</option>
          <option value="contain">{t("contain")}</option>
        </select>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={widget.options.showTime}
          onChange={(event) => options({ showTime: event.target.checked })}
        />
        {t("showTime")}
      </label>
      <FilterExclusions
        filters={filters}
        exclusions={widget.binding.exclusions}
        onChange={(exclusions) => update({ exclusions })}
      />
    </fieldset>
  );
}
