import type {
  CheckResult,
  ConnectionContext,
  Connector,
  ConnectorManifest,
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import { demoManifest } from "@netrics/connectors";

import {
  ContractViolationError,
  executeCheck,
  executeSync,
} from "./execute.js";

const baseContext: ConnectionContext = {
  connectionId: "conn-1",
  config: {},
  credentials: {},
};

const request: SyncRequest = {
  mode: "backfill",
  from: "2024-01-01T00:00:00.000Z",
  to: "2024-01-02T00:00:00.000Z",
};

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    metricKey: "demo.visitors",
    sourceTimestamp: "2024-01-01T00:00:00.000Z",
    value: 42,
    dimensions: { resource: "demo-site-1" },
    sourceIdentity: "demo.visitors:demo-site-1:2024-01-01",
    ...overrides,
  };
}

function connectorWith(
  manifest: ConnectorManifest,
  sync?: (context: ConnectionContext, request: SyncRequest) => unknown,
  check?: () => unknown,
): Connector {
  return {
    manifest,
    async check() {
      return (check?.() ?? { ok: true }) as CheckResult;
    },
    async discover() {
      return [];
    },
    async sync(context, req) {
      return (sync?.(context, req) ?? {
        observations: [],
        done: true,
      }) as SyncResult;
    },
  };
}

describe("executeSync", () => {
  it("passes valid results through", async () => {
    const connector = connectorWith(demoManifest, () => ({
      observations: [observation()],
      nextCursor: "2024-01-01T00:00:00.000Z",
      done: true,
    }));
    const result = await executeSync(connector, baseContext, request);
    expect(result.observations).toHaveLength(1);
    expect(result.done).toBe(true);
  });

  it("rejects an invalid request before calling the connector", async () => {
    let called = false;
    const connector = connectorWith(demoManifest, () => {
      called = true;
      return { observations: [], done: true };
    });
    await expect(
      executeSync(connector, baseContext, { ...request, from: request.to }),
    ).rejects.toBeInstanceOf(ContractViolationError);
    expect(called).toBe(false);
  });

  it("rejects observations with undeclared metric keys", async () => {
    const connector = connectorWith(demoManifest, () => ({
      observations: [observation({ metricKey: "demo.revenue" })],
      done: true,
    }));
    await expect(executeSync(connector, baseContext, request)).rejects.toThrow(
      /undeclared metric key "demo.revenue"/,
    );
  });

  it("rejects observations with undeclared dimensions", async () => {
    const connector = connectorWith(demoManifest, () => ({
      observations: [
        observation({ dimensions: { resource: "demo-site-1", country: "de" } }),
      ],
      done: true,
    }));
    await expect(executeSync(connector, baseContext, request)).rejects.toThrow(
      /undeclared dimension "country"/,
    );
  });

  it("rejects malformed transport objects", async () => {
    const connector = connectorWith(demoManifest, () => ({
      observations: [observation({ value: Number.NaN })],
      done: true,
    }));
    await expect(
      executeSync(connector, baseContext, request),
    ).rejects.toBeInstanceOf(ContractViolationError);
  });

  it("redacts credential values from thrown connector errors", async () => {
    const context: ConnectionContext = {
      ...baseContext,
      credentials: { token: "sk-live-9f8e7d6c" },
    };
    const connector = connectorWith(demoManifest, () => {
      throw new Error("provider 401 for token sk-live-9f8e7d6c");
    });
    const failure = await executeSync(connector, context, request).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("sk-live-9f8e7d6c");
    expect((failure as Error).message).toContain("[redacted]");
    // A plain thrown error is NOT a contract violation: it is the retryable
    // provider-failure convention.
    expect(failure).not.toBeInstanceOf(ContractViolationError);
  });

  it("refuses contexts carrying function-typed values (capability leak)", async () => {
    let called = false;
    const connector = connectorWith(demoManifest, () => {
      called = true;
      return { observations: [], done: true };
    });
    const leaking: ConnectionContext = {
      ...baseContext,
      config: { db: async () => "handle" },
    };
    await expect(executeSync(connector, leaking, request)).rejects.toThrow(
      /function at config\.db/,
    );
    expect(called).toBe(false);
  });
});

describe("executeCheck", () => {
  it("passes ok results through", async () => {
    const connector = connectorWith(demoManifest, undefined, () => ({
      ok: true,
    }));
    await expect(executeCheck(connector, baseContext)).resolves.toEqual({
      ok: true,
    });
  });

  it("redacts credential values from failure messages", async () => {
    const context: ConnectionContext = {
      ...baseContext,
      credentials: { token: "sk-live-9f8e7d6c" },
    };
    const connector = connectorWith(demoManifest, undefined, () => ({
      ok: false,
      message: "token sk-live-9f8e7d6c rejected",
    }));
    const result = await executeCheck(connector, context);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("sk-live-9f8e7d6c");
  });

  it("rejects malformed check results as contract violations", async () => {
    const connector = connectorWith(
      demoManifest,
      undefined,
      () => ({ status: "great" }) as unknown,
    );
    await expect(executeCheck(connector, baseContext)).rejects.toBeInstanceOf(
      ContractViolationError,
    );
  });
});
