import { describe, expect, it } from "vitest";

import {
  upgradeCustomApiDefinition,
  type CustomApiDefinition,
} from "@netrics/contracts";

import { customApiDatasetVersions } from "./dataset-versions.js";
import { customApiFixture } from "./test-helpers.js";

type Doc = Record<string, unknown>;
type StreamDoc = Doc & { fields: Doc[] };

function shopDoc(): Doc & { streams: StreamDoc[]; defaults: Doc } {
  return customApiFixture("v1-shop") as Doc & {
    streams: StreamDoc[];
    defaults: Doc;
  };
}

function parse(doc: Doc): CustomApiDefinition {
  return upgradeCustomApiDefinition(doc);
}

const shop = parse(shopDoc());
const v1 = { document: shop, datasetVersions: { daily_stats: 1 } };

function changed(edit: (doc: ReturnType<typeof shopDoc>) => void) {
  const doc = shopDoc();
  edit(doc);
  return customApiDatasetVersions(v1, parse(doc));
}

function secondStream(key: string): StreamDoc {
  const stream = structuredClone(shopDoc().streams[0]!);
  stream.key = key;
  stream.name = key;
  return stream;
}

describe("customApiDatasetVersions", () => {
  it("starts every stream at version 1", () =>
    expect(customApiDatasetVersions(null, shop)).toEqual({ daily_stats: 1 }));

  it("keeps the version when only names, paths or paging change", () => {
    expect(
      changed((doc) => {
        doc.name = "Shop API renamed";
        const stream = doc.streams[0]!;
        stream.name = "Stats per day";
        stream.records = "items";
        stream.pagination = { type: "page_number", param: "page" };
        stream.request = { path: "/stats" };
        stream.fields[1]!.name = "Order count";
        stream.fields[1]!.path = "counts.orders";
        stream.fields[0]!.format = "yyyy-MM-dd";
      }),
    ).toEqual({ daily_stats: 1 });
  });

  it("keeps the version when fields are only reordered", () => {
    expect(
      changed((doc) => {
        doc.streams[0]!.fields.reverse();
      }),
    ).toEqual({ daily_stats: 1 });
  });

  it("bumps the version when a field's type, nullability or role changes", () => {
    expect(
      changed((doc) => {
        doc.streams[0]!.fields[1]!.type = "decimal";
      }),
    ).toEqual({ daily_stats: 2 });
    expect(
      changed((doc) => {
        doc.streams[0]!.fields[1]!.nullable = false;
      }),
    ).toEqual({ daily_stats: 2 });
    expect(
      changed((doc) => {
        doc.streams[0]!.fields[1]!.classification = "public";
      }),
    ).toEqual({ daily_stats: 2 });
  });

  it("bumps it when a field is added or removed", () => {
    expect(
      changed((doc) => {
        doc.streams[0]!.fields.push({
          id: "refunds",
          name: "Refunds",
          path: "refunds",
          type: "integer",
        });
      }),
    ).toEqual({ daily_stats: 2 });
    expect(
      changed((doc) => {
        doc.streams[0]!.fields.splice(1, 1);
      }),
    ).toEqual({ daily_stats: 2 });
  });

  it("bumps it when the key fields or mode change", () => {
    expect(
      changed((doc) => {
        doc.streams[0]!.keyFields = ["day", "currency"];
      }),
    ).toEqual({ daily_stats: 2 });
    expect(
      changed((doc) => {
        doc.streams[0]!.mode = "replace_window";
      }),
    ).toEqual({ daily_stats: 2 });
  });

  it("drops removed streams and starts added ones at 1", () => {
    const two = shopDoc();
    two.streams.push(secondStream("weekly_stats"));
    const withTwo = parse(two);
    expect(customApiDatasetVersions(v1, withTwo)).toEqual({
      daily_stats: 1,
      weekly_stats: 1,
    });
    const onlyWeekly = shopDoc();
    onlyWeekly.streams = [secondStream("weekly_stats")];
    expect(
      customApiDatasetVersions(
        {
          document: withTwo,
          datasetVersions: { daily_stats: 4, weekly_stats: 2 },
        },
        parse(onlyWeekly),
      ),
    ).toEqual({ weekly_stats: 2 });
  });

  it("bumps when the time zone of a date reporting field changes", () => {
    expect(
      changed((doc) => {
        doc.defaults.timeZone = "Europe/Berlin";
      }),
    ).toEqual({ daily_stats: 2 });
  });

  it("keeps the version when the time zone changes without a date reporting field", () => {
    const previous = shopDoc();
    delete previous.streams[0]!.reportingField;
    previous.streams[0]!.window = { type: "none" };
    previous.streams[0]!.request = { path: "/stats" };
    const before = parse(previous);
    const next = structuredClone(previous);
    next.defaults.timeZone = "Europe/Berlin";
    expect(
      customApiDatasetVersions(
        { document: before, datasetVersions: { daily_stats: 3 } },
        parse(next),
      ),
    ).toEqual({ daily_stats: 3 });
  });
});
