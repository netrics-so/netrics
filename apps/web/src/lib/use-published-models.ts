"use client";
import { useCallback, useEffect, useState } from "react";
import type { PublishedModelCatalog } from "@netrics/contracts";
import { loadPublishedModels } from "./dashboard-data-api";
export function usePublishedModels(workspaceId: string) {
  const [models, setModels] = useState<PublishedModelCatalog["models"]>([]),
    [error, setError] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(false);
    loadPublishedModels(workspaceId)
      .then((response) => {
        if (alive) setModels(response.models);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, revision]);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return { models, error, retry };
}
