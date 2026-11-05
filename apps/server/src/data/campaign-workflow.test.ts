import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  createDatabase,
  createWorkspace,
  withWorkspace,
  schema,
  type Database,
} from "@netrics/database";
import type {
  DashboardFilterValue,
  SemanticModelDefinition,
  PreparationGraph,
} from "@netrics/domain";
import { createTestDatabase } from "../test-db.js";
import { createDataService, type DataActor } from "./service.js";
import { createDashboardService } from "../dashboards/service.js";
import { queryDashboardData } from "../dashboards/data.js";
import {
  campaignFixtures,
  campaignNow,
  campaignPreparation,
  campaignDimension,
  campaignModel,
  campaignDashboard,
  call,
  field,
  type CampaignSources,
} from "./test-helpers.js";

let db: Database,
  data: ReturnType<typeof createDataService>,
  actor: DataActor,
  foreign: DataActor;
let sources: CampaignSources,
  ads: string,
  web: string,
  campaigns: string,
  modelId: string,
  modelDefinition: SemanticModelDefinition;
let dashboardId: string, scopedDashboardId: string;
const allMeasures = [
  "spend",
  "revenue",
  "contribution",
  "roas",
  "visits",
  "conversions",
  "any_conversions",
  "profitable",
];
const campaignFilter = (id: string) =>
  call("eq", field("campaign"), { kind: "literal", type: "string", value: id });

beforeAll(async () => {
  const test = await createTestDatabase();
  db = createDatabase(test.appUrl);
  const [user] = await db
    .insert(schema.users)
    .values({
      email: "campaign-proof@example.test",
      displayName: "Campaign owner",
    })
    .returning();
  const workspaceId = await createWorkspace(db, {
    name: "Campaign proof",
    ownerUserId: user!.id,
  });
  actor = { workspaceId, callerId: user!.id };
  foreign = {
    ...actor,
    workspaceId: await createWorkspace(db, {
      name: "Other workspace",
      ownerUserId: user!.id,
    }),
  };
  data = createDataService(db, () => campaignNow);
  sources = {} as CampaignSources;
  for (const key of Object.keys(campaignFixtures) as Array<
    keyof CampaignSources
  >) {
    const fixture = campaignFixtures[key];
    sources[key] = (await data.saveManual(actor, fixture)).datasetId;
  }
  const publish = async (name: string, graph: PreparationGraph) => {
    const saved = await data.savePreparation(actor, { name, graph });
    await data.publishPreparation(
      actor,
      saved.preparation.id,
      saved.preparation.version,
    );
    return `prepared:${saved.preparation.id}:${graph.outputs[0]!}`;
  };
  ads = await publish(
    "Advertising campaigns",
    campaignPreparation("ads", sources),
  );
  web = await publish("Website campaigns", campaignPreparation("web", sources));
  campaigns = await publish(
    "Shared campaign identities",
    campaignDimension(ads, web),
  );
  modelDefinition = campaignModel(sources, ads, web, campaigns);
  const model = await data.saveModel(actor, {
    name: "Campaign performance",
    definition: modelDefinition,
  });
  modelId = model.model.id;
  await data.publishModel(actor, modelId, model.model.version);
  const dashboards = createDashboardService({ db });
  const overview = await dashboards.create(actor, campaignDashboard(modelId));
  const scoped = await dashboards.create(
    actor,
    campaignDashboard(modelId, "Spring launch screen", "launch"),
  );
  if (!overview.ok || !scoped.ok)
    throw new Error("campaign_dashboard_setup_failed");
  dashboardId = overview.value.id;
  scopedDashboardId = scoped.value.id;
}, 60000);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

async function readDashboard(
  id: string,
  values: Record<string, DashboardFilterValue> = {},
) {
  return withWorkspace(db, { workspaceId: actor.workspaceId }, async (tx) => {
    const [dashboard] = await tx
      .select()
      .from(schema.dashboards)
      .where(
        and(
          eq(schema.dashboards.workspaceId, actor.workspaceId),
          eq(schema.dashboards.id, id),
        ),
      );
    const widgets = await tx
      .select()
      .from(schema.dashboardWidgets)
      .where(
        and(
          eq(schema.dashboardWidgets.workspaceId, actor.workspaceId),
          eq(schema.dashboardWidgets.dashboardId, id),
        ),
      )
      .orderBy(schema.dashboardWidgets.y);
    return queryDashboardData(
      tx,
      actor.workspaceId,
      widgets,
      dashboard!.dataFilters,
      values,
      campaignNow,
    );
  });
}
const rowFor = async (id = "launch") =>
  (
    await data.query(actor, modelId, {
      measureIds: allMeasures,
      groupBy: ["campaign", "currency"],
      filter: campaignFilter(id),
    })
  ).rows[0]!;

