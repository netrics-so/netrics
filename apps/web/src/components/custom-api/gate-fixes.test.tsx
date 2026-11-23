import { describe, expect, it, vi } from "vitest";

import {
  customApiDefinitionSchema,
  type CustomApiDefinition,
  type CustomApiTestResponse,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { reachable } from "./builder";
import { FieldMapping } from "./field-mapping";
import { StepBasics } from "./step-basics";
import { ImageHosts, plainSuggestion, StepResponse } from "./step-response";
import { StepSchedule } from "./step-schedule";
import { TEST_RESPONSE } from "./test-fixtures";
import { connectorVersionLabel } from "@/lib/custom-api";
import {
  definitionOf,
  emptyBuilderState,
  imageHostsSeen,
  pickRecords,
  stateFromDefinition,
  toggleField,
  withImageHosts,
  withRequest,
  type BuilderState,
} from "@/lib/custom-api-builder";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// Builder fixes from the milestone 13 exit gate (#834).

const LOCALES: Locale[] = ["en", "de"];
const noop = () => {};

/** A definition with a connection value, as the gate's voilà API. */
const IMAGES: CustomApiDefinition = customApiDefinitionSchema.parse({
  schemaVersion: 2,
  name: "Public images",
  environments: [
    {
      id: "production",
      name: "Production",
      baseUrl: "https://api.example.test",
    },
  ],
  variables: [{ id: "orientation", label: "Orientation", secret: false }],
  auth: { type: "none" },
  streams: [
    {
      key: "records",
      name: "Records",
      request: {
        path: "/images",
        query: { orientation: "{{orientation}}" },
      },
      pagination: { type: "none" },
      records: "results",
      fields: [
        { id: "id", name: "ID", path: "id", type: "string", nullable: false },
        {
          id: "created",
          name: "Created",
          path: "created_at",
          type: "timestamp",
          format: "iso",
          nullable: false,
        },
        {
          id: "url",
          name: "Image",
          path: "url",
          type: "string",
          role: "image",
          nullable: true,
        },
      ],
      keyFields: ["id"],
      reportingField: "created",
      mode: "upsert",
      window: { type: "none" },
    },
  ],
});

function withTest(state: BuilderState, body: unknown): BuilderState {
  const lastTest: CustomApiTestResponse = {
    ...TEST_RESPONSE,
    response: { ...TEST_RESPONSE.response!, body: body as never },
    records: { path: "results", count: 2, found: true },
  };
  return { ...state, lastTest };
}

describe("builder gate fixes (#834)", () => {
  it("shows the Project label once on Basics", () => {
    for (const locale of LOCALES) {
      const html = renderI18n(
        <StepBasics
          state={emptyBuilderState(locale, "UTC")}
          update={noop}
          projects={[]}
        />,
        locale,
      );
      const label = locale === "en" ? "Project" : "Projekt";
      expect(html.match(new RegExp(`>${label}</label>`, "g"))).toHaveLength(1);
    }
  });

  it("opens any step while editing, without test values for connection values", () => {
    const state = stateFromDefinition(IMAGES);
    expect(reachable(state, "response")).toBe(false);
    expect(reachable(state, "response", { editing: true })).toBe(true);
    expect(reachable(state, "review", { editing: true })).toBe(true);
  });

  it("edits a saved definition's fields without a test", () => {
    const html = renderI18n(
      <StepResponse
        state={stateFromDefinition(IMAGES)}
        update={noop}
        pending={false}
        previewStale={false}
        onPickRecords={noop}
        onRefresh={noop}
      />,
    );
    expect(html).toContain("Send a test request to see the response");
    expect(html).toContain('aria-label="url: Name"');
  });

  it("suggests types for array items from the record", () => {
    const record = {
      daily: { time: ["2026-11-14"], temperature_2m_max: [8.8], n: [3] },
    };
    expect(plainSuggestion("daily.time[0]", record)).toMatchObject({
      type: "date",
      format: "iso",
    });
    expect(plainSuggestion("daily.temperature_2m_max[0]", record).type).toBe(
      "number",
    );
    expect(plainSuggestion("daily.n[0]", record).type).toBe("integer");
    expect(plainSuggestion("missing[0]", record).type).toBe("string");
  });

  it("keeps the image hosts of a saved definition and sets new ones", () => {
    const withHosts: CustomApiDefinition = {
      ...IMAGES,
      images: { hosts: ["cdn.example.test"], newestItems: 24 },
    };
    const state = stateFromDefinition(withHosts);
    expect(definitionOf(state, withHosts).images).toEqual(withHosts.images);
    const cleared = withImageHosts(state, []);
    expect(definitionOf(cleared, withHosts)).not.toHaveProperty("images");
    const set = withImageHosts(stateFromDefinition(IMAGES), [
      " CDN.example.test ",
      "",
      "cdn.example.test",
    ]);
    expect(definitionOf(set, IMAGES).images).toEqual({
      hosts: ["cdn.example.test"],
      newestItems: 12,
    });
  });

  it("keeps only the host of pasted URLs and caps image hosts at 10 (#834 review)", () => {
    const state = stateFromDefinition(IMAGES);
    expect(
      withImageHosts(state, [
        "https://CDN.Example.test/images/a.png?x=1",
        "cdn2.example.test.",
        "cdn3.example.test:443/path",
        "*.Media.example.test",
        "cdn.example.test",
      ]).images?.hosts,
    ).toEqual([
      "cdn.example.test",
      "cdn2.example.test",
      "cdn3.example.test",
      "*.media.example.test",
    ]);
    const many = Array.from({ length: 12 }, (_, i) => `cdn${i}.example.test`);
    expect(withImageHosts(state, many).images?.hosts).toHaveLength(10);
    const full = withImageHosts(state, many.slice(0, 10));
    const seen = withTest(full, {
      results: [{ id: "a", url: "https://other.example.test/a.png" }],
    });
    for (const locale of LOCALES) {
      const html = renderI18n(
        <ImageHosts state={seen} update={noop} />,
        locale,
      );
      expect(html).not.toContain("</button>");
      expect(html).toContain(
        locale === "en" ? "at most 10 image hosts" : "höchstens 10 Bild-Hosts",
      );
    }
  });

  it("offers the image hosts seen in the test and names them in the review", () => {
    const state = withTest(stateFromDefinition(IMAGES), {
      results: [
        { id: "a", url: "https://cdn.example.test/a.png" },
        { id: "b", url: "https://api.example.test/b.png" },
      ],
    });
    expect(imageHostsSeen(state)).toEqual([
      "cdn.example.test",
      "api.example.test",
    ]);
    for (const locale of LOCALES) {
      const html = renderI18n(
        <ImageHosts state={state} update={noop} />,
        locale,
      );
      expect(html).toContain(
        locale === "en"
          ? "Allow cdn.example.test</button>"
          : "cdn.example.test erlauben</button>",
      );
    }
    const allowed = withImageHosts(state, imageHostsSeen(state));
    expect(
      renderI18n(<ImageHosts state={allowed} update={noop} />),
    ).not.toContain("Allow");
    const review = renderI18n(
      <StepSchedule state={allowed} update={noop} onGoTo={noop} />,
    );
    expect(review).toContain("netrics will send requests to api.example.test.");
    expect(review).toContain(
      "netrics will copy images from cdn.example.test and api.example.test.",
    );
  });

  it("warns about a number key and offers the time field, but keeps a text key quiet", () => {
    const field = (
      path: string,
      name: string,
      type: "string" | "number" | "timestamp",
    ) => ({
      path,
      id: path,
      name,
      type,
      nullable: false,
      samples: [],
      ...(type === "timestamp" ? { format: "iso" as const } : {}),
    });
    const ticked = (first: ReturnType<typeof field>) => {
      let state: BuilderState = {
        ...emptyBuilderState("en", "UTC"),
        name: "Images",
        environments: [
          {
            id: "production",
            name: "Production",
            baseUrl: "https://api.example.test",
          },
        ],
      };
      state = pickRecords(withRequest(state, { path: "/images" }), "results");
      state = toggleField(state, first, true);
      return toggleField(
        state,
        field("created_at", "Created", "timestamp"),
        true,
      );
    };
    const text = ticked(field("short_id", "Short ID", "string"));
    expect(text.stream.keyFields).toEqual(["short_id"]);
    expect(
      renderI18n(<FieldMapping state={text} update={noop} suggestions={[]} />),
    ).not.toContain("as key");
    const number = ticked(field("score", "Score", "number"));
    expect(number.stream.keyFields).toEqual(["score"]);
    for (const locale of LOCALES) {
      const html = renderI18n(
        <FieldMapping state={number} update={noop} suggestions={[]} />,
        locale,
      );
      expect(html).toContain('class="notice warning"');
      expect(html).toContain(
        locale === "en"
          ? "Records with the same Score merge into one"
          : "Einträge mit demselben Wert in Score werden zu einem",
      );
      expect(html).toContain(
        locale === "en" ? "Use Created as key" : "Created als Schlüssel nehmen",
      );
    }
  });

  it("labels a custom API connection with its definition version", () => {
    expect(
      connectorVersionLabel({
        connectorVersion: "1.0.2",
        customApi: { version: 2 },
      }),
    ).toBe("v2");
    expect(
      connectorVersionLabel({ connectorVersion: "0.4.1", customApi: null }),
    ).toBe("0.4.1");
  });
});
