// The state widget's fixed set of states (#875, ADR 0019 section 15): a
// service, server, deployment or health check is up, down, failed,
// building, sleeping or unknown, whatever word its source uses. Sources
// keep their own values in datasets and preparations; the widget maps them
// here, with built-in words and the widget's own overrides, so every
// client draws the same seven-word vocabulary.

/** Every normalized state, in the order the Studio lists them. */
export const SERVICE_STATES = [
  "up",
  "down",
  "failed",
  "building",
  "sleeping",
  "unknown",
] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

/** A source value a widget's override maps; at most this many per widget. */
export const SERVICE_STATE_OVERRIDES_MAX = 30;
/** An override's source value is at most this long (after trimming). */
export const SERVICE_STATE_VALUE_MAX = 60;

/**
 * Words the widget understands without an override, lower case. The
 * connectors' own state fields (Railway, Hetzner Cloud, Vercel) already use
 * the normalized words; the synonyms cover custom APIs and raw provider
 * statuses (Hetzner `running`, Railway `SUCCESS`, Vercel `READY`).
 */
const BUILT_IN: Readonly<Record<string, ServiceState>> = Object.freeze({
  up: "up",
  ok: "up",
  running: "up",
  healthy: "up",
  success: "up",
  ready: "up",
  active: "up",
  online: "up",
  operational: "up",
  live: "up",
  pass: "up",
  passing: "up",
  down: "down",
  offline: "down",
  stopped: "down",
  off: "down",
  removed: "down",
  deleted: "down",
  unhealthy: "down",
  unreachable: "down",
  outage: "down",
  failed: "failed",
  failure: "failed",
  fail: "failed",
  error: "failed",
  errored: "failed",
  crashed: "failed",
  building: "building",
  deploying: "building",
  queued: "building",
  initializing: "building",
  starting: "building",
  pending: "building",
  in_progress: "building",
  rebuilding: "building",
  migrating: "building",
  sleeping: "sleeping",
  paused: "sleeping",
  idle: "sleeping",
  suspended: "sleeping",
  unknown: "unknown",
});

/** A source value as an override key: trimmed, lower case, spaces and
 * dashes as underscores ("In progress" → "in_progress"). */
export function serviceStateKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * The one normalization of a widget's source values (#900): a function
 * that reads a value as one of the fixed states, its overrides keyed once
 * (`serviceStateKey`), so ranking, counting and the Studio's discovery
 * classify every value alike and no value rescans the overrides. Type
 * aware: a boolean reads as a health flag (true up, false down, unless an
 * override keys "true" or "false"); text and numbers by their key, the
 * widget's override first, then the built-in words, else `unknown` (the
 * text "true" is no built-in word). Null and anything else is unknown.
 */
export function serviceStateClassifier(
  overrides: Readonly<Record<string, ServiceState>> = {},
): (value: unknown) => ServiceState {
  const mapped = new Map<string, ServiceState>();
  for (const [raw, state] of Object.entries(overrides)) {
    const key = serviceStateKey(raw);
    // The first override of a key wins.
    if (key !== "" && !mapped.has(key)) mapped.set(key, state);
  }
  return (value) => {
    if (typeof value === "boolean")
      return mapped.get(String(value)) ?? (value ? "up" : "down");
    if (typeof value !== "string" && typeof value !== "number")
      return "unknown";
    const key = serviceStateKey(String(value));
    if (key === "") return "unknown";
    return (
      mapped.get(key) ??
      (Object.hasOwn(BUILT_IN, key) ? BUILT_IN[key]! : "unknown")
    );
  };
}

/**
 * A source value as one of the fixed states (`serviceStateClassifier`):
 * the widget's override for it first (keys compared as `serviceStateKey`),
 * then the built-in words, then `unknown`. Booleans read as a health flag
 * (true up, false down); null and anything else is unknown.
 */
export function normalizeServiceState(
  value: unknown,
  overrides: Readonly<Record<string, ServiceState>> = {},
): ServiceState {
  return serviceStateClassifier(overrides)(value);
}

/**
 * The rank tiers a query sorts by, most urgent first (`serviceStateRank`):
 * a rollback is a tier of its own between sleeping and a plain up.
 */
