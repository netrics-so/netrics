import {
  isScopeItem,
  itemKindOf,
  recordKeyOf,
  type ItemRef,
  type Items,
} from "./store-template-items.js";

/**
 * Three-way comparison of store-template items (template updates, 11E):
 * original template, customer's current record, new template. Pure.
 */
export type Outcome =
  | "unchanged"
  | "template"
  | "customer"
  | "choose"
  | "propose_removal"
  | "scope";
export interface PlanItem {
  ref: ItemRef;
  change: "added" | "changed" | "removed";
  outcome: Outcome;
  original?: unknown;
  current?: unknown;
  next?: unknown;
}
export type Decision = {
  ref: ItemRef;
  choice: "template" | "customer" | "remove" | "keep";
};
export type Counts = { added: number; changed: number; removed: number };
export interface UpdateSummary {
  measures: Counts;
  steps: Counts;
  widgets: Counts;
  conflicts: number;
  removals: number;
}

export class MergeDecisionMissing extends Error {
  constructor(readonly refs: ItemRef[]) {
    super("store_update_decision_missing");
  }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The connection of a `preparation:source:<connectionId>:<metric>` item. */
function sourceConnection(ref: string): string | undefined {
  const key = recordKeyOf(ref);
  return key.startsWith("preparation:source:") ? key.split(":")[2] : undefined;
}
function connections(...sets: Items[]): Set<string> {
  const ids = new Set<string>();
  for (const items of sets)
    for (const ref of items.keys()) {
      const id = sourceConnection(ref);
      if (id !== undefined) ids.add(id);
    }
  return ids;
}

/**
 * Scope by item (isScopeItem), or an item of a per-connection source
 * preparation whose connection the install gained or lost (in one state and
 * not the other): app scope, not a template change. A source preparation a
 * new version adds or stops building for a connection that stays is an
 * ordinary template change (added, or proposed for removal).
 */
function scopeTest(original: Items, current: Items, next: Items) {
  const before = connections(original, current),
    after = connections(next);
  return (ref: ItemRef) => {
    if (isScopeItem(ref)) return true;
    const id = sourceConnection(ref);
    return id !== undefined && before.has(id) !== after.has(id);
  };
}

function outcomeOf(
  original: unknown,
  current: unknown,
  next: unknown,
): { outcome: Outcome; change?: PlanItem["change"] } {
  const o = original !== undefined,
    c = current !== undefined,
    n = next !== undefined;
  if (o && c && n) {
    if (same(current, original))
      return same(next, original)
        ? { outcome: "unchanged" }
        : { outcome: "template", change: "changed" };
    if (same(next, original)) return { outcome: "customer", change: "changed" };
    if (same(next, current)) return { outcome: "unchanged" };
    return { outcome: "choose", change: "changed" };
  }
  if (o && c)
    return same(current, original)
      ? { outcome: "propose_removal", change: "removed" }
      : { outcome: "choose", change: "removed" };
  if (o && n)
    return same(next, original)
      ? { outcome: "unchanged" }
      : { outcome: "choose", change: "changed" };
  if (o) return { outcome: "unchanged" };
  if (c && n)
    return same(current, next)
      ? { outcome: "unchanged" }
      : { outcome: "choose", change: "added" };
  if (n) return { outcome: "template", change: "added" };
  if (c) return { outcome: "customer", change: "added" };
  return { outcome: "unchanged" };
}

function refsOf(...sets: Items[]): ItemRef[] {
  const refs = new Set<ItemRef>();
  for (const items of sets) for (const ref of items.keys()) refs.add(ref);
  return [...refs].sort();
}

/** Every item that is not unchanged, by ref. */
export function classify(
  original: Items,
  current: Items,
  next: Items,
): PlanItem[] {
  const scope = scopeTest(original, current, next);
  const plan: PlanItem[] = [];
  for (const ref of refsOf(original, current, next)) {
    const o = original.get(ref),
      c = current.get(ref),
      n = next.get(ref);
    const values = {
      ...(o === undefined ? {} : { original: o }),
      ...(c === undefined ? {} : { current: c }),
      ...(n === undefined ? {} : { next: n }),
    };
    if (scope(ref)) {
      if (same(c, n)) continue;
      // An append preparation is regenerated from the app scope, but a part
      // the customer edited stays theirs until they pick the template's.
      const edited =
        recordKeyOf(ref).startsWith("preparation:append:") && !same(c, o);
      plan.push({
        ref,
        change:
          c === undefined ? "added" : n === undefined ? "removed" : "changed",
        outcome: edited ? "choose" : "scope",
        ...values,
      });
      continue;
    }
    const { outcome, change } = outcomeOf(o, c, n);
    if (outcome === "unchanged") continue;
    plan.push({ ref, change: change!, outcome, ...values });
  }
  return plan;
}

/**
 * The merged items: `template` and `scope` take the new template's value,
 * `customer` and unchanged items the current one; `choose` and
 * `propose_removal` follow the decision. Throws MergeDecisionMissing (with
 * every such ref) when one has no fitting decision.
 */
export function merge(
  original: Items,
  current: Items,
  next: Items,
  decisions: Decision[],
): Items {
  const byRef = new Map(decisions.map((d) => [d.ref, d.choice]));
  const plan = new Map(
    classify(original, current, next).map((item) => [item.ref, item]),
  );
  const missing: ItemRef[] = [];
  const merged: Items = new Map();
  for (const ref of refsOf(original, current, next)) {
    const item = plan.get(ref);
    let source: Items = current;
    if (item?.outcome === "template" || item?.outcome === "scope")
      source = next;
    else if (item?.outcome === "choose") {
      const choice = byRef.get(ref);
      if (choice === "template") source = next;
      else if (choice !== "customer") missing.push(ref);
    } else if (item?.outcome === "propose_removal") {
      const choice = byRef.get(ref);
      if (choice === "remove") continue;
      if (choice !== "keep") missing.push(ref);
    }
    if (source.has(ref)) merged.set(ref, source.get(ref));
  }
  if (missing.length) throw new MergeDecisionMissing(missing);
  return merged;
}

const counted = {
  measure: "measures",
  step: "steps",
  widget: "widgets",
} as const;

/**
 * What the new template changes (original → next), not the customer's
 * edits: added, changed and removed measures, steps and widgets, without
 * app-scope parts; plus the plan's conflicts and proposed removals.
 */
export function summarize(
  original: Items,
  next: Items,
  plan: PlanItem[],
): UpdateSummary {
  const summary: UpdateSummary = {
    measures: { added: 0, changed: 0, removed: 0 },
    steps: { added: 0, changed: 0, removed: 0 },
    widgets: { added: 0, changed: 0, removed: 0 },
    conflicts: plan.filter((item) => item.outcome === "choose").length,
    removals: plan.filter((item) => item.outcome === "propose_removal").length,
  };
  const scope = scopeTest(original, original, next);
  for (const ref of refsOf(original, next)) {
    const kind = itemKindOf(ref);
    if (!(kind in counted) || scope(ref)) continue;
    const counts = summary[counted[kind as keyof typeof counted]];
    const o = original.get(ref),
      n = next.get(ref);
    if (o === undefined) counts.added++;
    else if (n === undefined) counts.removed++;
    else if (!same(o, n)) counts.changed++;
  }
  return summary;
}
