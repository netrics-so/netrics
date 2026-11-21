import type { PublishedModelCatalog } from "@netrics/contracts";
import type { ItemsWidgetBinding } from "@netrics/domain";

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
 * null when the model cannot back an items widget.
 */
export function itemsBindingFor(
  model: CatalogModel,
): ItemsWidgetBinding | null {
  const image = imageDimensions(model)[0];
  const time = timeDimensions(model)[0];
  if (!image || !time) return null;
  const title =
    model.dimensions.find(
      (dimension) => dimension.type === "string" && dimension.id !== image.id,
    ) ?? image;
  return {
    modelId: model.modelId,
    imageDimensionId: image.id,
    titleDimensionId: title.id,
    timeDimensionId: time.id,
    exclusions: [],
  };
}
