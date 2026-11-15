import type {
  Device,
  StoreTemplateApplyRequest,
  StoreTemplateInstallList,
  StoreTemplatePlan,
  StoreTemplateUpdate,
  StoreTemplateUpdateSummary,
} from "@netrics/contracts";

import { ApiError } from "./api";

/**
 * Store-template updates in the web app (11E): which dashboards and data
 * records an update concerns, what the review asks, and where an applied
 * update stands. Pure, so pages and tests share it.
 */
export type StoreInstall = StoreTemplateInstallList["installs"][number];
export type PlanRecord = StoreTemplatePlan["records"][number];
export type PlanItem = PlanRecord["items"][number];
export type Choice = StoreTemplateApplyRequest["decisions"][number]["choice"];
export type Decisions = Readonly<Record<string, Choice>>;
export type UpdateDashboard = StoreTemplateUpdate["dashboards"][number];

export const storeUpdatePath = (workspaceId: string, requestId: string) =>
  `/workspaces/${workspaceId}/dashboards/stores/updates/${requestId}`;
/** Where an install's connections and app scope are changed. */
export const storeScopePath = (workspaceId: string, requestId: string) =>
  `/workspaces/${workspaceId}/dashboards/stores?install=${requestId}`;

/** The install a dashboard belongs to while it has an update to offer. */
export function installWithUpdate(
  installs: readonly StoreInstall[],
  dashboardId: string,
): StoreInstall | undefined {
  return installs.find(
    (install) =>
      install.updateAvailable &&
      install.error === null &&
      install.dashboardIds.includes(dashboardId),
  );
}

/** The update (open or last) whose copy or original a dashboard is. */
export function updateOfDashboard(
  installs: readonly StoreInstall[],
  dashboardId: string,
): { install: StoreInstall; entry: UpdateDashboard } | undefined {
  for (const install of installs)
    for (const update of [install.openUpdate, install.lastUpdate])
      for (const entry of update?.dashboards ?? [])
        if (entry.originalId === dashboardId || entry.copyId === dashboardId)
          return { install, entry };
  return undefined;
}

/** Installs with an update for data settings, and the records they touch. */
export function dataUpdates(installs: readonly StoreInstall[]) {
  const offered = installs.filter(
    (install) =>
      install.error === null &&
      (install.openUpdate !== null ||
        (install.updateAvailable && install.summary !== null)),
  );
  const marked = new Map<string, StoreInstall>();
  for (const install of offered) {
    const drafts = install.openUpdate?.drafts;
    const ids = drafts
      ? drafts.filter((draft) => !draft.published).map((d) => d.recordId)
      : [...install.modelIds, ...install.preparationIds];
    for (const id of ids) marked.set(id, install);
  }
  return { offered, marked };
}

/** Summary parts by kind: `[{ kind, parts: [["changed", 2], ["added", 1]] }]`. */
export function summaryParts(summary: StoreTemplateUpdateSummary) {
  return (["measures", "steps", "widgets"] as const).flatMap((kind) => {
    const counts = summary[kind];
    const parts = (["changed", "added", "removed"] as const)
      .filter((change) => counts[change] > 0)
      .map((change) => [change, counts[change]] as const);
    return parts.length ? [{ kind, parts }] : [];
  });
}

/** Where an install's update stands, for its page. */
export type Stage =
  "unavailable" | "progress" | "review" | "finished" | "upToDate";
export function stageOf(install: StoreInstall): Stage {
  if (install.openUpdate) return "progress";
  if (install.error) return "unavailable";
  if (install.updateAvailable) return "review";
  if (install.lastUpdate?.dashboards.some((entry) => entry.swappedAt))
    return "finished";
  return "upToDate";
}

/** Items the customer decides on: no default is ever chosen for them. */
export const needsDecision = (item: PlanItem) =>
  item.outcome === "choose" || item.outcome === "propose_removal";

export function missingDecisions(
  plan: StoreTemplatePlan,
  decisions: Decisions,
): string[] {
  return plan.records
    .flatMap((record) => record.items)
    .filter((item) => needsDecision(item) && !isValidChoice(item, decisions))
    .map((item) => item.ref);
}
function isValidChoice(item: PlanItem, decisions: Decisions) {
  const choice = decisions[item.ref];
  return item.outcome === "choose"
    ? choice === "template" || choice === "customer"
    : choice === "remove" || choice === "keep";
}

