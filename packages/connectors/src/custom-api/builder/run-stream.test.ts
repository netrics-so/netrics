import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import { afterAll, describe, expect, it } from "vitest";

import { CustomApiAuthError } from "../errors.js";
import {
  FIXTURE_SECRETS,
  fixtureDefinition,
  fixtureRuntime,
  startCustomApiFixtureServer,
  type FixtureDefinitionName,
} from "../testing/index.js";
import {
  CustomApiHttpError,
  runCustomApiTestStream,
  type CustomApiPageTrace,
} from "./run-stream.js";

// The builder's bounded test runner (#806) against the plain http fixture.

const fixture = await startCustomApiFixtureServer();
afterAll(() => fixture.close());
const runtime = fixtureRuntime(["127.0.0.1"]);
const host = `127.0.0.1:${fixture.port}`;

const LIMITS = { maxPages: 5, maxRecords: 1_000, deadline: Infinity };

async function run(
  name: FixtureDefinitionName | CustomApiDefinition,
  options: {
    credentials?: Record<string, unknown>;
    limits?: Partial<typeof LIMITS>;
    now?: () => number;
  } = {},
) {
  const definition =
    typeof name === "string" ? fixtureDefinition(name, fixture.origin) : name;
  const traces: CustomApiPageTrace[] = [];
  const result = await runCustomApiTestStream({
    definition,
    stream: definition.streams[0]!,
    environmentId: "production",
    config: {},
    credentials: { host, ...(options.credentials ?? {}) } as never,
    fetch: runtime.fetch,
    chunk: null,
    limits: { ...LIMITS, ...options.limits },
    onPage: (trace) => traces.push(trace),
    ...(options.now ? { now: options.now } : {}),
  });
  return { result, traces };
}

describe("runCustomApiTestStream", () => {
  it("reads pages until the cursor ends and reports a trace per page with the redacted URL", async () => {
    const { result, traces } = await run("cursor");
    expect(result.stopped).toBe("end");
    expect(result.rows).toHaveLength(25);
    expect(traces.map((t) => [t.page, t.status, t.records])).toEqual([
      [1, 200, 10],
      [2, 200, 10],
      [3, 200, 5],
    ]);
    expect(traces[1]!.url).toBe(
      `${fixture.origin}/items/cursor?cursor=[redacted]`,
    );
    expect(traces[0]!.contentType).toMatch(/application\/json/);
    expect(traces[0]!.bytes).toBeGreaterThan(0);
    expect(traces[0]!.body).toMatchObject({ meta: { next: "c10" } });
    // Later pages keep their metadata only (review #820).
    expect(traces[1]!.body).toBeNull();
    expect(traces[2]!.body).toBeNull();
  });

  it("never puts the API key in a trace URL", async () => {
    const { traces } = await run("api_key_query", {
      credentials: { apiKey: FIXTURE_SECRETS.apiKey },
    });
    expect(traces[0]!.status).toBe(200);
    expect(traces[0]!.url).not.toContain(FIXTURE_SECRETS.apiKey);
    expect(traces[0]!.url).toContain("api_key=[redacted]");
  });

  it("stops at maxPages, maxRecords and the deadline and says which", async () => {
    expect(
      (await run("cursor", { limits: { maxPages: 2 } })).result,
    ).toMatchObject({ stopped: "page_limit", rows: expect.any(Array) });
    const limited = await run("cursor", { limits: { maxRecords: 15 } });
    expect(limited.result.stopped).toBe("record_limit");
    expect(limited.result.rows).toHaveLength(15);
    const exact = await run("cursor", { limits: { maxRecords: 25 } });
    expect(exact.result.stopped).toBe("end");
    let clock = 0;
    const late = await run("cursor", {
      limits: { deadline: 10 },
      now: () => (clock += 6),
    });
    expect(late.result.stopped).toBe("duration");
    expect(late.traces).toHaveLength(1);
  });

  it("throws auth and HTTP errors after reporting the page", async () => {
    const auth = run("bearer", { credentials: { token: "wrong-token" } });
    await expect(auth).rejects.toBeInstanceOf(CustomApiAuthError);
    const http = run("rate_limited");
    await expect(http).rejects.toBeInstanceOf(CustomApiHttpError);
  });

  it("keeps a body that is not JSON as text in the trace", async () => {
    const traces: CustomApiPageTrace[] = [];
    const definition = fixtureDefinition("not_json", fixture.origin);
    await expect(
      runCustomApiTestStream({
        definition,
        stream: definition.streams[0]!,
        environmentId: "production",
        config: {},
        credentials: { host } as never,
        fetch: runtime.fetch,
        chunk: null,
        limits: LIMITS,
        onPage: (trace) => traces.push(trace),
      }),
    ).rejects.toThrow(/did not answer with JSON/);
    expect(traces[0]!.body).toMatch(/Not JSON/);
  });

  it("fills the window placeholders from the chunk", async () => {
    const definition = fixtureDefinition("daily", fixture.origin);
    fixture.reset();
    const result = await runCustomApiTestStream({
      definition,
      stream: definition.streams[0]!,
      environmentId: "production",
      config: {},
      credentials: { host } as never,
      fetch: runtime.fetch,
      chunk: { from: "2024-03-01", to: "2024-03-04" },
      limits: LIMITS,
    });
    expect(result.rows).toHaveLength(3);
    expect(fixture.requests[0]!.query).toMatchObject({
      from: "2024-03-01",
      to: "2024-03-04",
    });
  });
});

describe("hidden values (#885)", () => {
  it("compares each value of a page once, however many fields read under it (#932)", async () => {
    const base = fixtureDefinition("pages", fixture.origin);
    const sub = Array.from({ length: 100 }, (_, i) => `f${i}`);
    const definition = {
      ...base,
      streams: [
        {
          ...base.streams[0]!,
          pagination: { type: "none" },
          fields: [
            { id: "id", name: "ID", path: "id", type: "integer" },
            ...sub.map((key) => ({
              id: key,
              name: key,
              path: `request.${key}`,
              type: "string",
            })),
          ],
        },
      ],
    } as unknown as CustomApiDefinition;
    const request = () => Object.fromEntries(sub.map((key) => [key, "x"]));
    const text = JSON.stringify({
      data: [1, 2, 3].map((id) => ({ id, request: request() })),
    });
    let comparisons = 0;
    const result = await runCustomApiTestStream({
      definition,
      stream: definition.streams[0]!,
      environmentId: "production",
      config: {},
      credentials: { host } as never,
      fetch: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        text: () => text,
        json: () => JSON.parse(text) as unknown,
        bytes: () => new Uint8Array(),
      }),
      chunk: null,
      limits: LIMITS,
      hidden: (value) => {
        if (value === null || typeof value !== "object") return undefined;
        comparisons += 1;
        return Object.hasOwn(value, "f0") ? "[redacted]" : undefined;
      },
    });
    expect(result.rows).toHaveLength(3);
    expect(result.rows[2]).toMatchObject({ id: 3, f99: "[redacted]" });
    // The records path (body, data), then per record itself and its
    // `request`: once each, not once per field.
    expect(comparisons).toBe(2 + 3 * 2);
  });
});
