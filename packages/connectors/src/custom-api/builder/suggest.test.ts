import { describe, expect, it } from "vitest";

import {
  fieldIdFromPath,
  findRecordArrays,
  readPath,
  suggestFields,
  type FieldSuggestion,
} from "./suggest.js";

// Builder suggestions (#806): record arrays and typed fields from the first
// records of a test response.

const byPath = (suggestions: FieldSuggestion[]) =>
  Object.fromEntries(suggestions.map((s) => [s.path, s])) as Record<
    string,
    FieldSuggestion
  >;
const ids = (suggestions: FieldSuggestion[]) => suggestions.map((s) => s.id);

describe("findRecordArrays", () => {
  it("finds the record array under data and the body itself when it is an array", () => {
    expect(
      findRecordArrays({ meta: { next: "x" }, data: [{ a: 1 }] })[0],
    ).toEqual({ path: "data", length: 1, objectItems: true });
    expect(findRecordArrays([{ a: 1 }])[0]!.path).toBe("");
  });

  it("puts arrays of objects first and quotes odd keys", () => {
    expect(
      findRecordArrays({
        tags: ["a", "b"],
        result: { "line items": [{ id: 1 }, { id: 2 }] },
      }),
    ).toEqual([
      { path: 'result["line items"]', length: 2, objectItems: true },
      { path: "tags", length: 2, objectItems: false },
    ]);
  });

  it("finds nothing in a scalar body", () => {
    expect(findRecordArrays("plain")).toEqual([]);
    expect(findRecordArrays(42)).toEqual([]);
  });
});

describe("readPath", () => {
  it("reads dotted paths and turns bad paths into not found", () => {
    const body = { data: [{ url: "x" }] };
    expect(readPath(body, "data[0].url")).toEqual({ found: true, value: "x" });
    expect(readPath(body, "")).toEqual({ found: true, value: body });
    expect(readPath(body, "missing")).toEqual({ found: false });
    expect(readPath(body, "data[")).toEqual({ found: false });
    expect(readPath(body, "__proto__")).toEqual({ found: false });
  });
});

describe("suggestFields", () => {
  it("suggests dates, timestamps, integers, decimals, booleans and image URLs", () => {
    const s = byPath(
      suggestFields([
        {
          date: "2026-11-01",
          at: "2026-11-01T08:00:00Z",
          created_at: 1793520000,
          orders: 12,
          revenue: { amount: "12.50" },
          ok: true,
          image_url: "https://cdn.example.test/a.webp?w=1",
        },
        {
          date: "2026-11-02",
          at: "2026-11-02T08:00:00Z",
          created_at: 1793606400,
          orders: 3,
          revenue: { amount: 4 },
          ok: false,
          image_url: "https://cdn.example.test/b.jpg",
        },
      ]),
    );
    expect(s.date).toMatchObject({ type: "date", format: "iso" });
    expect(s.at).toMatchObject({ type: "timestamp", format: "iso" });
    expect(s.created_at).toMatchObject({
      type: "timestamp",
      format: "unix_seconds",
    });
    expect(s.orders!.type).toBe("integer");
    expect(s["revenue.amount"]!.type).toBe("decimal");
    expect(s["revenue.amount"]!.name).toBe("Revenue amount");
    expect(s.ok!.type).toBe("boolean");
    expect(s.image_url).toMatchObject({ type: "string", role: "image" });
    expect(s.orders!.nullable).toBe(false);
    expect(s.orders!.samples).toEqual(["12", "3"]);
  });

  it("suggests unix milliseconds, plain numbers and money with fractions", () => {
    const s = byPath(
      suggestFields([
        { updatedAt: 1793520000000, ratio: 0.5, total: 1.25, price: 3 },
        { updatedAt: 1793520001000, ratio: 2, total: 7, price: 4 },
      ]),
    );
    expect(s.updatedAt).toMatchObject({
      type: "timestamp",
      format: "unix_millis",
    });
    expect(s.ratio!.type).toBe("number");
    expect(s.total!.type).toBe("decimal");
    expect(s.price!.type).toBe("integer");
  });

  it("marks a field nullable when a record lacks it and falls back to string for mixed types", () => {
    const s = byPath(suggestFields([{ a: 1 }, { a: "x" }, {}]));
    expect(s.a).toMatchObject({ type: "string", nullable: true });
    const nulls = byPath(suggestFields([{ b: null }, { b: 2 }]));
    expect(nulls.b).toMatchObject({ type: "integer", nullable: true });
  });

  it("reads only the first 100 records", () => {
    const records = [
      ...Array.from({ length: 100 }, (_, i) => ({ n: i })),
      { n: "x" },
    ];
    expect(byPath(suggestFields(records)).n!.type).toBe("integer");
  });

  it("does not offer http (non-https) URLs as images", () => {
    const s = byPath(
      suggestFields([{ image: "http://cdn.example.test/a.png" }]),
    );
    expect(s.image).toEqual(expect.objectContaining({ type: "string" }));
    expect(s.image!.role).toBeUndefined();
  });

  it("keeps arrays and deep objects as json", () => {
    const s = byPath(
      suggestFields([{ tags: ["a"], a: { b: { c: { d: { e: 1 } } } } }]),
    );
    expect(s.tags!.type).toBe("json");
    expect(s["a.b.c.d"]!.type).toBe("json");
  });

  it("gives unique field ids", () => {
    expect(ids(suggestFields([{ "a.b": 1, a: { b: 2 } }]))).toEqual([
      "a_b",
      "a_b_2",
    ]);
    for (const id of ids(
      suggestFields([{ "1st": 1, "": 2, "Ünïcode Name": 3, CamelCase: 4 }]),
    ))
      expect(id).toMatch(/^[a-z][a-z0-9_.-]{0,99}$/);
  });

  it("cuts samples to 80 characters", () => {
    const [field] = suggestFields([{ text: "x".repeat(500) }]);
    expect(field!.samples[0]!.length).toBeLessThanOrEqual(80);
  });

  it("survives a 40-level nested body and a 100,000-item array", () => {
    let nested: unknown = { leaf: 1 };
    for (let i = 0; i < 40; i++) nested = { level: nested, list: [i] };
    const huge = Array.from({ length: 100_000 }, (_, i) => ({ i }));
    const started = Date.now();
    expect(findRecordArrays(nested).length).toBeGreaterThan(0);
    expect(findRecordArrays({ data: huge })[0]).toEqual({
      path: "data",
      length: 100_000,
      objectItems: true,
    });
    expect(suggestFields(huge)).toHaveLength(1);
    expect(suggestFields([nested]).length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("returns nothing for an empty page", () => {
    expect(suggestFields([])).toEqual([]);
  });
});

describe("fieldIdFromPath", () => {
  it("makes ids from paths", () => {
    expect(fieldIdFromPath("revenue.amount", new Set())).toBe("revenue_amount");
    expect(fieldIdFromPath("items[0].url", new Set())).toBe("items_0_url");
    expect(fieldIdFromPath("x", new Set(["x", "x_2"]))).toBe("x_3");
  });
});