/** The apply request: the reviewed basis and a choice for every asked item. */
export function applyRequest(
  plan: StoreTemplatePlan,
  decisions: Decisions,
): StoreTemplateApplyRequest {
  return {
    basis: plan.basis,
    decisions: plan.records
      .flatMap((record) => record.items)
      .filter((item) => needsDecision(item) && isValidChoice(item, decisions))
      .map((item) => ({ ref: item.ref, choice: decisions[item.ref]! })),
  };
}

/**
 * Decisions that still fit a reloaded plan: an item asked about with the
 * same three values keeps its choice; anything else is asked again.
 */
export function carryDecisions(
  before: StoreTemplatePlan,
  after: StoreTemplatePlan,
  decisions: Decisions,
): Decisions {
  const old = new Map(
    before.records.flatMap((record) => record.items).map((i) => [i.ref, i]),
  );
  const kept: Record<string, Choice> = {};
  for (const item of after.records.flatMap((record) => record.items)) {
    const previous = old.get(item.ref);
    if (
      needsDecision(item) &&
      decisions[item.ref] &&
      previous &&
      previous.outcome === item.outcome &&
      JSON.stringify([previous.original, previous.current, previous.next]) ===
        JSON.stringify([item.original, item.current, item.next]) &&
      isValidChoice(item, decisions)
    )
      kept[item.ref] = decisions[item.ref]!;
  }
  return kept;
}

/**
 * Applies the reviewed plan. A plan that changed meanwhile (another tab,
 * an edit) is reloaded instead, keeping the choices that still fit.
 */
export async function applyReviewed(
  plan: StoreTemplatePlan,
  decisions: Decisions,
  api: {
    apply: (body: StoreTemplateApplyRequest) => Promise<StoreTemplateUpdate>;
    reload: () => Promise<StoreTemplatePlan>;
  },
): Promise<
  | { kind: "applied"; update: StoreTemplateUpdate }
  | { kind: "reloaded"; plan: StoreTemplatePlan; decisions: Decisions }
> {
  try {
    return {
      kind: "applied",
      update: await api.apply(applyRequest(plan, decisions)),
    };
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "store_update_stale")
      throw error;
    const next = await api.reload();
    return {
      kind: "reloaded",
      plan: next,
      decisions: carryDecisions(plan, next, decisions),
    };
  }
}

/** Items of a record, in the review's groups; scope items are only counted. */
export function groupItems(record: PlanRecord) {
  const of = (outcome: PlanItem["outcome"]) =>
    record.items.filter((item) => item.outcome === outcome);
  return {
    choose: of("choose"),
    removal: of("propose_removal"),
    template: of("template"),
    customer: of("customer"),
    scope: of("scope").length,
  };
}

/** What a record's change is about, in the customer's words. */
export type ChangeTopic =
  | "column"
  | "step"
  | "result"
  | "measure"
  | "dimension"
  | "widget"
  | "slide"
  | "filter"
  | "other";
const TOPIC_ORDER: readonly ChangeTopic[] = [
  "column",
  "step",
  "result",
  "measure",
  "dimension",
  "widget",
  "slide",
  "filter",
  "other",
];
const CHANGE_ORDER = ["added", "changed", "removed"] as const;
/** A calculated column is what a customer sees of a calculate step. */
export function changeTopic(item: PlanItem): ChangeTopic {
  const { kind } = refParts(item.ref);
  switch (kind) {
    case "step":
      return field(itemValue(item), "type") === "calculate" ? "column" : "step";
    case "output":
      return "result";
    case "measure":
    case "dimension":
    case "widget":
    case "slide":
    case "filter":
      return kind;
    default:
      return "other";
  }
}

/**
 * A record's changes in one line (#625): what the template brings, counted
 * by topic and change ("3 new columns, 1 changed step"), and how many of
 * the customer's own changes it keeps. The items stay behind a disclosure.
 */
