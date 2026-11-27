import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConnectorRegistry,
  executeSync,
  type ExecuteOptions,
} from "@netrics/connector-runtime";
import type {
  ConnectionContext,
  DatasetPage,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { createHttpCheckConnector } from "@netrics/connectors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  HTTP_CHECK_LIMITS,
  callOptionsFor,
  connectorFor,
  httpCheckEgress,
} from "./custom-api/connectors.js";

// Whole HTTP check runs through the host's own egress guard and result
// validation (executeSync → validateSyncResult, ADR 0026 §7), which the
// connectors package cannot import: an https fixture server on 127.0.0.1
// under fake names, with a certificate made here and trusted through the
// test-only tlsCa.

let server: HttpsServer;
let port: number;
let closedPort: number;
let certDir: string;
let certPem: string;
const SECRET = "FIXTURE-BODY-SECRET";
const timers = new Set<ReturnType<typeof setTimeout>>();

function route(request: IncomingMessage, response: ServerResponse) {
  response.setHeader("connection", "close");
  switch (request.url?.split("?")[0]) {
    case "/ok":
      response.setHeader("content-type", "text/plain");
      response.end(`healthy ${SECRET}`);
      return;
    case "/down":
      response.statusCode = 503;
      response.end(`maintenance ${SECRET}`);
      return;
    case "/agent":
      response.statusCode = request.headers["user-agent"]?.startsWith(
        "netrics-http-check/",
      )
        ? 204
        : 400;
      response.end();
      return;
    case "/big":
      response.setHeader("content-type", "text/plain");
      response.end(Buffer.alloc(HTTP_CHECK_LIMITS.responseBytes + 10, 0x61));
      return;
    case "/down-big":
      response.statusCode = 503;
      response.setHeader("content-type", "text/plain");
      response.end(Buffer.alloc(HTTP_CHECK_LIMITS.responseBytes + 10, 0x61));
      return;
    case "/down-reset": {
      response.statusCode = 503;
      response.setHeader("content-type", "text/plain");
      response.write("partial ");
      const timer = setTimeout(() => {
        timers.delete(timer);
        response.socket?.destroy();
      }, 50);
      timers.add(timer);
      return;
    }
    case "/down-stall":
    case "/ok-stall": {
      // The status and a first chunk come at once, the rest never in time.
      response.statusCode = request.url === "/down-stall" ? 503 : 200;
      response.setHeader("content-type", "text/plain");
      response.write("partial ");
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.destroyed) response.end("late");
      }, 3_000);
      timers.add(timer);
      return;
    }
    case "/to-self":
      response.statusCode = 302;
      response.setHeader("location", "/ok");
      response.end();
      return;
    case "/to-other":
      response.statusCode = 302;
      response.setHeader(
        "location",
        `https://other.fixture.test:${port}/ok?sig=${SECRET}`,
      );
      response.end();
      return;
    case "/slow": {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.destroyed) response.end("late");
      }, 3_000);
      timers.add(timer);
      return;
    }
    default:
      response.statusCode = 404;
      response.end();
  }
}

/** *.fixture.test → 127.0.0.1, except nx.fixture.test, which has no address. */
const lookup: LookupFunction = (hostname, options, callback) => {
  if (hostname === "nx.fixture.test") {
    const error = Object.assign(
      new Error(`getaddrinfo ENOTFOUND ${hostname}`),
      {
        code: "ENOTFOUND",
      },
    );
    callback(error, "", 0);
    return;
  }
  const entry = { address: "127.0.0.1", family: 4 };
  if (options.all) {
    (callback as unknown as (e: null, a: (typeof entry)[]) => void)(null, [
      entry,
    ]);
  } else {
    callback(null, entry.address, entry.family);
  }
};

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), "netrics-http-check-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(certDir, "key.pem"),
      "-out",
      join(certDir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=status.fixture.test",
      "-addext",
      "subjectAltName=DNS:status.fixture.test,DNS:other.fixture.test,DNS:blocked.fixture.test,DNS:closed.fixture.test",
    ],
    { stdio: "ignore" },
  );
  certPem = readFileSync(join(certDir, "cert.pem"), "utf8");
  server = createHttpsServer(
    { cert: certPem, key: readFileSync(join(certDir, "key.pem")) },
    route,
  );
  port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
  // A port nothing listens on any more: connections are refused.
  const closed = createHttpsServer();
  closedPort = await new Promise<number>((resolve) =>
    closed.listen(0, "127.0.0.1", () =>
      resolve((closed.address() as AddressInfo).port),
    ),
  );
  await new Promise((resolve) => closed.close(resolve));
});

