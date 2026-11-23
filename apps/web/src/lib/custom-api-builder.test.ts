import { describe, expect, it } from "vitest";

import {
  customApiDefinitionSchema,
  type CustomApiDefinition,
  type CustomApiFieldSuggestion,
} from "@netrics/contracts";

import {
  definitionIssues,
  definitionOf,
  draftDefinitionOf,
  emptyBuilderState,
  environmentIdFromName,
  chooseKey,
  pickRecords,
  setFieldType,
  stateFromDefinition,
  stepIssues,
  keyHint,
  setNullable,
  toggleField,
  withRequest,
  type BuilderState,
} from "./custom-api-builder";

// The builder's state model (#807): definition ↔ step state, step checks.

/** The spec's section 2 example (the currency field made non-null, as money needs). */
const SHOP: CustomApiDefinition = customApiDefinitionSchema.parse({
  schemaVersion: 2,
  name: "Shop API",
  environments: [
    {
      id: "production",
      name: "Production",
      baseUrl: "https://api.example.com/v1",
    },
    {
      id: "staging",
      name: "Staging",
      baseUrl: "https://staging.example.com/v1",
    },
  ],
  variables: [{ id: "account_id", label: "Account ID", secret: false }],
  auth: { type: "bearer" },
  defaults: { refreshMinutes: 60, timeZone: "UTC" },
  streams: [
    {
      key: "daily_stats",
      name: "Daily stats",
      request: {
        path: "/accounts/{{account_id}}/stats",
        query: { from: "{{window.start}}", to: "{{window.end}}" },
        headers: { Accept: "application/json" },
      },
      pagination: { type: "cursor", cursorPath: "meta.next", param: "cursor" },
      records: "data",
      fields: [
        { id: "day", name: "Day", path: "date", type: "date", nullable: false },
        { id: "orders", name: "Orders", path: "orders", type: "integer" },
        {
          id: "revenue",
          name: "Revenue",
          path: "revenue.amount",
          type: "decimal",
          currencyField: "currency",
        },
        {
          id: "currency",
          name: "Currency",
          path: "revenue.currency",
          type: "string",
          nullable: false,
        },
      ],
      keyFields: ["day"],
      mode: "upsert",
      reportingField: "day",
      window: {
        type: "date",
        stepDays: 31,
        lookbackDays: 3,
        backfillDays: 365,
        paramFormat: "date",
      },
    },
  ],
});

const suggestion = (
  path: string,
  type: CustomApiFieldSuggestion["type"],
  extra: Partial<CustomApiFieldSuggestion> = {},
): CustomApiFieldSuggestion => ({
  path,
  id: path.replace(/\W+/g, "_"),
  name: path,
  type,
  nullable: false,
  samples: [],
  ...extra,
});

function basics(overrides: Partial<BuilderState> = {}): BuilderState {
  return {
    ...emptyBuilderState("en", "Europe/Berlin"),
    name: "Shop API",
    environments: [
      {
        id: "production",
        name: "Production",
        baseUrl: "https://api.example.test",
      },
    ],
    ...overrides,
  };
}