export function recordChanges(record: PlanRecord): {
  template: { topic: ChangeTopic; change: PlanItem["change"]; count: number }[];
  kept: number;
} {
  const counts = new Map<string, number>();
  for (const item of record.items)
    if (item.outcome === "template") {
      const key = `${changeTopic(item)}:${item.change}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  const template = TOPIC_ORDER.flatMap((topic) =>
    CHANGE_ORDER.flatMap((change) => {
      const count = counts.get(`${topic}:${change}`) ?? 0;
      return count ? [{ topic, change, count }] : [];
    }),
  );
  return {
    template,
    kept: record.items.filter((item) => item.outcome === "customer").length,
  };
}

/**
 * Lines that read the same, once each with how often they occur: two
 * steps that both add "Rating country" are one line, "×2".
 */
export function distinctLines(
  lines: readonly string[],
): { text: string; count: number }[] {
  const seen = new Map<string, number>();
  for (const line of lines) seen.set(line, (seen.get(line) ?? 0) + 1);
  return [...seen].map(([text, count]) => ({ text, count }));
}

/** Why a customer is asked about an item. */
export type Why =
  | { kind: "removedDataset"; dataset: string | null }
  | { kind: "both" | "templateRemoved" | "customerRemoved" | "bothAdded" }
  | { kind: "proposeRemoval" };
export function whyAsked(item: PlanItem, plan: StoreTemplatePlan): Why {
  if (item.outcome === "propose_removal") return { kind: "proposeRemoval" };
  if (item.reason === "reads_removed_dataset")
    return {
      kind: "removedDataset",
      dataset: item.dataset ? datasetName(item.dataset, plan) : null,
    };
  const o = item.original !== undefined,
    c = item.current !== undefined,
    n = item.next !== undefined;
  if (o && c && !n) return { kind: "templateRemoved" };
  if (o && !c && n) return { kind: "customerRemoved" };
  if (!o && c && n) return { kind: "bothAdded" };
  return { kind: "both" };
}
/** `ref:<key>[:<output>]` as a record name of the plan, when it has one. */
function datasetName(symbolic: string, plan: StoreTemplatePlan) {
  if (!symbolic.startsWith("ref:")) return null;
  const rest = symbolic.slice("ref:".length);
  const record = plan.records.find(
    (candidate) =>
      rest === candidate.key || rest.startsWith(candidate.key + ":"),
  );
  return record?.name ?? null;
}

/** What an item is, from its value; never its raw JSON. */
export type ItemSubject =
  | { kind: "measure"; name: string; how: MeasureHow }
  | { kind: "dimension"; name: string }
  | { kind: "step"; type: string; name: string | null }
  | { kind: "output"; name: string }
  | { kind: "relationship" }
  | { kind: "widget"; type: string; title: string | null }
  | { kind: "filter"; name: string }
  | { kind: "slide"; name: string | null }
  | { kind: "setting"; name: string };
export type MeasureHow =
  | { kind: "aggregate"; op: string }
  | { kind: "formula" | "rolling" | "period_offset" | "other" };

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const field = (value: unknown, name: string): unknown =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[name]
    : undefined;

/** The item kind and id of a ref (`<record>#<kind>:<id>`). */
export function refParts(ref: string): { kind: string; id: string } {
  const item = ref.slice(ref.indexOf("#") + 1),
    cut = item.indexOf(":");
  return { kind: item.slice(0, cut), id: item.slice(cut + 1) };
}

export function itemSubject(ref: string, value: unknown): ItemSubject {
  const { kind, id } = refParts(ref);
  switch (kind) {
    case "measure": {
      const measureKind = text(field(value, "kind"));
      const op = text(field(field(value, "aggregate"), "op"));
      return {
        kind: "measure",
        name: text(field(value, "name")) ?? id,
        how:
          measureKind === "aggregate" && op
            ? { kind: "aggregate", op }
            : measureKind === "formula" ||
                measureKind === "rolling" ||
                measureKind === "period_offset"
              ? { kind: measureKind }
              : { kind: "other" },
      };
    }
    case "dimension":
      return { kind: "dimension", name: text(field(value, "name")) ?? id };
    case "step":
      return {
        kind: "step",
        type: text(field(value, "type")) ?? "step",
        name: text(field(value, "name")),
      };
    case "output":
      return { kind: "output", name: text(value) ?? id };
    case "relationship":
      return { kind: "relationship" };
    case "widget":
      return {
        kind: "widget",
        type: text(field(value, "type")) ?? "widget",
        title: text(field(value, "title")),
      };
    case "filter":
      return { kind: "filter", name: text(field(value, "name")) ?? id };
    case "slide":
      return { kind: "slide", name: text(field(value, "name")) };
    default:
      return { kind: "setting", name: id };
  }
}

/** The value an item is best named by: the template's, else the customer's. */
export const itemValue = (item: PlanItem) =>
  item.next ?? item.current ?? item.original;

/**
 * Widget names for refs an error lists (`store_update_unmergeable`), from
 * the plan where it knows them; otherwise the template's widget key.
 */
export function widgetNames(
  refs: readonly string[],
  plan: StoreTemplatePlan | null,
): string[] {
  const items = new Map(
    (plan?.records ?? []).flatMap((record) =>
      record.items.map((item) => [item.ref, item] as const),
    ),
  );
  return refs.map((ref) => {
    const item = items.get(ref);
    const subject = itemSubject(ref, item ? itemValue(item) : undefined);
    if (subject.kind === "widget" && subject.title) return subject.title;
    if ("name" in subject && subject.name) return subject.name;
    return refParts(ref).id;
  });
}

/** Screens (not revoked) that show a dashboard: the ones a swap moves. */
export function screensOn(
  devices: readonly Pick<Device, "id" | "name" | "dashboardId" | "revokedAt">[],
  dashboardId: string | null,
): string[] {
  return devices
    .filter((device) => device.dashboardId === dashboardId && !device.revokedAt)
    .map((device) => device.name);
}

/**
 * The step an applied update is at: 2 publish the drafts, 3 create the
 * copy, 5 swap (comparing, 4, is done once a copy exists), 6 all done.
 */
export function progressStep(update: StoreTemplateUpdate): number {
  if (update.drafts.some((draft) => !draft.published)) return 2;
  if (update.dashboards.some((entry) => entry.copyId === null)) return 3;
  if (update.dashboards.some((entry) => swapState(entry) !== "swapped"))
    return 5;
  return 6;
}

/**
 * What the Studio says about a dashboard of a store-template install: an
 * update is available, it is an update's copy not yet on the screens, it
 * is an archived original (read-only until switched back), or a copy
 * archived by switching back.
 */
export function studioUpdateNote(
  installs: readonly StoreInstall[],
  dashboard: { id: string; archivedAt: string | null },
): {
  kind: "available" | "copy" | "archived" | "archivedCopy";
  requestId: string;
} | null {
  const update = updateOfDashboard(installs, dashboard.id);
  if (dashboard.archivedAt !== null)
    return update
      ? {
          // The original while the copy is on the screens, or the copy
          // after switching back.
          kind:
            update.entry.originalId === dashboard.id
              ? "archived"
              : "archivedCopy",
          requestId: update.install.requestId,
        }
      : null;
  if (
    update &&
    update.entry.copyId === dashboard.id &&
    swapState(update.entry) !== "swapped"
  )
    return { kind: "copy", requestId: update.install.requestId };
  const offered = installWithUpdate(installs, dashboard.id);
  return offered ? { kind: "available", requestId: offered.requestId } : null;
}

/**
 * An archived original is read-only until it is switched back (11E): the
 * Studio sends it to the dashboard's view page, which says so and links to
 * the update. Null for every other dashboard.
 */
export function studioViewOnlyPath(
  workspaceId: string,
  dashboard: { id: string; archivedAt: string | null },
): string | null {
  return dashboard.archivedAt === null
    ? null
    : `/workspaces/${workspaceId}/dashboards/${dashboard.id}`;
}

/** A dashboard of an update: on the copy now, or back on the original. */
export function swapState(
  entry: UpdateDashboard,
): "notSwapped" | "swapped" | "swappedBack" {
  if (entry.swappedAt === null) return "notSwapped";
  return entry.swappedBackAt === null ? "swapped" : "swappedBack";
}
