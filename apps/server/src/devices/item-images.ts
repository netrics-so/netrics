import { dashboardDataFiltersSchema } from "@netrics/contracts";
import { findDashboard, findDevice, type Transaction } from "@netrics/database";
import type { DataPolicy } from "@netrics/domain";

import { deviceItemsWidgets, screenSlides } from "./dashboard.js";
import { storedScope } from "./service.js";

/**
 * The item image ids a device's current payload references (#810): the
 * same items queries as its payload (its dashboard's enabled slides, its
 * fixed scope, the slides' scopes, the filters' saved values, `now`), and
 * their stored images. Empty for a revoked or unassigned device, and when
 * the dashboard has no latest-items widget. The device image route serves
 * a `custom_api` image only when it is one of these.
 */
export async function deviceItemImageIds(
  tx: Transaction,
  workspaceId: string,
  deviceId: string,
  now: Date,
  dataPolicy?: DataPolicy,
): Promise<ReadonlySet<string>> {
  const device = await findDevice(tx, workspaceId, deviceId);
  if (!device || device.revokedAt || !device.dashboardId) return new Set();
  const dashboard = await findDashboard(tx, workspaceId, device.dashboardId);
  if (
    !dashboard?.slides.some((slide) =>
      slide.widgets.some((widget) => widget.type === "items"),
    )
  )
    return new Set();
  const filters = dashboardDataFiltersSchema.parse(dashboard.dataFilters ?? []);
  const scope = storedScope(device);
  const items = await deviceItemsWidgets(
    tx,
    workspaceId,
    screenSlides(dashboard, filters, scope),
    filters,
    { now, scope, ...(dataPolicy ? { dataPolicy } : {}) },
  );
  return new Set(
    [...items.values()].flatMap((data) =>
      data.items.flatMap((item) => (item.image ? [item.image.id] : [])),
    ),
  );
}
