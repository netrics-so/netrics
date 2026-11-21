import type { DashboardDataFilter, ProductApps } from "@netrics/domain";

import { loadProductApps } from "./dashboard-data-api";

// The Studio's draft and linked products (#777). A slide scoped to a
// product (`product:<id>`) gives a metric, line, bar, table or review
// widget the product's app of its connection. Which apps a product has
// depends on the models the draft's shared filters map to, and a draft's
// filters differ from the saved dashboard's: the Studio asks the server
// for the draft's products whenever those models change, with the same
// resolution a save validates against.

/** The models a draft's shared filters map to, each once, in order. */
export function draftProductModels(
  filters: readonly DashboardDataFilter[] | undefined,
): string[] {
  return [
    ...new Set(
      (filters ?? []).flatMap((filter) =>
        filter.mappings.map((mapping) => mapping.modelId),
      ),
    ),
  ].sort();
}

/** Changes exactly when the draft's products have to be asked for again. */
export function draftProductKey(
  filters: readonly DashboardDataFilter[] | undefined,
): string {
  return draftProductModels(filters).join(",");
}

/**
 * The linked products of the draft's filters with their member apps; none
 * without mapped filters (nothing is asked). Null when they could not be
 * loaded: the draft's products are then unknown, and only the server can
 * tell whether a widget follows a product scope (documentProblems).
 */
export async function loadDraftProductApps(
  workspaceId: string,
  filters: readonly DashboardDataFilter[] | undefined,
  load: typeof loadProductApps = loadProductApps,
): Promise<ProductApps | null> {
  const modelIds = draftProductModels(filters);
  if (!modelIds.length) return {};
  try {
    return (await load(workspaceId, modelIds)).productApps;
  } catch {
    return null;
  }
}
