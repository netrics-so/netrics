"use client";
import { useEffect, useState } from "react";
import type { DashboardDataFilter, ProductApps } from "@netrics/domain";

import {
  draftProductKey,
  loadDraftProductApps,
} from "@/lib/studio-product-apps";

/**
 * The linked products of the draft's shared filters with their member
 * apps (#777), asked again whenever the models the filters map to change
 * (a filter added, removed or mapped anew) and after a save (`version`).
 * `known` is null until they are loaded for the draft's current filters,
 * and when loading failed: validation then leaves product slides to the
 * server. `apps` is what the canvas resolves scopes with meanwhile: the
 * saved dashboard's.
 */
export function useDraftProductApps(
  workspaceId: string,
  filters: readonly DashboardDataFilter[] | undefined,
  version: number,
  saved: ProductApps | undefined,
): { apps: ProductApps; known: ProductApps | null } {
  const key = `${draftProductKey(filters)}@${version}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    apps: ProductApps;
  } | null>(null);
  useEffect(() => {
    let current = true;
    void loadDraftProductApps(workspaceId, filters).then((apps) => {
      if (current && apps) setLoaded({ key, apps });
    });
    return () => {
      current = false;
    };
    // `key` stands for the filters' mapped models.
  }, [workspaceId, key]);
  const known = loaded?.key === key ? loaded.apps : null;
  return { apps: known ?? loaded?.apps ?? saved ?? {}, known };
}
