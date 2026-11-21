import { dashboardDataFiltersSchema } from "@netrics/contracts";
import {
  findDashboard,
  findDashboardVersion,
  findDevice,
  type DeviceRow,
  type Transaction,
} from "@netrics/database";
import type { DataPolicy } from "@netrics/domain";

import { deviceItemsWidgets, screenSlides } from "./dashboard.js";
import { storedScope } from "./service.js";

const NONE: ReadonlySet<string> = new Set();

/**
 * What an items query that failed on the database answers (safeDataError):
 * a statement timeout, a serialization failure, a lost connection. Every
 * other error code is the widget's own and fails the same way next time.
 */
const TRANSIENT_ITEMS_ERROR = "data_storage_failed";

/**
 * The item image ids a device's current payload references (#810): the
 * same items queries as its payload (its dashboard's enabled slides, its
 * fixed scope, the slides' scopes, the filters' saved values, `now`), and
 * their stored images. Empty when the dashboard has no latest-items widget.
 * The device image route serves a `custom_api` image only when it is one of
 * these. `complete` is false when an items query failed transiently (a
 * timeout, a serialization failure: `data_storage_failed`), so its images
 * may be missing from `ids`. A widget that fails for good (a deleted
 * source, a binding its model no longer matches) has no images to miss:
 * the answer is complete.
 */
export async function deviceItemImageIds(
  tx: Transaction,
  workspaceId: string,
  device: DeviceRow,
  now: Date,
  dataPolicy?: DataPolicy,
): Promise<{ ids: ReadonlySet<string>; complete: boolean }> {
  const none = { ids: NONE, complete: true };
  if (device.revokedAt || !device.dashboardId) return none;
  const dashboard = await findDashboard(tx, workspaceId, device.dashboardId);
  if (
    !dashboard?.slides.some((slide) =>
      slide.widgets.some((widget) => widget.type === "items"),
    )
  )
    return none;
  const filters = dashboardDataFiltersSchema.parse(dashboard.dataFilters ?? []);
  const scope = storedScope(device);
  const items = await deviceItemsWidgets(
    tx,
    workspaceId,
    screenSlides(dashboard, filters, scope),
    filters,
    { now, scope, ...(dataPolicy ? { dataPolicy } : {}) },
  );
  return {
    ids: new Set(
      [...items.values()].flatMap((data) =>
        data.items.flatMap((item) => (item.image ? [item.image.id] : [])),
      ),
    ),
    complete: [...items.values()].every(
      (data) => data.error !== TRANSIENT_ITEMS_ERROR,
    ),
  };
}

export interface DeviceItemImagesOptions {
  /** How long one device's answer is reused (default 10 s). */
  ttlMs?: number;
  /** At most this many devices' answers are kept (default 500). */
  maxEntries?: number;
  /** Milliseconds, for the memo only; tests pin it. */
  clock?: () => number;
  /** The queries behind the memo; tests count them. */
  compute?: typeof deviceItemImageIds;
}

export type DeviceItemImages = (
  tx: Transaction,
  workspaceId: string,
  deviceId: string,
  now: Date,
  dataPolicy?: DataPolicy,
) => Promise<ReadonlySet<string>>;

/**
 * `deviceItemImageIds` with a short memo per device (#810): a screen loads
 * a payload's new item images in a burst, and each request would otherwise
 * rerun every items query of its dashboard. Keyed by the device, its
 * dashboard and that dashboard's version and the device's scope, so an edit
 * or a reassignment is seen at once; new records are seen after the TTL.
 * A revoked or unassigned device is never memoized and gets none. An
 * answer with a transiently failed items query is not memoized either
 * (#829): it must not hide the device's images for the whole TTL. A
 * permanently broken widget is memoized like any other answer, so it does
 * not rerun the queries on every image request.
 */
export function createDeviceItemImages(
  options: DeviceItemImagesOptions = {},
): DeviceItemImages {
  const ttlMs = options.ttlMs ?? 10_000;
  const maxEntries = options.maxEntries ?? 500;
  const clock = options.clock ?? Date.now;
  const compute = options.compute ?? deviceItemImageIds;
  const memo = new Map<string, { at: number; ids: ReadonlySet<string> }>();
  return async (tx, workspaceId, deviceId, now, dataPolicy) => {
    const device = await findDevice(tx, workspaceId, deviceId);
    if (!device || device.revokedAt || !device.dashboardId) return NONE;
    const version = await findDashboardVersion(
      tx,
      workspaceId,
      device.dashboardId,
    );
    const key = JSON.stringify([
      workspaceId,
      deviceId,
      device.dashboardId,
      version,
      device.scope ?? null,
    ]);
    const at = clock();
    const hit = memo.get(key);
    if (hit && at - hit.at < ttlMs) return hit.ids;
    const { ids, complete } = await compute(
      tx,
      workspaceId,
      device,
      now,
      dataPolicy,
    );
    memo.delete(key);
    if (!complete) return ids;
    memo.set(key, { at, ids });
    // Oldest first: a Map keeps insertion order.
    for (const [old, entry] of memo)
      if (memo.size > maxEntries || at - entry.at >= ttlMs) memo.delete(old);
      else break;
    return ids;
  };
}
