import { sql } from "drizzle-orm";
import type {
  ItemsWidgetData,
  ItemsWidgetItem,
  ItemsWidgetOptions,
} from "@netrics/contracts";
import {
  itemsModelQuery,
  itemsModelWithCount,
  querySemanticModel,
  DEFAULT_DATA_POLICY,
  type DashboardDataFilter,
  type DashboardFilterValue,
  type DataPolicy,
  type DeviceFilterScope,
  type ItemsWidgetBinding,
  type SlideFilterScope,
} from "@netrics/domain";
import {
  findItemImages,
  resolveDataPolicy,
  type Transaction,
  rethrowWorkspaceGone,
} from "@netrics/database";
import { DataServiceError, queryDataModel } from "../data/service.js";
import { itemImageUrlHash } from "../images/custom-api-images.js";
import {
  activeExclusions,
  checkFilterMappings,
  publishedModel,
  safeDataError,
} from "./data.js";
import {
  sourceFreshnessDependencies,
  type FreshnessReader,
  type WidgetFreshnessResult,
} from "./freshness.js";
import { modelSourceDatasets } from "./model-sources.js";

/** Item titles and subtitles are cut to this many characters, with "…". */
export const ITEMS_TEXT_MAX = 200;

/**
 * A latest-items widget's binding against its published model (#810): the
 * image is a string dimension with role "image", the time a date or
 * timestamp, every named dimension the model's, and the dashboard's filters
 * apply as on a measure widget. Throws DataServiceError (or the model's
 * DataProcessingError) with the code a save answers.
 */
export async function validateDashboardItems(
  tx: Transaction,
  workspaceId: string,
  filters: DashboardDataFilter[],
  binding: ItemsWidgetBinding,
  slideScope: SlideFilterScope = {},
) {
  const model = await publishedModel(tx, workspaceId, binding.modelId);
  const dimension = (id: string) => {
    const found = model.metadata.dimensions.find(
      (dimension) => dimension.id === id,
    );
    if (!found) throw new DataServiceError("items_dimension_unknown");
    return found;
  };
  const image = dimension(binding.imageDimensionId);
  if (image.type !== "string" || image.role !== "image")
    throw new DataServiceError("items_image_dimension_invalid");
  dimension(binding.titleDimensionId);
  if (binding.subtitleDimensionId) dimension(binding.subtitleDimensionId);
  const time = dimension(binding.timeDimensionId);
  if (time.type !== "date" && time.type !== "timestamp")
    throw new DataServiceError("items_time_dimension_invalid");
  checkFilterMappings(filters, binding.modelId, model.metadata.dimensions);
  // The shape and filter paths against the published schema, without rows.
  const { model: definition, query } = itemsModelQuery(
    model.definition,
    filters,
    {},
    binding,
    1,
    {},
    slideScope,
  );
  querySemanticModel(
    definition,
    new Map(
      Object.entries(model.bindings).map(([id, fields]) => [
        id,
        { fields, rows: [] },
      ]),
    ),
    query,
  );
  return model;
}

/** A dimension's value as an item's text: its label, else the value. */
function itemText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : String(value);
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/**
 * The newest items of a latest-items widget (#810), newest first, each
 * with its stored image (by the URL's hash) or none. One widget never fails
 * the dashboard: any error answers `no_data` with its code. The image URL
 * is never part of the result, and nothing is downloaded here: an item
 * outside the images stored after a sync shows without its image.
 */
export async function queryDashboardItems(
  tx: Transaction,
  workspaceId: string,
  input: {
    id: string;
    binding: ItemsWidgetBinding;
    options: ItemsWidgetOptions;
  },
  filters: DashboardDataFilter[],
  values: Record<string, DashboardFilterValue>,
  now: Date,
  defaults: DataPolicy = DEFAULT_DATA_POLICY,
  /** A paired screen's fixed scope (#500); browsers have none. */
  deviceScope: DeviceFilterScope = {},
  /** The scope of the widget's slide (#707). */
  slideScope: SlideFilterScope = {},
  /** Reads the model's sources' freshness (ADR 0025); absent: none. */
  freshnessReader?: FreshnessReader,
): Promise<ItemsWidgetData> {
  let fresh: WidgetFreshnessResult = { overdue: false };
  const exclusions = activeExclusions(
    filters,
    values,
    slideScope,
    input.binding.exclusions,
  );
  try {
    return await tx.transaction(async (savepoint) => {
      const release = await validateDashboardItems(
        savepoint,
        workspaceId,
        filters,
        input.binding,
        slideScope,
      );
      if (freshnessReader) {
        const sources = await modelSourceDatasets(
          savepoint,
          workspaceId,
          release,
        );
        fresh = await freshnessReader.read(
          savepoint,
          await sourceFreshnessDependencies(
            savepoint,
            workspaceId,
            sources.all,
            slideScope,
            input.binding.exclusions,
            deviceScope,
            {
              now,
              defaults,
              cache: freshnessReader.scopeMappings,
              defaultLinks: sources.defaultLinks,
            },
            input.binding.filter,
            { filters, values },
          ),
        );
      }
      const { policy } = await resolveDataPolicy(
        savepoint,
        workspaceId,
        defaults,
      );
      await savepoint.execute(
        sql`select set_config('statement_timeout', ${String(policy.queryTimeoutMs ?? 0)}, true)`,
      );
      const { query } = itemsModelQuery(
        release.definition,
        filters,
        values,
        input.binding,
        input.options.count,
        deviceScope,
        slideScope,
      );
      const result = await queryDataModel(
        savepoint,
        workspaceId,
        input.binding.modelId,
        query,
        now,
        policy,
        false,
        undefined,
        true,
        (definition) => itemsModelWithCount(definition, input.binding),
      );
      const rows = [...result.rows].reverse();
      const urls = rows.map((row) => {
        const url = row.dimensions[input.binding.imageDimensionId];
        return typeof url === "string" && url !== "" ? url : null;
      });
      const stored = await findItemImages(savepoint, workspaceId, [
        ...new Set(urls.flatMap((url) => (url ? [itemImageUrlHash(url)] : []))),
      ]);
      const text = (
        row: (typeof rows)[number],
        id: string | undefined,
      ): string | null =>
        id === undefined
          ? null
          : itemText(
              row.dimensionLabels?.[id] ?? row.dimensions[id],
              ITEMS_TEXT_MAX,
            );
      const items: ItemsWidgetItem[] = rows.map((row, index) => {
        const url = urls[index];
        const image = url ? stored.get(itemImageUrlHash(url)) : undefined;
        return {
          title: text(row, input.binding.titleDimensionId),
          subtitle: text(row, input.binding.subtitleDimensionId),
          time: itemText(row.dimensions[input.binding.timeDimensionId], 40),
          image: image
            ? {
                id: image.imageId,
                sha256: image.sha256,
                width: image.width,
                height: image.height,
              }
            : null,
        };
      });
      return {
        widgetId: input.id,
        status: items.length ? ("ok" as const) : ("no_data" as const),
        items,
        error: null,
        exclusions,
        ...(fresh.freshness ? { freshness: fresh.freshness } : {}),
      };
    });
  } catch (error) {
    rethrowWorkspaceGone(error);
    return {
      widgetId: input.id,
      status: "no_data",
      items: [],
      error: safeDataError(error),
      exclusions,
      ...(fresh.freshness ? { freshness: fresh.freshness } : {}),
    };
  }
}