describe("custom API builder state", () => {
  it("round-trips a definition through the builder state", () => {
    expect(definitionOf(stateFromDefinition(SHOP), SHOP)).toEqual(SHOP);
    // Without the original as well: one stream, nothing lost.
    expect(definitionOf(stateFromDefinition(SHOP))).toEqual(SHOP);
  });

  it("keeps the other streams of an edited definition", () => {
    const second = { ...SHOP.streams[0]!, key: "orders", name: "Orders" };
    const two: CustomApiDefinition = {
      ...SHOP,
      streams: [SHOP.streams[0]!, second],
    };
    const state = stateFromDefinition(two, "orders");
    expect(state.stream.key).toBe("orders");
    const edited = definitionOf(
      { ...state, stream: { ...state.stream, name: "All orders" } },
      two,
    );
    expect(edited.streams.map((s) => [s.key, s.name])).toEqual([
      ["daily_stats", "Daily stats"],
      ["orders", "All orders"],
    ]);
  });

  it("needs an https base URL", () => {
    const http = basics({
      environments: [
        {
          id: "production",
          name: "Production",
          baseUrl: "http://api.example.test",
        },
      ],
    });
    expect(stepIssues(http, "basics")).toEqual(["issues.baseUrlHttps"]);
    const trailing = basics({
      environments: [
        {
          id: "production",
          name: "Production",
          baseUrl: "https://api.example.test/",
        },
      ],
    });
    expect(stepIssues(trailing, "basics")).toEqual(["issues.baseUrlInvalid"]);
    expect(stepIssues(basics(), "basics")).toEqual([]);
    expect(stepIssues(basics({ name: " " }), "basics")).toEqual([
      "issues.nameRequired",
    ]);
  });

  it("rejects a placeholder outside the closed set", () => {
    const state = withRequest(basics(), { path: "/stats/{{shop}}" });
    expect(stepIssues(state, "request")).toContain("issues.unknownPlaceholder");
    const known = withRequest(
      {
        ...basics(),
        variables: [{ id: "shop", label: "Shop", secret: false, value: "1" }],
      },
      {
        path: "/stats/{{shop}}",
        query: [{ key: "from", value: "{{window.start}}" }],
      },
    );
    expect(stepIssues(known, "request")).toEqual([]);
    // Using the window gives the request a default date window.
    expect(known.stream.window.type).toBe("date");
  });

  it("rejects a secret variable in the query", () => {
    const state = withRequest(
      {
        ...basics(),
        secretsSet: ["account_key"],
        variables: [
          { id: "account_key", label: "Account key", secret: true, value: "" },
        ],
      },
      { path: "/stats", query: [{ key: "key", value: "{{account_key}}" }] },
    );
    expect(stepIssues(state, "request")).toEqual(["issues.secretOutsideAuth"]);
    const reserved = {
      ...state,
      variables: [{ id: "token", label: "Token", secret: true, value: "" }],
      secretsSet: ["token"],
      stream: { ...state.stream, query: [] },
    };
    expect(stepIssues(reserved, "request")).toEqual([
      "issues.reservedVariable",
    ]);
  });

  it("lets ticked text fields be empty by default, keys excepted (#834)", () => {
    let state = pickRecords(basics(), "data");
    state = toggleField(state, suggestion("id", "integer"), true);
    state = toggleField(state, suggestion("prompt", "string"), true);
    state = toggleField(state, suggestion("count", "integer"), true);
    const byId = (id: string) => state.stream.fields.find((f) => f.id === id);
    expect(byId("prompt")?.nullable).toBe(true);
    expect(byId("count")?.nullable).toBe(false);
    expect(byId("id")?.nullable).toBe(false);
  });

  it("ticking a suggested image field maps a string with role image", () => {
    const state = toggleField(
      pickRecords(basics(), "items"),
      suggestion("image_url", "string", { role: "image" }),
      true,
    );
    expect(state.stream.fields[0]).toMatchObject({
      type: "string",
      role: "image",
      path: "image_url",
    });
    const typed = setFieldType(state, "image_url", "integer");
    expect(typed.stream.fields[0]).not.toHaveProperty("role");
    expect(
      setFieldType(typed, "image_url", "image").stream.fields[0],
    ).toMatchObject({
      type: "string",
      role: "image",
    });
  });

  it("picking another record array drops fields of the old one", () => {
    const picked = toggleField(
      pickRecords(basics(), "data"),
      suggestion("orders", "integer"),
      true,
    );
    expect(pickRecords(picked, "data")).toBe(picked);
    const other = pickRecords(picked, "meta.items");
    expect(other.stream).toMatchObject({
      records: "meta.items",
      fields: [],
      keyFields: [],
    });
  });

  it("keeps the key when a time field is ticked later, and offers it (#834)", () => {
    let state = pickRecords(basics(), "data");
    state = toggleField(state, suggestion("orders", "integer"), true);
    expect(state.stream.keyFields).toEqual(["orders"]);
    // A count as key merges records with equal counts: a warning.
    expect(keyHint(state)).toEqual({ field: "orders", time: null });
    state = toggleField(
      state,
      suggestion("date", "date", { nullable: true }),
      true,
    );
    expect(state.stream).toMatchObject({
      keyFields: ["orders"],
      reportingField: "date",
    });
    expect(keyHint(state)).toEqual({ field: "orders", time: "date" });
    state = chooseKey(state, { keyField: "date" });
    expect(keyHint(state)).toBeNull();
    state = toggleField(state, suggestion("revenue.amount", "decimal"), true);
    expect(state.stream).toMatchObject({
      keyFields: ["date"],
      reportingField: "date",
      mode: "upsert",
    });
    // A key field is kept non-null so the definition is valid.
    expect(state.stream.fields.find((f) => f.id === "date")?.nullable).toBe(
      false,
    );
    const ready = withRequest(state, { path: "/builder/stats" });
    expect(definitionIssues(ready)).toEqual([]);
    expect(draftDefinitionOf(ready).stream.keyFields).toEqual(["date"]);
  });

  it("leaves a sensible kept key alone: text or an id-like number (#834 review)", () => {
    const withKey = (key: ReturnType<typeof suggestion>) =>
      toggleField(
        toggleField(pickRecords(basics(), "data"), key, true),
        suggestion("created_at", "timestamp"),
        true,
      );
    expect(keyHint(withKey(suggestion("short_id", "string")))).toBeNull();
    expect(keyHint(withKey(suggestion("user.id", "integer")))).toBeNull();
    expect(keyHint(withKey(suggestion("orderId", "integer")))).toBeNull();
    expect(keyHint(withKey(suggestion("price", "number")))).toEqual({
      field: "price",
      time: "created_at",
    });
    // A code names a category, not a record (#834 re-review).
    expect(keyHint(withKey(suggestion("country_code", "integer")))).toEqual({
      field: "country_code",
      time: "created_at",
    });
    expect(keyHint(withKey(suggestion("active", "boolean")))).toEqual({
      field: "active",
      time: "created_at",
    });
  });

  it("lets a text field be empty again once it is no longer the key (#834 review)", () => {
    let state = pickRecords(basics(), "data");
    state = toggleField(state, suggestion("title", "string"), true);
    state = toggleField(state, suggestion("slug", "string"), true);
    state = toggleField(state, suggestion("created_at", "timestamp"), true);
    const nullable = (id: string) =>
      state.stream.fields.find((f) => f.id === id)?.nullable;
    expect(state.stream.keyFields).toEqual(["title"]);
    expect(nullable("title")).toBe(false);
    state = chooseKey(state, { keyField: "slug" });
    expect(nullable("title")).toBe(true);
    expect(nullable("slug")).toBe(false);
    // Set by hand: kept when the field leaves the key.
    state = setNullable(state, "slug", false);
    state = chooseKey(state, { keyField: "title" });
    expect(nullable("slug")).toBe(false);
    expect(nullable("title")).toBe(false);
    // The time field too: a text field that stops being one goes back.
    expect(nullable("created_at")).toBe(false);
  });

  it("keeps a saved definition's empty settings while editing (#834 review)", () => {
    const state = chooseKey(stateFromDefinition(SHOP), {
      keyField: "orders",
    });
    expect(state.stream.fields.find((f) => f.id === "day")?.nullable).toBe(
      false,
    );
  });

  it("makes environment ids from names", () => {
    expect(environmentIdFromName("Staging EU", new Set())).toBe("staging-eu");
    expect(environmentIdFromName("Production", new Set(["production"]))).toBe(
      "production-2",
    );
    expect(environmentIdFromName("1st", new Set())).toBe("env-1st");
  });
});