export const SERVICE_STATE_TIERS: ReadonlyArray<{
  state: ServiceState;
  rolledBack: boolean;
}> = [
  { state: "down", rolledBack: false },
  { state: "failed", rolledBack: false },
  { state: "unknown", rolledBack: false },
  { state: "building", rolledBack: false },
  { state: "sleeping", rolledBack: false },
  { state: "up", rolledBack: true },
  { state: "up", rolledBack: false },
];

/** True when the built-in words alone map the value (no override needed). */
export function isKnownServiceStateValue(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value !== "string" && typeof value !== "number") return false;
  return Object.hasOwn(BUILT_IN, serviceStateKey(String(value)));
}

/**
 * True for a source value an override can key in full (#875, #900): text
 * or a number no built-in word knows, its key not empty and at most
 * `SERVICE_STATE_VALUE_MAX` characters as stored. The Studio's discovery
 * lists only these; longer ones stay unknown.
 */
export function isMappableServiceStateValue(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const text = String(value);
  return (
    [...text].length <= SERVICE_STATE_VALUE_MAX &&
    serviceStateKey(text) !== "" &&
    !isKnownServiceStateValue(text)
  );
}

/**
 * How urgent a state is, lower first: down and failed, then unknown,
 * building and sleeping, then up after a rollback, then up. A list shows
 * everything not healthy before the rest, so a problem is never the row
 * "+N more" hides.
 */
export function serviceStateRank(
  state: ServiceState,
  rolledBack = false,
): number {
  switch (state) {
    case "down":
      return 0;
    case "failed":
      return 1;
    case "unknown":
      return 2;
    case "building":
      return 3;
    case "sleeping":
      return 4;
    case "up":
      return rolledBack ? 5 : 6;
  }
}

/** True for every state but a plain up (a rollback asks for attention). */
export function isServiceStateHealthy(
  state: ServiceState,
  rolledBack = false,
): boolean {
  return state === "up" && !rolledBack;
}

/**
 * The theme colour a state is drawn in, always next to its word and icon
 * (never colour alone): `up` for up, `down` for down and failed, `warning`
 * for up after a rollback and for unknown, `muted` for building and
 * sleeping.
 */
export type ServiceStateTone = "up" | "down" | "warning" | "muted";
export function serviceStateTone(
  state: ServiceState,
  rolledBack = false,
): ServiceStateTone {
  switch (state) {
    case "up":
      return rolledBack ? "warning" : "up";
    case "down":
    case "failed":
      return "down";
    case "unknown":
      return "warning";
    case "building":
    case "sleeping":
      return "muted";
  }
}

/**
 * The shape drawn beside a state's word, so it reads without colour:
 * a check (up), a cross (down), an exclamation mark (failed), a
 * circular arrow (building), a moon (sleeping), a question mark
 * (unknown). Clients map each to their own glyph.
 */
export type ServiceStateIcon =
  "check" | "cross" | "exclamation" | "arrows" | "moon" | "question";
export function serviceStateIcon(state: ServiceState): ServiceStateIcon {
  switch (state) {
    case "up":
      return "check";
    case "down":
      return "cross";
    case "failed":
      return "exclamation";
    case "building":
      return "arrows";
    case "sleeping":
      return "moon";
    case "unknown":
      return "question";
  }
}

export interface ServiceStateItem {
  name: string | null;
  state: ServiceState;
  rolledBack: boolean;
}

/**
 * Items in display order: by `serviceStateRank`, then by name (case
 * insensitive, then exactly; nameless last), so the order is the same on
 * every client and every run. Returns a new array.
 */
export function sortServiceStateItems<T extends ServiceStateItem>(
  items: readonly T[],
): T[] {
  const name = (item: T) => item.name ?? "";
  return [...items].sort((a, b) => {
    const rank =
      serviceStateRank(a.state, a.rolledBack) -
      serviceStateRank(b.state, b.rolledBack);
    if (rank !== 0) return rank;
    if ((a.name === null) !== (b.name === null))
      return a.name === null ? 1 : -1;
    const left = name(a).toLowerCase();
    const right = name(b).toLowerCase();
    if (left !== right) return left < right ? -1 : 1;
    return name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0;
  });
}

