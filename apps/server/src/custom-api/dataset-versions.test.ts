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

  it("continues a removed and re-added stream after its highest past version", () => {
    // v1: shop + s; v2: s's fields change; v3: s removed; v4: s re-added.
    const withS = shopDoc();
    withS.streams.push(secondStream("s"));
    const first = parse(withS);
    const v1Versions = customApiDatasetVersions(null, first);
    expect(v1Versions).toEqual({ daily_stats: 1, s: 1 });
    const changedS = structuredClone(withS);
    changedS.streams[1]!.fields[1]!.type = "decimal";
    const second = parse(changedS);
    const v2Versions = customApiDatasetVersions(
      { document: first, datasetVersions: v1Versions },
      second,
      v1Versions,
    );
    expect(v2Versions).toEqual({ daily_stats: 1, s: 2 });
    const third = parse(shopDoc());
    const v3Versions = customApiDatasetVersions(
      { document: second, datasetVersions: v2Versions },
      third,
      { daily_stats: 1, s: 2 },
    );
    expect(v3Versions).toEqual({ daily_stats: 1 });
    // Re-added with the same fields as in v2: still a new version.
    const v4Versions = customApiDatasetVersions(
      { document: third, datasetVersions: v3Versions },
      second,
      { daily_stats: 1, s: 2 },
    );
    expect(v4Versions).toEqual({ daily_stats: 1, s: 3 });
  });

  it("bumps a changed stream past its highest version, not only the previous one", () => {
    expect(
      customApiDatasetVersions(
        v1,
        parse(
          (() => {
            const doc = shopDoc();
            doc.streams[0]!.fields[1]!.type = "decimal";
            return doc;
          })(),
        ),
        { daily_stats: 5 },
      ),
    ).toEqual({ daily_stats: 6 });
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
