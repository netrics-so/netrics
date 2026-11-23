import { describe, expect, it } from "vitest";

import type { Locale } from "@netrics/domain";

import { CustomApiConnectionRequests } from "./connection-requests";
import { renderI18n } from "@/lib/i18n/test-render";
import { customApiDe } from "@/messages/custom-api/de";
import { customApiEn } from "@/messages/custom-api/en";

// ADR 0030: a connection shows what it sends, POST bodies included.

const REQUESTS = [
  {
    stream: "daily",
    name: "Daily",
    method: "GET" as const,
    path: "/stats",
    body: null,
  },
  {
    stream: "items",
    name: "Items",
    method: "POST" as const,
    path: "/graphql",
    body: {
      kind: "graphql" as const,
      query: "query Items { items { id } }",
      variables: { project: "{{project_id}}" },
    },
  },
  {
    stream: "events",
    name: "Events",
    method: "POST" as const,
    path: "/query",
    body: {
      kind: "json" as const,
      value: { kind: "EventsQuery", after: "{{window.start}}" },
      readOnlyConfirmed: true,
    },
  },
];

describe("CustomApiConnectionRequests", () => {
  it.each<Locale>(["en", "de"])(
    "shows each stream's method, path and body template (%s)",
    (locale) => {
      const c = (locale === "de" ? customApiDe : customApiEn).customApi
        .connectionRequests;
      const html = renderI18n(
        <CustomApiConnectionRequests requests={REQUESTS} />,
        locale,
      ).replaceAll("&#x27;", "'");
      expect(html).toContain(c.title);
      expect(html).toContain("GET /stats");
      expect(html).toContain("POST /graphql");
      expect(html).toContain("query Items { items { id } }");
      expect(html).toContain("{{project_id}}");
      expect(html).toContain("POST /query");
      expect(html).toContain("EventsQuery");
      expect(html).toContain(c.jsonReadOnly);
      expect(html).toContain(c.graphql);
    },
  );

  it("renders nothing without requests", () => {
    expect(renderI18n(<CustomApiConnectionRequests requests={[]} />)).toBe("");
  });
});