/**
 * How many rows a list shows and what "+N more" says: all items when they
 * fit in `capacity` rows, else `capacity - 1` items and a last row "+N
 * more" (N counts the rows hidden here and the items the server left out
 * beyond its limit, `total - items.length`). Capacity 0 shows nothing.
 */
export function serviceStateRowsShown(
  shownItems: number,
  total: number,
  capacity: number,
): { rows: number; more: number } {
  const all = Math.max(total, shownItems);
  if (capacity <= 0) return { rows: 0, more: 0 };
  if (all <= capacity && shownItems === all)
    return { rows: shownItems, more: 0 };
  const rows = Math.min(shownItems, capacity - 1);
  return { rows, more: all - rows };
}

/** Items per state over every matching item; `rolledBack` counts the ups
 * with the qualifier (they are in `up` too). */
export type ServiceStateCounts = Record<ServiceState, number> & {
  rolledBack: number;
};

export function serviceStateCounts(
  items: readonly Pick<ServiceStateItem, "state" | "rolledBack">[],
): ServiceStateCounts {
  const counts: ServiceStateCounts = {
    up: 0,
    down: 0,
    failed: 0,
    building: 0,
    sleeping: 0,
    unknown: 0,
    rolledBack: 0,
  };
  for (const item of items) {
    counts[item.state] += 1;
    if (item.state === "up" && item.rolledBack) counts.rolledBack += 1;
  }
  return counts;
}

/** Every state from the most to the least urgent, a rollback as its own. */
const URGENCY: ReadonlyArray<{ state: ServiceState; rolledBack: boolean }> = [
  ...SERVICE_STATES.filter((state) => state !== "up").map((state) => ({
    state,
    rolledBack: false,
  })),
  { state: "up" as const, rolledBack: true },
  { state: "up" as const, rolledBack: false },
].sort(
  (a, b) =>
    serviceStateRank(a.state, a.rolledBack) -
    serviceStateRank(b.state, b.rolledBack),
);

const countOf = (
  counts: ServiceStateCounts,
  state: ServiceState,
  rolledBack: boolean,
) =>
  state === "up"
    ? rolledBack
      ? counts.rolledBack
      : counts.up - counts.rolledBack
    : counts[state];

/**
 * The single form's summary when no item is chosen (owner decision on
 * #875): "All 5 up" when everything is up without a rollback, else the
 * most urgent state and how many items are in it ("2 of 5 down"); null
 * without items.
 */
export type ServiceStateSummary =
  | { kind: "all_up"; total: number }
  | {
      kind: "worst";
      state: ServiceState;
      rolledBack: boolean;
      count: number;
      total: number;
    };
export function serviceStateSummary(
  counts: ServiceStateCounts,
): ServiceStateSummary | null {
  const total = SERVICE_STATES.reduce((sum, state) => sum + counts[state], 0);
  if (total === 0) return null;
  const worst = URGENCY.find(
    (entry) => countOf(counts, entry.state, entry.rolledBack) > 0,
  )!;
  if (worst.state === "up" && !worst.rolledBack)
    return { kind: "all_up", total };
  return {
    kind: "worst",
    state: worst.state,
    rolledBack: worst.rolledBack,
    count: countOf(counts, worst.state, worst.rolledBack),
    total,
  };
}

/**
 * The tone of "+N more": the most urgent of the items not shown (every
 * matching item's `counts` less the `shown` ones), so an outage the server
 * left out still colours the row; null when nothing is hidden.
 */
export function serviceStateHiddenTone(
  counts: ServiceStateCounts,
  shown: readonly Pick<ServiceStateItem, "state" | "rolledBack">[],
): ServiceStateTone | null {
  const seen = serviceStateCounts(shown);
  const left: ServiceStateCounts = { ...counts };
  for (const key of Object.keys(left) as (keyof ServiceStateCounts)[])
    left[key] = Math.max(0, counts[key] - seen[key]);
  const worst = URGENCY.find(
    (entry) => countOf(left, entry.state, entry.rolledBack) > 0,
  );
  return worst ? serviceStateTone(worst.state, worst.rolledBack) : null;
}