describe("persisted advertising and website campaign workflow", () => {
  it("combines independently aggregated facts at confirmed identities without a fact-to-fact fanout", async () => {
    const launch = await rowFor();
    expect(launch.dimensionLabels).toEqual({ campaign: "Spring launch" });
    expect(launch.measures).toMatchObject({
      spend: { value: "30", currency: "EUR", status: "ok" },
      revenue: { value: "150", currency: "EUR", status: "ok" },
      contribution: { value: "120", currency: "EUR", status: "ok" },
      roas: { value: "5", status: "ok" },
      visits: { value: "150" },
      conversions: { value: "4" },
      any_conversions: { value: true, type: "boolean" },
      profitable: { value: true, type: "boolean" },
    });
    const brand = await rowFor("brand");
    expect(brand.measures.contribution).toMatchObject({
      value: "-8",
      currency: "EUR",
    });
    expect(brand.measures.any_conversions?.value).toBe(false);
    expect(brand.measures.profitable?.value).toBe(false);
    const overview = await data.query(actor, modelId, {
      measureIds: ["spend", "revenue"],
      groupBy: [],
    });
    expect(overview.rows[0]?.measures.spend?.value).toBe("40");
    expect(overview.rows[0]?.measures.revenue?.value).toBe("162.5");
  });
  it("preserves unmapped source identities instead of matching names or dropping their rows", async () => {
    const result = await data.query(actor, modelId, {
      measureIds: ["spend", "revenue"],
      groupBy: ["campaign"],
    });
    const unknownAd = result.rows.find(
      (row) => row.dimensions.campaign === "ads:new-77",
    )!;
    const unknownWeb = result.rows.find(
      (row) => row.dimensions.campaign === "web:unknown-77",
    )!;
    expect(unknownAd.dimensionLabels?.campaign).toBe("Unmapped ads · new-77");
    expect(unknownAd.measures.spend?.value).toBe("2");
    expect(unknownAd.measures.revenue?.value).toBeNull();
    expect(unknownWeb.dimensionLabels?.campaign).toBe(
      "Unmapped web · unknown-77",
    );
    expect(unknownWeb.measures.revenue?.value).toBe("12.5");
    expect(unknownWeb.measures.spend?.value).toBeNull();
    expect(result.rows).toHaveLength(4);
    await expect(
      data.query(foreign, modelId, { measureIds: ["revenue"], groupBy: [] }),
    ).rejects.toThrow("data_model_not_found");
    await expect(data.preview(foreign, sources.web)).rejects.toThrow(
      "data_source_not_found",
    );
  });
  it("applies campaign, market and reporting-day filters to each fact and intersects fixed screen scope", async () => {
    const result = await readDashboard(dashboardId, {
      campaign: { kind: "values", values: ["launch"] },
      market: { kind: "values", values: ["EU"] },
      day: { kind: "range", from: "2026-11-01", to: "2026-11-01" },
    });
    expect(result.widgets.every((widget) => widget.error === null)).toBe(true);
    expect(result.widgets[0]?.result?.rows[0]?.measures).toMatchObject({
      spend: { value: "20" },
      revenue: { value: "100" },
      contribution: { value: "80" },
      roas: { value: "5" },
      visits: { value: "100" },
    });
    expect(result.widgets[0]?.scope).toContain("Campaign: Spring launch");
    const scoped = await readDashboard(scopedDashboardId);
    expect(
      scoped.widgets[0]?.result?.rows.map((row) => row.dimensions.campaign),
    ).toEqual(["launch"]);
    const refused = await readDashboard(scopedDashboardId, {
      campaign: { kind: "values", values: ["brand"] },
    });
    expect(refused.widgets[0]?.result?.rows).toEqual([]);
  });
  it("refuses unsupported keyword revenue, ambiguous paths and a direct fact-to-fact join", async () => {
    await expect(
      data.query(actor, modelId, {
        measureIds: ["revenue"],
        groupBy: ["keyword"],
      }),
    ).rejects.toThrow("model_dimension_incompatible");
    await expect(
      data.query(actor, modelId, {
        measureIds: ["contribution"],
        groupBy: [],
        filter: call("eq", field("keyword"), {
          kind: "literal",
          type: "string",
          value: "shoes",
        }),
      }),
    ).rejects.toThrow("model_dimension_incompatible");
    const spendOnly = await data.query(actor, modelId, {
      measureIds: ["spend"],
      groupBy: ["keyword"],
    });
    expect(
      spendOnly.rows.find((row) => row.dimensions.keyword === "shoes")?.measures
        .spend?.value,
    ).toBe("20.1");
    await expect(
      data.previewModel(
        actor,
        {
          ...modelDefinition,
          relationships: [
            ...modelDefinition.relationships,
            {
              ...modelDefinition.relationships[0]!,
              id: "duplicate_campaign_path",
            },
          ],
        },
        { measureIds: ["revenue", "spend"], groupBy: ["campaign"] },
      ),
    ).rejects.toThrow("model_filter_path_ambiguous");
    await expect(
      data.previewPreparation(actor, {
        version: 1,
        nodes: [
          { id: "ads", type: "source", datasetId: ads },
          { id: "web", type: "source", datasetId: web },
          {
            id: "unsafe",
            type: "join",
            left: "ads",
            right: "web",
            keys: [{ left: "campaign_id", right: "website_campaign_id" }],
            mode: "left",
            cardinality: "many_to_one",
            rightPrefix: "web.",
          },
        ],
        outputs: ["unsafe"],
      }),
    ).rejects.toThrow("preparation_join_cardinality_violation");
  });
  it("publishes a corrected imported snapshot only after its last page and refreshes dependent results", async () => {
    const current = await data.readManual(actor, sources.web, {
      offset: 0,
      limit: 1000,
    });
    const records = current.records.map((record) => ({
      values: {
        ...record.values,
        ...(record.values.id === "w3" ? { revenue: "60.10" } : {}),
      },
    }));
    const refreshId = randomUUID();
    const first = await data.saveManualPage(actor, {
      definition: current.definition,
      datasetId: sources.web,
      generationId: current.generationId,
      refreshId,
      page: 0,
      complete: false,
      records: records.slice(0, 2),
    });
    expect(first.generationId).toBeNull();
    const before = await data.query(actor, modelId, {
      measureIds: ["revenue"],
      groupBy: [],
      filter: campaignFilter("launch"),
    });
    expect(before.rows[0]?.measures.revenue?.value).toBe("150");
    const finalPage = {
      definition: current.definition,
      datasetId: sources.web,
      generationId: current.generationId,
      refreshId,
      page: 1,
      complete: true,
      records: records.slice(2),
    };
    const saved = await data.saveManualPage(actor, finalPage);
    expect(await data.saveManualPage(actor, finalPage)).toEqual(saved);
    const after = await data.query(actor, modelId, {
      measureIds: ["revenue", "contribution"],
      groupBy: [],
      filter: campaignFilter("launch"),
    });
    expect(after.rows[0]?.measures).toMatchObject({
      revenue: { value: "160.1" },
      contribution: { value: "130.1" },
    });
    expect(after.provenance).not.toEqual(before.provenance);
    expect(
      (await readDashboard(scopedDashboardId)).widgets[0]?.result?.rows[0]
        ?.measures.revenue?.value,
    ).toBe("160.1");
  });
  it("keeps model drafts private and publishes one measure change to both dependent dashboards", async () => {
    const current = (await data.getModel(actor, modelId)).model;
    const saved = await data.saveModel(
      actor,
      {
        name: current.name,
        version: current.version,
        definition: {
          ...current.definition,
          measures: current.definition.measures.map((measure) =>
            measure.id === "contribution" && measure.kind === "formula"
              ? {
                  ...measure,
                  name: "Revenue less twice ad spend",
                  expression: call(
                    "subtract",
                    field("revenue"),
                    call("multiply", field("spend"), {
                      kind: "literal",
                      type: "decimal",
                      value: "2",
                    }),
                  ),
                }
              : measure,
          ),
        },
      },
      modelId,
    );
    const value = async (id: string) =>
      (
        await readDashboard(id, {
          campaign: { kind: "values", values: ["launch"] },
        })
      ).widgets[0]?.result?.rows[0]?.measures.contribution?.value;
    expect(await value(dashboardId)).toBe("130.1");
    expect(await value(scopedDashboardId)).toBe("130.1");
    await data.publishModel(actor, modelId, saved.model.version);
    expect(await value(dashboardId)).toBe("100.1");
    expect(await value(scopedDashboardId)).toBe("100.1");
  });
});
