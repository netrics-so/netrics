import {
  ConnectorRegistry,
  ContractViolationError,
  executeCheck,
} from "@netrics/connector-runtime";
import { CUSTOM_API_LIMITS } from "@netrics/connector-sdk/custom-api";
import { createDemoConnector } from "@netrics/connectors";
import type { ConnectionCustomApi } from "@netrics/database";
import { describe, expect, it } from "vitest";

import { callOptionsFor, connectorFor, customApiEgress } from "./connectors.js";
import { customApiFixture } from "./test-helpers.js";

const registry = new ConnectorRegistry();
registry.register(createDemoConnector());

function conn(pin: Partial<ConnectionCustomApi> = {}): {
  row: { connectorId: string };
  customApi: ConnectionCustomApi;
} {
  return {
    row: { connectorId: "custom-api" },
    customApi: {
      definitionId: "00000000-0000-4000-8000-000000000001",
      versionId: "v1",
      version: 1,
      environmentId: "production",
      document: customApiFixture("v1-shop"),
      datasetVersions: { daily_stats: 1 },
      ...pin,
    },
  };
}

describe("connectorFor", () => {
  it("returns the registry entry for bundled connectors", () => {
    const resolved = connectorFor(registry, {
      row: { connectorId: "demo" },
      customApi: null,
    });
    expect(resolved?.connector).toBe(registry.get("demo")!.connector);
    expect(resolved?.customApi).toBeNull();
    expect(
      connectorFor(registry, { row: { connectorId: "nope" }, customApi: null }),
    ).toBeUndefined();
  });

  it("never finds custom-api in the registry", () => {
    expect(registry.get("custom-api")).toBeUndefined();
    expect(
      connectorFor(registry, {
        row: { connectorId: "custom-api" },
        customApi: null,
      }),
    ).toBeUndefined();
  });

  it("builds one cached connector per version and environment", () => {
    const a = connectorFor(
      registry,
      conn({ versionId: "v1", environmentId: "production" }),
    );
    expect(a?.manifest.id).toBe("custom-api");
    expect(a?.manifest.name).toBe("Shop API");
    expect(
      connectorFor(
        registry,
        conn({ versionId: "v1", environmentId: "production" }),
      ),
    ).toBe(a);
    expect(
      connectorFor(
        registry,
        conn({ versionId: "v1", environmentId: "staging" }),
      )!.manifest.outboundDomains,
    ).toEqual(["staging.example.com"]);
    expect(a?.customApi?.pin).toMatchObject({
      version: 1,
      environmentId: "production",
      datasetVersions: { daily_stats: 1 },
    });
  });

  it("answers undefined for a pin to an unknown environment", () => {
    expect(
      connectorFor(registry, conn({ versionId: "v2", environmentId: "nope" })),
    ).toBeUndefined();
    expect(
      connectorFor(
        registry,
        conn({ versionId: "v3", document: { schemaVersion: 99 } }),
      ),
    ).toBeUndefined();
    expect(
      connectorFor(registry, conn({ versionId: "v4", datasetVersions: {} })),
    ).toBeUndefined();
  });
});

describe("custom API call options", () => {
  it("sets the custom-api egress values and keeps test options from base", () => {
    const lookup = (() => undefined) as never;
    expect(
      customApiEgress(["10.20.0.0/16"], {
        lookup,
        allowInsecureHttp: true,
        tlsCa: "PEM",
        redirects: "allowlist",
        maxResponseBytes: 1,
      }),
    ).toEqual({
      lookup,
      allowInsecureHttp: true,
      tlsCa: "PEM",
      redirects: "same-host",
      maxResponseBytes: CUSTOM_API_LIMITS.responseBytes,
      maxDecompressedBytes: CUSTOM_API_LIMITS.decompressedBytes,
      requestTimeoutMs: CUSTOM_API_LIMITS.requestTimeoutMs,
      allowPrivateHosts: ["10.20.0.0/16"],
    });
  });

  it("adds derived secrets for custom-api and never private hosts for bundled connectors", () => {
    const custom = connectorFor(registry, conn({ versionId: "v5" }))!;
    const options = callOptionsFor(
      custom,
      { timeoutMs: 5 },
      {
        credentials: { host: "api.example.com", token: "tok-123456" },
        privateHosts: ["intranet.example"],
      },
    );
    expect(options.timeoutMs).toBe(60_000);
    expect(options.egress?.allowPrivateHosts).toEqual(["intranet.example"]);
    expect(options.redactValues).toEqual(
      expect.arrayContaining(["tok-123456", "Bearer tok-123456"]),
    );

    const demo = connectorFor(registry, {
      row: { connectorId: "demo" },
      customApi: null,
    })!;
    const base = { timeoutMs: 5, egress: { allowPrivateHosts: ["10.0.0.1"] } };
    const bundled = callOptionsFor(demo, base, {
      credentials: {},
      privateHosts: ["intranet.example"],
    });
    expect(bundled.egress?.allowPrivateHosts).toBeUndefined();
    expect(bundled.egress?.redirects).toBeUndefined();
    expect(bundled.redactValues).toBeUndefined();
    expect(bundled.timeoutMs).toBe(5);
  });

  it("redacts a POST stream's rendered body like rendered headers (ADR 0030 §4)", async () => {
    const post = customApiFixture("v2-post") as Record<string, unknown>;
    const custom = connectorFor(
      registry,
      conn({
        versionId: "post",
        environmentId: "prod",
        document: post,
        datasetVersions: { deployments: 1, events: 1 },
      }),
    )!;
    const credentials = { host: "api.example.com", token: "tok-123456" };
    const config = { project_id: "proj-42" };
    const options = callOptionsFor(
      custom,
      {},
      { credentials, privateHosts: [], config },
    );
    const body = JSON.stringify({
      query: (post.streams as { request: { body: { query: string } } }[])[0]!
        .request.body.query,
      variables: { project: "proj-42", after: null },
    });
    expect(options.redactValues).toContain(body);
    // An error that quotes the body comes out without it.
    const quoting = {
      ...custom.connector,
      check: async () => ({ ok: false, message: `sent ${body}` }),
    };
    const checked = await executeCheck(
      quoting,
      { connectionId: "c1", config, credentials },
      options,
    );
    expect(checked.message).toBe("sent [redacted]");
  });

  it("redacts derived secrets in a custom-api call, and refuses look-alike options", async () => {
    const shop = customApiFixture("v1-shop") as Record<string, unknown>;
    const custom = connectorFor(
      registry,
      conn({
        versionId: "basic",
        document: { ...shop, auth: { type: "basic" } },
      }),
    )!;
    const credentials = {
      host: "api.example.com",
      username: "fx-user",
      password: "fx-pass-0001",
    };
    const basic = Buffer.from("fx-user:fx-pass-0001").toString("base64");
    // The API echoes the Authorization header it got: a value derived from
    // the credentials, not one of them.
    const echoing = {
      ...custom.connector,
      check: async () => ({ ok: false, message: `echo: Basic ${basic}` }),
    };
    const context = { connectionId: "c1", config: {}, credentials };
    const options = callOptionsFor(
      custom,
      {},
      {
        credentials,
        privateHosts: [],
      },
    );
    const checked = await executeCheck(echoing, context, options);
    expect(checked.ok).toBe(false);
    expect(checked.message).toContain("[redacted]");
    expect(checked.message).not.toContain(basic);
    // The same values built by hand: refused, not run unredacted.
    await expect(
      executeCheck(echoing, context, {
        egress: { ...options.egress },
        redactValues: [],
      }),
    ).rejects.toBeInstanceOf(ContractViolationError);
  });
});
