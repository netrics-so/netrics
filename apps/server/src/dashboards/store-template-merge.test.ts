import { describe, expect, it } from "vitest";
import type { ItemRef, Items } from "./store-template-items.js";
import {
  classify,
  merge,
  MergeDecisionMissing,
  summarize,
  type Outcome,
} from "./store-template-merge.js";

const REF: ItemRef = "model:downloads#measure:downloads";
const SCOPE: ItemRef = "dashboard:portfolio#filter:app.fixedValue";
const items = (entries: [ItemRef, unknown][]): Items => new Map(entries);
const one = (ref: ItemRef, value: unknown): Items =>
  value === undefined ? new Map() : new Map([[ref, value]]);

const a = { name: "A" },
  b = { name: "B" },
  c = { name: "C" };

describe("three-way store-template comparison", () => {
  it.each<
    [
      string,
      unknown,
      unknown,
      unknown,
      Outcome,
      "added" | "changed" | "removed" | null,
    ]
  >([
    ["template changed, customer did not", a, a, b, "template", "changed"],
    ["customer changed, template did not", a, c, a, "customer", "changed"],
    ["both changed differently", a, c, b, "choose", "changed"],
    ["both changed the same way", a, c, c, "unchanged", null],
    ["template added", undefined, undefined, b, "template", "added"],
    ["customer added", undefined, c, undefined, "customer", "added"],
    ["template removed", a, a, undefined, "propose_removal", "removed"],
    [
      "template removed what the customer changed",
      a,
      c,
      undefined,
      "choose",
      "removed",
    ],
    [
      "customer removed what the template changed",
      a,
      undefined,
      b,
      "choose",
      "changed",
    ],
    [
      "customer removed, template unchanged",
      a,
      undefined,
      a,
      "unchanged",
      null,
    ],
    ["both removed", a, undefined, undefined, "unchanged", null],
    ["nothing changed", a, a, a, "unchanged", null],
  ])("%s", (_name, original, current, next, outcome, change) => {
    const plan = classify(
      one(REF, original),
      one(REF, current),
      one(REF, next),
    );
    if (outcome === "unchanged") expect(plan).toEqual([]);
    else
      expect(plan).toEqual([
        expect.objectContaining({ ref: REF, outcome, change }),
      ]);
  });
  it.each([
    [a, a, b],
    [a, c, b],
    [undefined, c, b],
    [a, c, undefined],
  ])(
    "takes app-scope parts from the template, never as a conflict",
    (o, c2, n) => {
      const plan = classify(one(SCOPE, o), one(SCOPE, c2), one(SCOPE, n));
      expect(plan.map((item) => item.outcome)).toEqual(["scope"]);
      expect(
        merge(one(SCOPE, o), one(SCOPE, c2), one(SCOPE, n), []).get(SCOPE),
      ).toEqual(n);
    },
  );
  it("treats a connection's source preparation coming or going as scope", () => {
    const step: ItemRef = "preparation:source:x:downloads#step:raw";
    expect(classify(new Map(), new Map(), one(step, a))[0]!.outcome).toBe(
      "scope",
    );
    expect(classify(one(step, a), one(step, c), new Map())[0]!.outcome).toBe(
      "scope",
    );
    // Within a source preparation that stays, steps are ordinary items.
    const other: ItemRef = "preparation:source:x:downloads#step:output";
    expect(
      classify(
        items([[other, a]]),
        items([[other, a]]),
        items([
          [other, a],
          [step, b],
        ]),
      )[0]!.outcome,
    ).toBe("template");
  });
  it("proposes a source preparation the new version stops building for a connection that stays", () => {
    // Connection x stays (its downloads preparation is in every state); the
    // new version no longer builds x's ratings preparation.
    const kept: ItemRef = "preparation:source:x:downloads#step:raw";
    const dropped: ItemRef = "preparation:source:x:ratings#step:raw";
    const states = (current: unknown) =>
      [
        items([
          [kept, a],
          [dropped, a],
        ]),
        items([
          [kept, a],
          ...(current === undefined ? [] : [[dropped, current]]),
        ] as [ItemRef, unknown][]),
        items([[kept, a]]),
      ] as const;
    expect(classify(...states(a))).toEqual([
      expect.objectContaining({ ref: dropped, outcome: "propose_removal" }),
    ]);
    expect(classify(...states(c))).toEqual([
      expect.objectContaining({ ref: dropped, outcome: "choose" }),
    ]);
    expect(() => merge(...states(a), [])).toThrow(MergeDecisionMissing);
    // The template adds a preparation for a connection that stays.
    const added: ItemRef = "preparation:source:x:installs#step:raw";
    expect(
      classify(
        items([[kept, a]]),
        items([[kept, a]]),
        items([
          [kept, a],
          [added, b],
        ]),
      ),
    ).toEqual([expect.objectContaining({ ref: added, outcome: "template" })]);
    const [o, , n] = states(a);
    expect(summarize(o, n, classify(...states(a))).steps).toEqual({
      added: 0,
      changed: 0,
      removed: 1,
    });
  });
  it("asks before replacing an append preparation the customer edited", () => {
    const step: ItemRef = "preparation:append:downloads:0:0#step:append_0_0";
    // Not edited: the template's (app-scope) value, no question.
    expect(classify(one(step, a), one(step, a), one(step, b))[0]!.outcome).toBe(
      "scope",
    );
    // Edited by the customer: their choice, theirs unless they pick the template.
    for (const next of [b, undefined])
      expect(
        classify(one(step, a), one(step, c), one(step, next))[0]!.outcome,
      ).toBe("choose");
    expect(classify(one(step, a), one(step, c), one(step, c))).toEqual([]);
    expect(
      merge(one(step, a), one(step, c), one(step, b), [
        { ref: step, choice: "customer" },
      ]).get(step),
    ).toEqual(c);
    expect(() => merge(one(step, a), one(step, c), one(step, b), [])).toThrow(
      MergeDecisionMissing,
    );
  });
  it("merges per outcome and decision", () => {
    const ref2: ItemRef = "model:downloads#measure:extra";
    const ref3: ItemRef = "model:downloads#measure:gone";
    const ref4: ItemRef = "model:downloads#measure:mine";
    const original = items([
        [REF, a],
        [ref2, a],
        [ref3, a],
      ]),
      current = items([
        [REF, c],
        [ref2, a],
        [ref3, a],
        [ref4, c],
      ]),
      next = items([
        [REF, b],
        [ref2, b],
      ]);
    expect(
      merge(original, current, next, [
        { ref: REF, choice: "customer" },
        { ref: ref3, choice: "keep" },
      ]),
    ).toEqual(
      items([
        [REF, c],
        [ref2, b],
        [ref3, a],
        [ref4, c],
      ]),
    );
    expect(
      merge(original, current, next, [
        { ref: REF, choice: "template" },
        { ref: ref3, choice: "remove" },
      ]),
    ).toEqual(
      items([
        [REF, b],
        [ref2, b],
        [ref4, c],
      ]),
    );
  });
  it("asks before a template value adds back a dataset the customer removed", () => {
    const datasets: ItemRef = "model:downloads#settings:datasets",
      changed: ItemRef = "model:downloads#measure:downloads",
      added: ItemRef = "model:downloads#measure:extra";
    const measure = (name: string, slot: number) => ({
      name,
      datasetId: `datasets[${slot}]`,
    });
    // The customer removed A (B moved to its place); the template changes
    // the measure on A and adds one on A.
    const original = items([
      [datasets, ["ref:a", "ref:b"]],
      [changed, measure("Downloads", 0)],
    ]);
    const current = items([
      [datasets, ["ref:b"]],
      [changed, measure("Downloads", 0)],
    ]);
    const next = items([
      [datasets, ["ref:a", "ref:b"]],
      [changed, measure("Downloads (v2)", 0)],
      [added, measure("Extra", 0)],
    ]);
    const outcomes = (o: Items, c: Items, n: Items) =>
      Object.fromEntries(
        classify(o, c, n)
          .filter((i) => i.ref !== datasets)
          .map((i) => [i.ref, [i.outcome, i.change]]),
      );
    expect(outcomes(original, current, next)).toEqual({
      [changed]: ["choose", "changed"],
      [added]: ["choose", "added"],
    });
    // Replaced instead (their own dataset at A's position): the template's
    // values read the replacement, nothing to ask.
    const replaced = items([
      [datasets, ["mine", "ref:b"]],
      [changed, measure("Downloads", 0)],
    ]);
    expect(outcomes(original, replaced, next)).toEqual({
      [changed]: ["template", "changed"],
      [added]: ["template", "added"],
    });
    const decide = (choice: "template" | "customer") =>
      merge(original, current, next, [
        { ref: changed, choice },
        { ref: added, choice },
      ]);
    expect(decide("customer").get(changed)).toEqual(measure("Downloads", 0));
    expect(decide("customer").has(added)).toBe(false);
    expect(decide("template").get(added)).toEqual(measure("Extra", 0));
    // The plan says which dataset taking the template's value brings back.
    expect(
      classify(original, current, next).find((i) => i.ref === added),
    ).toMatchObject({ reason: "reads_removed_dataset", dataset: "ref:a" });
    expect(
      classify(original, replaced, next).find((i) => i.ref === added),
    ).not.toHaveProperty("reason");
    // Two datasets of their own in place of one: unclear, so they choose.
    const two = items([
      [datasets, ["mine", "theirs"]],
      [changed, measure("Downloads", 0)],
    ]);
    const single = items([
      [datasets, ["ref:a"]],
      [changed, measure("Downloads", 0)],
    ]);
    const singleNext = items([
      [datasets, ["ref:a"]],
      [changed, measure("Downloads (v2)", 0)],
    ]);
    expect(
      classify(single, two, singleNext).find((i) => i.ref === changed),
    ).toMatchObject({ outcome: "choose", dataset: "ref:a" });
  });

  it("shows a model's datasets as the update writes them", () => {
    const datasets: ItemRef = "model:downloads#settings:datasets";
    // The template moves to B; the customer's own M stays.
    const plan = classify(
      items([[datasets, ["ref:a"]]]),
      items([[datasets, ["ref:a", "mine"]]]),
      items([[datasets, ["ref:b"]]]),
    );
    expect(plan).toEqual([
      expect.objectContaining({
        ref: datasets,
        outcome: "scope",
        next: ["ref:b", "mine"],
      }),
    ]);
    expect(
      merge(
        items([[datasets, ["ref:a"]]]),
        items([[datasets, ["ref:a", "mine"]]]),
        items([[datasets, ["ref:b"]]]),
        [],
      ).get(datasets),
    ).toEqual(["ref:b", "mine"]);
    // Nothing changes when the customer only added their own dataset.
    expect(
      classify(
        items([[datasets, ["ref:a"]]]),
        items([[datasets, ["ref:a", "mine"]]]),
        items([[datasets, ["ref:a"]]]),
      ),
    ).toEqual([]);
  });

  it("refuses to merge with an undecided conflict", () => {
    const o = one(REF, a),
      c2 = one(REF, c),
      n = one(REF, b);
    expect(() => merge(o, c2, n, [])).toThrow(MergeDecisionMissing);
    try {
      merge(o, c2, n, []);
    } catch (error) {
      expect((error as MergeDecisionMissing).refs).toEqual([REF]);
    }
    // A choice that does not answer the question is not a decision.
    expect(() => merge(o, c2, n, [{ ref: REF, choice: "keep" }])).toThrow(
      MergeDecisionMissing,
    );
  });
  it("never removes an item without a decision", () => {
    const o = one(REF, a),
      n = new Map() as Items;
    expect(() => merge(o, o, n, [])).toThrow(MergeDecisionMissing);
    expect(merge(o, o, n, [{ ref: REF, choice: "keep" }]).get(REF)).toEqual(a);
    expect(merge(o, o, n, [{ ref: REF, choice: "remove" }]).has(REF)).toBe(
      false,
    );
  });
  it("counts added, changed and removed measures, steps and widgets of the template", () => {
    const original = items([
      ["model:downloads#measure:downloads", a],
      ["model:downloads#measure:old", a],
      ["preparation:source:x:downloads#step:calculate_store_name", a],
      ["preparation:append:downloads:0:0#step:input_0", a],
      ["dashboard:portfolio#widget:ratings", a],
      ["dashboard:portfolio#widget:downloads", a],
    ]);
    // The customer's own edits are not the template's changes.
    const current = items([
      ...original,
      ["model:downloads#measure:mine", c],
      ["dashboard:portfolio#widget:custom:1", c],
    ] as [ItemRef, unknown][]);
    current.set("dashboard:portfolio#widget:downloads", c);
    const next = items([
      ["model:downloads#measure:downloads", b],
      ["model:downloads#measure:downloads_avg", b],
      ["preparation:source:x:downloads#step:calculate_store_name", b],
      ["preparation:append:downloads:0:0#step:input_0", a],
      ["preparation:append:downloads:0:0#step:input_1", a],
      ["dashboard:portfolio#widget:summary", b],
      ["dashboard:portfolio#widget:downloads", b],
    ]);
    const plan = classify(original, current, next);
    expect(summarize(original, next, plan)).toEqual({
      measures: { added: 1, changed: 1, removed: 1 },
      steps: { added: 0, changed: 1, removed: 0 },
      widgets: { added: 1, changed: 1, removed: 1 },
      conflicts: 1,
      removals: 2,
    });
  });
});
