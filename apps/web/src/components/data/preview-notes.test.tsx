import { describe, expect, it } from "vitest";

import { renderI18n } from "@/lib/i18n/test-render";

import { PreviewNotes } from "./preview-notes";

describe("PreviewNotes", () => {
  it("says when a source's history is still loading (#635)", () => {
    const warnings = ["source_history_incomplete"];
    expect(renderI18n(<PreviewNotes warnings={warnings} />)).toContain(
      "History incomplete: a source is still loading earlier days",
    );
    expect(renderI18n(<PreviewNotes warnings={warnings} />, "de")).toContain(
      "Verlauf unvollständig: Eine Quelle lädt noch frühere Tage",
    );
  });
});
