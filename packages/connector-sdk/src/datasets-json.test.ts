import { describe, expect, it } from "vitest";

import { datasetRecordSchema } from "./datasets.js";

// #528 rewrote the bounded-JSON check to allocate less. This is the check
// before; both must accept exactly the same values.
function previousIsDataJson(value: unknown): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (++nodes > 10_000 || depth > 8) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean")
      continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (
      typeof item !== "object" ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      return false;
    for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return true;
}
const accepts = (value: unknown) =>
  datasetRecordSchema.safeParse({ values: { field: value } }).success;
const nest = (depth: number): unknown =>
  depth === 0 ? "leaf" : { child: nest(depth - 1) };

describe("bounded JSON values (#528)", () => {
  it("accepts and refuses what the previous check did", () => {
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.a = 1;
    const hidden = {};
    Object.defineProperty(hidden, "x", { value: undefined, enumerable: false });
    const values: unknown[] = [
      null,
      "",
      "text",
      true,
      0,
      -0,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      () => 1,
      Symbol("s"),
      10n,
      new Date(0),
      new Map(),
      [],
      {},
      [1, "a", null, [true]],
      Object.assign(new Array<unknown>(3), { 0: 1, 2: 3 }), // a hole, skipped as Object.values skips it
      [undefined],
      { a: undefined },
      { a: Number.NaN },
      { [Symbol("k")]: undefined, a: 1 },
      hidden,
      nullProto,
      nest(8),
      nest(9),
      Array.from({ length: 9_999 }, () => 1),
      Array.from({ length: 10_000 }, () => 1),
      Array.from({ length: 100 }, () => Array.from({ length: 99 }, () => 1)),
      Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => 1)),
    ];
    for (const value of values)
      expect(accepts(value), String(values.indexOf(value))).toBe(
        previousIsDataJson(value),
      );
  });

  it("agrees on random trees", () => {
    let seed = 528;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const tree = (depth: number): unknown => {
      const kind = Math.floor(random() * 9);
      if (kind === 0) return null;
      if (kind === 1) return random() < 0.1 ? Number.NaN : random();
      if (kind === 2) return "s";
      if (kind === 3) return random() < 0.05 ? undefined : true;
      if (kind === 4 && random() < 0.05) return new Date(0);
      if (depth > 10) return 1;
      if (kind < 7)
        return Array.from({ length: Math.floor(random() * 4) }, () =>
          tree(depth + 1),
        );
      return Object.fromEntries(
        Array.from({ length: Math.floor(random() * 4) }, (_, i) => [
          "k" + i,
          tree(depth + 1),
        ]),
      );
    };
    for (let i = 0; i < 2_000; i++) {
      const value = tree(0);
      expect(accepts(value)).toBe(previousIsDataJson(value));
    }
  });
});
