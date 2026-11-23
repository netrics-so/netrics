import { describe, expect, it } from "vitest";

import {
  customApiDefinitionSchema,
  upgradeCustomApiDefinition,
  type CustomApiDefinition,
} from "@netrics/connector-sdk/custom-api";

import { diffCustomApiVersions } from "./connection-updates.js";
import { customApiFixture } from "./test-helpers.js";

// The pure diff behind a connection's update offer (#808).

const shop = (): CustomApiDefinition =>
  upgradeCustomApiDefinition(customApiFixture("v1-shop"));

const connection = {
  environmentId: "production",
  variables: { account_id: "a" },
};

function change(
  doc: CustomApiDefinition,
  edit: (d: CustomApiDefinition) => void,
) {
  const next = structuredClone(doc);
  edit(next);
  return customApiDefinitionSchema.parse(next);
}

describe("diffCustomApiVersions", () => {
  it("reports added, removed and changed fields per stream", () => {
    const from = shop();
    const to = change(from, (d) => {
      const fields = d.streams[0]!.fields;
      fields.push({
        id: "visits",
        name: "Visits",
        path: "visits",
        type: "integer",
        nullable: true,
        classification: "internal",
      });
      d.streams[0]!.fields = fields.filter((f) => f.id !== "orders");
      d.streams[0]!.fields.find((f) => f.id === "day")!.path = "day";
      d.streams[0]!.fields.find((f) => f.id === "revenue")!.classification =
        "public";
      d.streams[0]!.pagination = { type: "none" };
    });
    const { changes, blockers, login } = diffCustomApiVersions(
      from,
      to,
      connection,
    );
    expect(changes).toEqual(
      expect.arrayContaining([
        { kind: "field_added", stream: "daily_stats", field: "visits" },
        { kind: "field_removed", stream: "daily_stats", field: "orders" },
        {
          kind: "field_changed",
          stream: "daily_stats",
          field: "day",
          changes: ["path"],
        },
        {
          kind: "field_changed",
          stream: "daily_stats",
          field: "revenue",
          changes: ["classification"],
        },
        { kind: "pagination_changed", stream: "daily_stats" },
      ]),
    );
    expect(changes).toHaveLength(5);
    expect(blockers).toEqual([]);
    expect(login).toEqual({
      carriesOver: true,
      reason: null,
      method: "bearer",
    });
  });

  it("reports added and removed streams, environments and the schedule", () => {
    const from = shop();
    const to = change(from, (d) => {
      d.streams[0]!.key = "stats";
      d.environments[1]!.baseUrl = "https://staging2.example.com/v1";
      d.environments.push({
        id: "eu",
        name: "EU",
        baseUrl: "https://eu.example.com/v1",
      });
      d.defaults.refreshMinutes = 30;
    });
    const { changes } = diffCustomApiVersions(from, to, connection);
    expect(changes).toEqual([
      { kind: "stream_added", stream: "stats" },
      { kind: "stream_removed", stream: "daily_stats" },
      { kind: "environment_url_changed", environment: "staging" },
      { kind: "environment_added", environment: "eu" },
      { kind: "schedule_changed" },
    ]);
  });

  it("needs credentials when the token URL host changes", () => {
    const oauth = change(shop(), (d) => {
      d.auth = {
        type: "oauth_client_credentials",
        tokenUrl: "https://auth.example.com/token",
        scopes: [],
        clientAuth: "body",
      } as CustomApiDefinition["auth"];
    });
    const moved = change(oauth, (d) => {
      (d.auth as { tokenUrl: string }).tokenUrl =
        "https://login.example.org/token";
    });
    const pathOnly = change(oauth, (d) => {
      (d.auth as { tokenUrl: string }).tokenUrl =
        "https://auth.example.com/v2/token";
    });
    expect(diffCustomApiVersions(oauth, moved, connection).login).toEqual({
      carriesOver: false,
      reason: "hosts_changed",
      method: "oauth_client_credentials",
    });
    expect(
      diffCustomApiVersions(oauth, pathOnly, connection).login.carriesOver,
    ).toBe(true);
    // The API host, its port, or another login method.
    const port = change(shop(), (d) => {
      d.environments[0]!.baseUrl = "https://api.example.com:8443/v1";
    });
    expect(diffCustomApiVersions(shop(), port, connection).login.reason).toBe(
      "hosts_changed",
    );
    const key = change(shop(), (d) => {
      d.auth = {
        type: "api_key",
        placement: "header",
        name: "X-Key",
      } as CustomApiDefinition["auth"];
    });
    expect(diffCustomApiVersions(shop(), key, connection).login).toMatchObject({
      carriesOver: false,
      reason: "auth_changed",
    });
    // Another environment of the same host keeps the login.
    const twin = change(shop(), (d) => {
      d.environments[1]!.baseUrl = "https://api.example.com/v2";
    });
    expect(
      diffCustomApiVersions(shop(), twin, {
        ...connection,
        targetEnvironmentId: "staging",
      }).login.carriesOver,
    ).toBe(true);
  });

  it("needs a value for a new variable", () => {
    const to = change(shop(), (d) => {
      d.variables.push(
        { id: "region", label: "Region", secret: false },
        { id: "tenant_key", label: "Tenant key", secret: true },
      );
    });
    const { changes, blockers } = diffCustomApiVersions(shop(), to, connection);
    expect(changes).toEqual([
      { kind: "variable_added", variable: "region" },
      { kind: "variable_added", variable: "tenant_key" },
    ]);
    expect(blockers).toEqual([
      { code: "variable_required", variable: "region", secret: false },
      { code: "variable_required", variable: "tenant_key", secret: true },
    ]);
    expect(
      diffCustomApiVersions(shop(), to, {
        ...connection,
        variables: { account_id: "a", region: "eu" },
      }).blockers,
    ).toEqual([
      { code: "variable_required", variable: "tenant_key", secret: true },
    ]);
  });

  it("blocks when the connection's environment is gone", () => {
    const to = change(shop(), (d) => {
      d.environments = d.environments.filter((e) => e.id !== "production");
    });
    expect(diffCustomApiVersions(shop(), to, connection).blockers).toEqual([
      { code: "environment_removed", environment: "production" },
    ]);
    expect(
      diffCustomApiVersions(shop(), to, {
        ...connection,
        targetEnvironmentId: "staging",
      }).blockers,
    ).toEqual([]);
  });

  it("reports image hosts and a field's empty setting (#834)", () => {
    const from = shop();
    const to = change(from, (d) => {
      d.images = { hosts: ["cdn.example.test"], newestItems: 12 };
      const orders = d.streams[0]!.fields.find((f) => f.id === "orders")!;
      orders.nullable = !orders.nullable;
      orders.name = "Order count";
    });
    expect(diffCustomApiVersions(from, to, connection).changes).toEqual([
      {
        kind: "field_changed",
        stream: "daily_stats",
        field: "orders",
        changes: ["nullable", "name"],
      },
      { kind: "images_changed" },
    ]);
  });

  it("reports nothing for identical documents", () => {
    expect(diffCustomApiVersions(shop(), shop(), connection)).toEqual({
      changes: [],
      blockers: [],
      login: { carriesOver: true, reason: null, method: "bearer" },
    });
  });
});
