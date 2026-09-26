import type { Connector, ConnectorManifest } from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import { demoManifest } from "@netrics/connectors";

import { ConnectorRegistry, createDefaultRegistry } from "./registry.js";

function connectorWith(manifest: ConnectorManifest): Connector {
  return {
    manifest,
    async check() {
      return { ok: true };
    },
    async discover() {
      return [];
    },
    async sync() {
      return { observations: [], done: true };
    },
  };
}

describe("ConnectorRegistry", () => {
  it("registers and looks up connectors by manifest id", () => {
    const registry = new ConnectorRegistry();
    const connector = connectorWith(demoManifest);
    registry.register(connector);
    expect(registry.get("demo")?.connector).toBe(connector);
    expect(registry.list()).toHaveLength(1);
  });

  it("rejects manifests incompatible with the runtime SDK version", () => {
    const registry = new ConnectorRegistry();
    const incompatible: ConnectorManifest = {
      ...demoManifest,
      id: "future",
      sdkVersion: ">=9.9.9",
    };
    expect(() => registry.register(connectorWith(incompatible))).toThrow(
      /requires SDK version/,
    );
  });

  it("rejects structurally invalid manifests", () => {
    const registry = new ConnectorRegistry();
    const invalid = { ...demoManifest, id: "Broken Id" };
    expect(() =>
      registry.register(connectorWith(invalid as ConnectorManifest)),
    ).toThrow();
  });

  it("rejects duplicate registrations", () => {
    const registry = new ConnectorRegistry();
    registry.register(connectorWith(demoManifest));
    expect(() => registry.register(connectorWith(demoManifest))).toThrow(
      /already registered/,
    );
  });

  it("seeds the default registry with the demo connector", () => {
    const registry = createDefaultRegistry();
    expect(registry.get("demo")?.manifest.id).toBe("demo");
  });
});
