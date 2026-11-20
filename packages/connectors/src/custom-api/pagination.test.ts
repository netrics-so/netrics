import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildRequest,
  CUSTOM_API_MESSAGES,
  CustomApiResponseError,
  linkHeaderNext,
  mapRecords,
  nextPage,
  pageParams,
  selectRecords,
  type PageState,
} from "./index.js";
import {
  fixtureDefinition,
  fixtureRuntime,
  startCustomApiFixtureServer,
  type CustomApiFixtureServer,
  type FixtureDefinitionName,
} from "./testing/index.js";

let fixture: CustomApiFixtureServer;
beforeAll(async () => {
  fixture = await startCustomApiFixtureServer();
});
afterAll(() => fixture.close());

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Reads a stream page by page the way the connector does. */
async function readAll(definition: CustomApiDefinition, maxPages = 50) {
  const runtime = fixtureRuntime(["127.0.0.1"]);
  const stream = definition.streams[0]!;
  const environment = definition.environments[0]!;
  const apiHost = new URL(environment.baseUrl).host;
  let state: PageState | null = { type: "first" };
  const ids: unknown[] = [];
  let pages = 0;
  while (state && pages < maxPages) {
    const page = pageParams(stream.pagination, state);
    const built = buildRequest({
      definition,
      stream,
      environment,
      config: {},
      credentials: { host: apiHost },
      placeholders: page.placeholders,
      pageParams: page.params,
      ...(page.nextUrl ? { nextUrl: page.nextUrl } : {}),
    });
    const response = await runtime.fetch(built.url, {
      headers: built.headers,
    });
    const body = response.json();
    const records = selectRecords(body, stream.records);
    ids.push(...mapRecords(stream, records, "UTC").rows.map((row) => row.id));
    pages += 1;
    state = nextPage({
      pagination: stream.pagination,
      state,
      body,
      linkHeader: response.headers.link,
      recordCount: records.length,
      requestUrl: built.url,
      apiHost,
    });
  }
  return { ids, pages };
}

describe.each<[string, FixtureDefinitionName]>([
  ["page_number", "pages"],
  ["offset", "offset"],
  ["cursor", "cursor"],
  ["next_url body", "next_body"],
  ["next_url link_header", "next_link"],
])("%s", (_style, name) => {
  it("reads all 25 fixture items and stops", async () => {
    const { ids } = await readAll(fixtureDefinition(name, fixture.origin));
    expect(ids).toEqual(range(1, 25));
  });
});

describe("custom API pagination", () => {
  it("stops on a repeated cursor", async () => {
    fixture.reset();
    const { pages } = await readAll(
      fixtureDefinition("repeat_cursor", fixture.origin),
    );
    // The first page names "same", the second repeats it.
    expect(pages).toBe(2);
  });

  it("stops on a short page without asking again", async () => {
    fixture.reset();
    await readAll(fixtureDefinition("pages", fixture.origin));
    expect(fixture.requests).toHaveLength(3);
  });

  it("refuses a next URL on another host", () => {
    const definition = fixtureDefinition("next_body", fixture.origin);
    const input = {
      pagination: definition.streams[0]!.pagination,
      state: { type: "first" } as PageState,
      linkHeader: undefined,
      recordCount: 10,
      requestUrl: "http://127.0.0.1/items",
      apiHost: "127.0.0.1",
    };
    expect(() =>
      nextPage({
        ...input,
        body: { links: { next: "http://localhost:1/items" } },
      }),
    ).toThrow(CUSTOM_API_MESSAGES.nextUrlOffHost);
    expect(() =>
      nextPage({
        ...input,
        body: { links: { next: `http://127.0.0.1/${"x".repeat(2_100)}` } },
      }),
    ).toThrow(CustomApiResponseError);
    expect(
      nextPage({ ...input, body: { links: { next: "/items?after=10" } } }),
    ).toEqual({ type: "next_url", url: "http://127.0.0.1/items?after=10" });
    expect(
      nextPage({
        ...input,
        body: { links: { next: "http://127.0.0.1/items" } },
      }),
    ).toBeNull();
  });

  it("refuses a next page link on another host against the fixture", async () => {
    await expect(
      readAll(fixtureDefinition("next_off_host", fixture.origin)),
    ).rejects.toThrow(CUSTOM_API_MESSAGES.nextUrlOffHost);
    expect(
      fixture.requests.some((request) => request.host.startsWith("localhost")),
    ).toBe(false);
  });

  it("reads the next link of a Link header", () => {
    expect(
      linkHeaderNext(
        '<https://a.example/p2>; rel="next", <https://a.example/p1>; rel="prev"',
      ),
    ).toBe("https://a.example/p2");
    expect(
      linkHeaderNext('<https://a.example/p1>; rel="first"'),
    ).toBeUndefined();
    expect(linkHeaderNext(undefined)).toBeUndefined();
  });

  it("ends on an empty page and a missing cursor", () => {
    const definition = fixtureDefinition("cursor", fixture.origin);
    const base = {
      pagination: definition.streams[0]!.pagination,
      state: { type: "first" } as PageState,
      linkHeader: undefined,
      requestUrl: "http://127.0.0.1/items",
      apiHost: "127.0.0.1",
    };
    expect(
      nextPage({ ...base, body: { meta: { next: "c1" } }, recordCount: 0 }),
    ).toBeNull();
    expect(
      nextPage({ ...base, body: { meta: {} }, recordCount: 3 }),
    ).toBeNull();
    expect(
      nextPage({ ...base, body: { meta: { next: "" } }, recordCount: 3 }),
    ).toBeNull();
    expect(
      nextPage({ ...base, body: { meta: { next: 7 } }, recordCount: 3 }),
    ).toEqual({
      type: "cursor",
      cursor: "7",
    });
  });
});
