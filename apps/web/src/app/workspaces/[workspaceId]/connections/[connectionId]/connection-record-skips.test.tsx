import { describe, expect, it } from "vitest";

import type { ConnectionRecordSkips as StreamRecordSkips } from "@netrics/contracts";

import { ConnectionRecordSkips } from "./connection-record-skips";
import { renderI18n } from "@/lib/i18n/test-render";

// A custom API connection's skipped records per stream (#834 review), in
// English and German: the gate's 3 records dropped silently for an empty
// prompt now show, with the field that skipped them.

const NOW = Date.parse("2026-11-20T12:10:00Z");

const stream = (
  overrides: Partial<StreamRecordSkips> = {},
): StreamRecordSkips => ({
  streamKey: "records",
  streamName: "Records",
  checkedAt: "2026-11-20T12:00:00Z",
  skipped: 0,
  skippedFields: [],
  ...overrides,
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "\n")
    .replace(/&#x27;/g, "'")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

describe("ConnectionRecordSkips", () => {
  it("shows skipped records with the fields that skipped them", () => {
    const skipped = stream({
      skipped: 3,
      skippedFields: [{ path: "image.prompt", count: 3 }],
    });
    const en = text(
      renderI18n(<ConnectionRecordSkips streams={[skipped]} now={NOW} />),
    );
    expect(en).toContain("Skipped records");
    expect(en).toContain(
      "Records: 3 records skipped in the last sync · 10 minutes ago",
    );
    expect(en).toContain("image.prompt was empty or unreadable in 3 records");
    const de = text(
      renderI18n(<ConnectionRecordSkips streams={[skipped]} now={NOW} />, "de"),
    );
    expect(de).toContain("Übersprungene Einträge");
    expect(de).toContain(
      "image.prompt war in 3 Einträgen leer oder nicht lesbar",
    );
  });

  it("says when nothing was skipped, and shows nothing before the first sync", () => {
    expect(
      text(
        renderI18n(<ConnectionRecordSkips streams={[stream()]} now={NOW} />),
      ),
    ).toContain(
      "Records: no records skipped in the last sync · 10 minutes ago",
    );
    expect(renderI18n(<ConnectionRecordSkips streams={[]} now={NOW} />)).toBe(
      "",
    );
  });
});
