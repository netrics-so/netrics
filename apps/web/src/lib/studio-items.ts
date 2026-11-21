import type { PublishedModelCatalog } from "@netrics/contracts";
import type { DashboardDataFilter, ItemsWidgetBinding } from "@netrics/domain";

type CatalogModel = PublishedModelCatalog["models"][number];

/** A model's dimensions an items widget can show as its image (#810). */
export function imageDimensions(model: CatalogModel) {
  return model.dimensions.filter(
    (dimension) => dimension.type === "string" && dimension.role === "image",
  );
}

/** A model's dimensions an items widget can order its items by. */
export function timeDimensions(model: CatalogModel) {
  return model.dimensions.filter(
    (dimension) => dimension.type === "date" || dimension.type === "timestamp",
  );
}

/** Published models a latest-items widget can show: with an image and a
 * time dimension. */
export function itemsModels(models: readonly CatalogModel[]): CatalogModel[] {
  return models.filter(
    (model) =>
      imageDimensions(model).length > 0 && timeDimensions(model).length > 0,
  );
}

/**
 * A new binding over `model` (#810): its first image dimension, its first
 * date or time, and as the title its first string that is not the image;
 * null when the model cannot back an items widget. A string a shared filter
 * of the dashboard picks values of is a category (an orientation, a
 * country), no item's title: another string comes first (#835).
 */
export function itemsBindingFor(
  model: CatalogModel,
  filters: readonly Pick<DashboardDataFilter, "mappings">[] = [],
): ItemsWidgetBinding | null {
  const image = imageDimensions(model)[0];
  const time = timeDimensions(model)[0];
  if (!image || !time) return null;
  const filtered = new Set(
    filters.flatMap((filter) =>
      filter.mappings
        .filter((mapping) => mapping.modelId === model.modelId)
        .map((mapping) => mapping.dimensionId),
    ),
  );
  const strings = model.dimensions.filter(
    (dimension) => dimension.type === "string" && dimension.id !== image.id,
  );
  const title =
    strings.find((dimension) => !filtered.has(dimension.id)) ??
    strings[0] ??
    image;
  return {
    modelId: model.modelId,
    imageDimensionId: image.id,
    titleDimensionId: title.id,
    timeDimensionId: time.id,
    exclusions: [],
  };
}