afterAll(async () => {
  for (const timer of timers) clearTimeout(timer);
  await new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  rmSync(certDir, { recursive: true, force: true });
});

const PRIVATE_HOSTS = [
  "status.fixture.test",
  "other.fixture.test",
  "wrong.fixture.test",
  "closed.fixture.test",
  "nx.fixture.test",
];

const registry = new ConnectorRegistry();
registry.register(createHttpCheckConnector());
const resolved = connectorFor(registry, {
  row: { connectorId: "http-check" },
  customApi: null,
})!;

/** The options the server passes (callOptionsFor), with the test-only lookup and CA. */
function options(): ExecuteOptions {
  return callOptionsFor(
    resolved,
    { egress: { lookup, tlsCa: certPem } },
    { credentials: {}, privateHosts: PRIVATE_HOSTS },
  );
}

function at(path: string, host = "status.fixture.test", p = port) {
  return `https://${host}:${p}${path}`;
}

function context(checks: unknown[]): ConnectionContext {
  return {
    connectionId: "00000000-0000-4000-8000-000000000874",
    config: { checks },
    credentials: {},
  };
}

function request(cursor?: string): SyncRequest {
  return {
    mode: "incremental",
    from: new Date(Date.now() - 60_000).toISOString(),
    to: new Date().toISOString(),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

async function run(
  ctx: ConnectionContext,
  opts: ExecuteOptions = options(),
): Promise<{ first: SyncResult; last: SyncResult }> {
  const connector = resolved.connector;
  const first = await executeSync(connector, ctx, request(), opts);
  const last = await executeSync(
    connector,
    ctx,
    request(first.nextCursor),
    opts,
  );
  return { first, last };
}

function rows(page: DatasetPage) {
  return Object.fromEntries(
    page.records.map((record) => [
      record.values?.name as string,
      record.values as Record<string, unknown>,
    ]),
  );
}

describe("HTTP check egress (#874)", () => {
  it("bounds time and size, follows the same host only, and reaches the self-host private hosts", () => {
    const opts = options();
    expect(opts.timeoutMs).toBe(60_000);
    expect(opts.egress).toMatchObject({
      redirects: "same-host",
      maxResponseBytes: 1024 * 1024,
      maxDecompressedBytes: 1024 * 1024,
      requestTimeoutMs: 10_000,
      allowPrivateHosts: PRIVATE_HOSTS,
    });
    // The hosted service has no private hosts: public addresses only.
    expect(httpCheckEgress([]).allowPrivateHosts).toEqual([]);
  });
});

describe("HTTP check sync through the host (#874)", () => {
  it("records every outcome as data, through the real egress guard", async () => {
    const checks = [
      { name: "Up", url: at("/ok"), expectedText: "healthy" },
      { name: "Head", url: at("/ok"), method: "HEAD" },
      { name: "Agent", url: at("/agent"), expectedStatus: "204" },
      { name: "Down", url: at("/down") },
      { name: "Text", url: at("/ok"), expectedText: "not there" },
      { name: "Big", url: at("/big"), expectedText: "a" },
      { name: "Big unread", url: at("/big") },
      { name: "Same host", url: at("/to-self"), expectedText: "healthy" },
      // The redirect's host is a configured host too: still refused.
      { name: "Other host", url: at("/to-other") },
      { name: "Other", url: at("/ok", "other.fixture.test") },
      { name: "Slow", url: at("/slow"), timeoutSeconds: 1 },
      { name: "Nx", url: at("/ok", "nx.fixture.test") },
      { name: "Tls", url: at("/ok", "wrong.fixture.test") },
      { name: "Refused", url: at("/ok", "closed.fixture.test", closedPort) },
      { name: "Blocked", url: at("/ok", "blocked.fixture.test") },
    ];
    const { first, last } = await run(context(checks));
    const snapshot = rows(first.datasetPages![0]!);
    const outcome = (name: string) => [
      snapshot[name]?.state,
      snapshot[name]?.reason,
      snapshot[name]?.status_code,
    ];
    expect(outcome("Up")).toEqual(["up", null, 200]);
    expect(outcome("Head")).toEqual(["up", null, 200]);
    expect(outcome("Agent")).toEqual(["up", null, 204]);
    expect(outcome("Down")).toEqual(["down", "unexpected_status", 503]);
    expect(outcome("Text")).toEqual(["down", "text_missing", 200]);
    // The answer's status stays when its body cannot be read (#898).
    expect(outcome("Big")).toEqual(["down", "too_large", 200]);
    expect(outcome("Big unread")).toEqual(["up", null, 200]);
    expect(outcome("Same host")).toEqual(["up", null, 200]);
    expect(outcome("Other host")).toEqual(["down", "redirect", null]);
    expect(outcome("Other")).toEqual(["up", null, 200]);
    expect(outcome("Slow")).toEqual(["down", "timeout", null]);
    expect(outcome("Nx")).toEqual(["down", "dns", null]);
    expect(outcome("Tls")).toEqual(["down", "tls", null]);
    expect(outcome("Refused")).toEqual(["down", "refused", null]);
    expect(outcome("Blocked")).toEqual(["down", "egress_refused", null]);
    expect(snapshot.Up!.response_ms).toEqual(expect.any(Number));

    expect(last.done).toBe(true);
    expect(last.observations).toEqual([]);
    expect(last.datasetPages).toEqual([
      expect.objectContaining({ records: [], complete: true }),
    ]);
    expect(last.freshness).toHaveLength(checks.length);
    // Nothing a checked site answered reaches the results.
    expect(JSON.stringify([first, last])).not.toContain(SECRET);
  }, 20_000);

  it("keeps the status of an answer whose body is too large or too slow (#898)", async () => {
    const { first } = await run(
      context([
        { name: "Down big", url: at("/down-big"), expectedText: "healthy" },
        {
          name: "Down stall",
          url: at("/down-stall"),
          expectedText: "healthy",
          timeoutSeconds: 1,
        },
        { name: "Down reset", url: at("/down-reset"), expectedText: "healthy" },
        {
          name: "Ok stall",
          url: at("/ok-stall"),
          expectedText: "healthy",
          timeoutSeconds: 1,
        },
      ]),
    );
    const snapshot = rows(first.datasetPages![0]!);
    const outcome = (name: string) => [
      snapshot[name]?.state,
      snapshot[name]?.reason,
      snapshot[name]?.status_code,
    ];
    expect(outcome("Down big")).toEqual(["down", "unexpected_status", 503]);
    expect(outcome("Down stall")).toEqual(["down", "unexpected_status", 503]);
    expect(outcome("Ok stall")).toEqual(["down", "timeout", 200]);
    expect(outcome("Down reset")).toEqual(["down", "unexpected_status", 503]);
  }, 20_000);

  it("keeps redirects on the same host even when a caller passes other options", async () => {
    const { first } = await run(
      context([
        { name: "Other host", url: at("/to-other") },
        { name: "Other", url: at("/ok", "other.fixture.test") },
      ]),
      {
        egress: {
          lookup,
          tlsCa: certPem,
          allowPrivateHosts: PRIVATE_HOSTS,
          redirects: "allowlist",
        },
      },
    );
    expect(rows(first.datasetPages![0]!)["Other host"]).toMatchObject({
      state: "down",
      reason: "redirect",
    });
  });

  it("runs the maximum of checks within the host's validation", async () => {
    const checks = Array.from({ length: 20 }, (_, index) => ({
      name: `Check ${index}`,
      url: at(`/ok?n=${index}`),
    }));
    const { first, last } = await run(context(checks));
    expect(first.done).toBe(false);
    expect(first.datasetPages![0]!.records).toHaveLength(20);
    expect(first.observations).toHaveLength(40);
    expect(last.done).toBe(true);
    expect(last.receivedDatasets).toEqual(["checks"]);
    expect(last.freshness).toHaveLength(20);
  });

  it("fails the sync for a configuration it cannot run, with its reason code", async () => {
    await expect(
      executeSync(
        resolved.connector,
        context([{ name: "Plain", url: "http://status.fixture.test/" }]),
        request(),
        options(),
      ),
    ).rejects.toMatchObject({ code: "http_check.url_invalid" });
  });
});
