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
 * field, else the last text field, the first of them that leaves a text
 * field for the name (#900); the name the first other text field no
 * shared filter picks values of (a project is a category, not an item's
 * name); a changed-at and a rolled-back flag only when a field is named
 * like one. Null when the model cannot back a state widget.
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
  const pickName = (except: string) => {
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
  const candidates = [
    ...new Set([
      ...values.filter((dimension) => matches(dimension, STATE_NAME)),
      ...stateFlagDimensions(model),
    ]),
  ];
  let state: CatalogDimension | undefined;
  let name: CatalogDimension | undefined;
  for (const candidate of candidates) {
    name = pickName(candidate.id);
    if (name) {
      state = candidate;
      break;
    }
  }
  if (!state) {
    // Only text fields left (#900): the preferred name first, the state
    // the last other one, so an ID never names the items when a plain
    // field can.
    name = pickName("");
    state = [...values]
      .reverse()
      .find((dimension) => dimension.id !== name?.id);
  }
  if (!state || !name) return null;
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
 * The name after the state takes the name's field `taken` (a swap): the
 * freed state field when it is text, else another text field of `model`,
 * else none (a yes/no field is never a name).
 */
function swappedName(
  model: CatalogModel,
  freed: string,
  taken: string,
): string | undefined {
  const type = model.dimensions.find((d) => d.id === freed)?.type;
  if (type === undefined || type === "string") return freed;
  return stateNameDimensions(model).find((d) => d.id !== taken)?.id;
}

/**
 * The fields each role of a binding may take: every text field for the
 * name and every text or yes/no field for the state, the other role's
 * included (picking it swaps the two, `withStateField`) unless the swap
 * would leave no text field for the name (#900), and the yes/no fields
 * but the state for the rollback flag.
 */
export function stateFieldChoices(
  model: CatalogModel,
  binding: Pick<StateWidgetBinding, "nameDimensionId" | "stateDimensionId">,
) {
  return {
    names: stateNameDimensions(model),
    states: stateValueDimensions(model).filter(
      (dimension) =>
        dimension.id !== binding.nameDimensionId ||
        swappedName(model, binding.stateDimensionId, dimension.id) !==
          undefined,
    ),
    changed: stateChangedDimensions(model),
    flags: stateFlagDimensions(model).filter(
      (dimension) => dimension.id !== binding.stateDimensionId,
    ),
  };
}

/**
 * The binding with `role` set to `value`, at once (final review of #875):
 * picking the field the other role holds swaps name and state, so one
 * field never takes two roles and two text fields can trade places. A
 * yes/no state is never a name: then the name falls to another text field
 * of `model`, and without one the binding stays as it is (#900). A
 * rollback flag that became the state is dropped.
 */
export function withStateField<B extends StateWidgetBinding>(
  binding: B,
  role: "nameDimensionId" | "stateDimensionId",
  value: string,
  model?: CatalogModel,
): B {
  if (binding[role] === value) return binding;
  const other =
    role === "nameDimensionId" ? "stateDimensionId" : "nameDimensionId";
  let next = { ...binding, [role]: value };
  if (binding[other] === value) {
    const freed = binding[role];
    const swapped =
      other === "nameDimensionId" && model
        ? swappedName(model, freed, value)
        : freed;
    if (swapped === undefined) return binding;
    next = { ...next, [other]: swapped };
  }
  if (next.rolledBackDimensionId === next.stateDimensionId) {
    const { rolledBackDimensionId: _flag, ...rest } = next;
    return rest as B;
  }
  return next;
}

/**
 * The names the single form offers (final review of #875): each once, and
 * none the server cut to 200 characters (it would never match).
 */
export function stateItemNames(
  items: ReadonlyArray<{ name: string | null }>,
): string[] {
  return [
    ...new Set(
      items.flatMap((item) =>
        item.name && !(item.name.length >= 200 && item.name.endsWith("…"))
          ? [item.name]
          : [],
      ),
    ),
  ];
}

/** Published models a state widget can show. */
export function stateModels(models: readonly CatalogModel[]): CatalogModel[] {
  return models.filter((model) => stateBindingFor(model) !== null);
}
