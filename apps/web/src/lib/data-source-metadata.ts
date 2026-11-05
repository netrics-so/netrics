"use client";
import { useEffect, useState } from "react";
import { readDraftInputs, type DataSource } from "./data-api";

/** Historical prepared outputs may no longer exist in the latest published catalog. */
export function overlayDraftSources(
  catalog: DataSource[],
  inputs: DataSource[],
) {
  const overlay = new Map(inputs.map((source) => [source.id, source]));
  return [
    ...catalog.map((source) => overlay.get(source.id) ?? source),
    ...inputs.filter(
      (source) => !catalog.some((item) => item.id === source.id),
    ),
  ];
}

export function useDraftSources(
  workspaceId: string,
  kind: "preparations" | "models",
  record: {
    id: string;
    version: number;
    restoredFromVersion?: number | null;
  } | null,
  catalog: DataSource[],
) {
  const key = record?.restoredFromVersion
    ? `${workspaceId}:${kind}:${record.id}:${record.version}`
    : "";
  const [response, setResponse] = useState<{
    key: string;
    sources?: DataSource[];
    error?: unknown;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    if (!key || !record) return;
    setResponse(null);
    readDraftInputs(workspaceId, kind, record.id, record.version)
      .then((value) => {
        if (active) setResponse({ key, sources: value.sources });
      })
      .catch((error: unknown) => {
        if (active) setResponse({ key, error });
      });
    return () => {
      active = false;
    };
  }, [key, retry]);
  const current = key && response?.key === key ? response : null;
  return {
    sources: current?.sources
      ? overlayDraftSources(catalog, current.sources)
      : catalog,
    loading: !!key && !current,
    error: current?.error,
    retry: () => {
      setResponse(null);
      setRetry((value) => value + 1);
    },
  };
}
