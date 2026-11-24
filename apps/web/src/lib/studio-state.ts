import type { PublishedModelCatalog } from "@netrics/contracts";
import type { DashboardDataFilter, StateWidgetBinding } from "@netrics/domain";

type CatalogModel = PublishedModelCatalog["models"][number];
type CatalogDimension = CatalogModel["dimensions"][number];

const STATE_NAME = /(^|_|\b)(state|status|health|healthy|up)($|_|\b)/i;
const CHANGED_NAME = /(changed|updated|ready|since)/i;
const ROLLED_BACK_NAME = /rolled[\s_-]?back|rollback/i;

const matches = (dimension: CatalogDimension, pattern: RegExp) =>
  pattern.test(dimension.id) || pattern.test(dimension.name);

/** A model's dimensions a state widget can name its items by (#875). */
export function stateNameDimensions(model: CatalogModel) {
  return model.dimensions.filter((dimension) => dimension.type === "string");
}

/** A model's dimensions a state widget can read the state from: text, or
 * a yes/no health flag. */
export function stateValueDimensions(model: CatalogModel) {
  return model.dimensions.filter(
    (dimension) => dimension.type === "string" || dimension.type === "boolean",
  );
}

/** A model's dimensions for the time a state last changed. */
export function stateChangedDimensions(model: CatalogModel) {
  return model.dimensions.filter(
    (dimension) => dimension.type === "date" || dimension.type === "timestamp",
  );
}

/** A model's yes/no dimensions, for "rolled back". */
export function stateFlagDimensions(model: CatalogModel) {
  return model.dimensions.filter((dimension) => dimension.type === "boolean");
}

/**
 * A new binding over `model` (#875): the state is the first dimension
 * named like a state ("state", "status", "health"), else the first yes/no
 * field; the name the first other text field no shared filter picks values
 * of (a project is a category, not an item's name); a changed-at and a
 * rolled-back flag only when a field is named like one. Null when the
 * model cannot back a state widget.
 */
export function stateBindingFor(
  model: CatalogModel,
  filters: readonly Pick<DashboardDataFilter, "mappings">[] = [],
): StateWidgetBinding | null {
  const values = stateValueDimensions(model);
  const filtered = new Set(
    filters.flatMap((filter) =>
      filter.mappings
        .filter((mapping) => mapping.modelId === model.modelId)
        .map((mapping) => mapping.dimensionId),
    ),
  );
  // Names rank the defaults, they never exclude a model (review): a field
  // named like a state, else a yes/no field, else a text field the name
  // does not take.
  const named =
    values.find((dimension) => matches(dimension, STATE_NAME)) ??
    stateFlagDimensions(model)[0];
  const pickName = (except: string | undefined) => {
    const names = stateNameDimensions(model).filter(
      (dimension) => dimension.id !== except,
    );
    const plain = names.filter((dimension) => !matches(dimension, STATE_NAME));
    return (
      plain.find(
        (dimension) =>
          !filtered.has(dimension.id) && !/_id$/.test(dimension.id),
      ) ??
      plain.find((dimension) => !filtered.has(dimension.id)) ??
      plain[0] ??
      names[0]
    );
  };
  const name = pickName(named?.id);
  if (!name) return null;
  const state =
    named ??
    [...values].reverse().find((dimension) => dimension.id !== name.id);
  if (!state || state.id === name.id) return null;
  const changed = stateChangedDimensions(model).find((dimension) =>
    matches(dimension, CHANGED_NAME),
  );
  const rolledBack = stateFlagDimensions(model).find(
    (dimension) =>
      dimension.id !== state.id && matches(dimension, ROLLED_BACK_NAME),
  );
  return {
    modelId: model.modelId,
    nameDimensionId: name.id,
    stateDimensionId: state.id,
    ...(changed ? { changedAtDimensionId: changed.id } : {}),
    ...(rolledBack ? { rolledBackDimensionId: rolledBack.id } : {}),
    exclusions: [],
  };
}

/**
 * The fields each role of a binding may take, none taken by another role
 * (review): the name's choices without the state, the state's without the
 * name, the rolled-back flag's without the state.
 */
export function stateFieldChoices(
  model: CatalogModel,
  binding: Pick<StateWidgetBinding, "nameDimensionId" | "stateDimensionId">,
) {
  return {
    names: stateNameDimensions(model).filter(
      (dimension) => dimension.id !== binding.stateDimensionId,
    ),
    states: stateValueDimensions(model).filter(
      (dimension) => dimension.id !== binding.nameDimensionId,
    ),
    changed: stateChangedDimensions(model),
    flags: stateFlagDimensions(model).filter(
      (dimension) => dimension.id !== binding.stateDimensionId,
    ),
  };
}

/** Published models a state widget can show. */
export function stateModels(models: readonly CatalogModel[]): CatalogModel[] {
  return models.filter((model) => stateBindingFor(model) !== null);
}
