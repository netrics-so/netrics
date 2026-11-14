"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ProjectFilterQuery,
  PublishedModelCatalog,
} from "@netrics/contracts";
import { loadPublishedModels } from "./dashboard-data-api";

type CatalogModel = PublishedModelCatalog["models"][number];

/**
 * The models a picker offers (#573): those in the picker scope, plus the
 * ones `keep` names (already bound), so an existing binding to a model of
 * an archived or other project still reads its measures.
 */
export function pickableModels(
  all: readonly CatalogModel[],
  inScope: ReadonlySet<string>,
  keep: ReadonlySet<string>,
): CatalogModel[] {
  return all.filter(
    (model) => inScope.has(model.modelId) || keep.has(model.modelId),
  );
}

/**
 * Published models for the Studio. With `scope`, the catalog is narrowed
 * to the picker scope (`pickerQuery`), keeping the models in `keep`.
 */
export function usePublishedModels(
  workspaceId: string,
  scope?: { query: ProjectFilterQuery; keep: ReadonlySet<string> },
) {
  const [loaded, setLoaded] = useState<{
    all: CatalogModel[];
    inScope: ReadonlySet<string> | null;
  }>({ all: [], inScope: null });
  const [error, setError] = useState(false),
    [revision, setRevision] = useState(0);
  const queryKey = scope ? JSON.stringify(scope.query) : "";
  useEffect(() => {
    let alive = true;
    setError(false);
    const query = queryKey
      ? (JSON.parse(queryKey) as ProjectFilterQuery)
      : null;
    Promise.all([
      loadPublishedModels(workspaceId),
      query ? loadPublishedModels(workspaceId, query) : null,
    ])
      .then(([all, scoped]) => {
        if (alive)
          setLoaded({
            all: all.models,
            inScope: scoped
              ? new Set(scoped.models.map((model) => model.modelId))
              : null,
          });
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, queryKey, revision]);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const keep = scope?.keep;
  const models = useMemo(
    () =>
      loaded.inScope && keep
        ? pickableModels(loaded.all, loaded.inScope, keep)
        : loaded.all,
    [loaded, keep],
  );
  return { models, error, retry };
}
