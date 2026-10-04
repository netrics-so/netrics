import { describe, expect, it } from "vitest";

import type { FormatWarning } from "@netrics/contracts";

import { renderI18n } from "@/lib/i18n/test-render";

import { FormatAttention, formatRatio } from "./format-attention";

// The Studio header's readability summary (ADR 0017 section 6, #280).

const ID = "00000000-0000-4000-8000-000000000001";

function warning(
  format: FormatWarning["format"],
  code: FormatWarning["code"],
  severity: FormatWarning["severity"],
): FormatWarning {
  return { format, code, severity, widgetId: ID, pages: null, rows: null };
}

const slides = [
  {
    formatWarnings: [
      warning("9x16", "label_cut", "attention"),
      warning("3x4", "continues", "info"),
    ],
  },
  {
    formatWarnings: [
      warning("21x9", "text_cut", "attention"),
      warning("9x16", "widget_to_review", "attention"),
      warning("4x3", "header_name_cut", "attention"),
    ],
  },
];

describe("FormatAttention", () => {
  it("counts the formats that need attention, in English and German", () => {
    const en = renderI18n(<FormatAttention slides={slides} />, "en");
    expect(en).toContain("3 formats need attention");
    expect(en).toContain("21:9, 4:3, and 9:16");
    const de = renderI18n(<FormatAttention slides={slides} />, "de");
    expect(de).toContain("3 Formate brauchen Aufmerksamkeit");
    expect(de).toContain("21:9, 4:3 und 9:16");
  });

  it("uses the singular for one format", () => {
    const one = [
      { formatWarnings: [warning("9x16", "label_cut", "attention")] },
    ];
    expect(renderI18n(<FormatAttention slides={one} />, "en")).toContain(
      "1 format needs attention",
    );
    expect(renderI18n(<FormatAttention slides={one} />, "de")).toContain(
      "1 Format braucht Aufmerksamkeit",
    );
  });

  it("shows nothing for information only (continuation pages, hidden widgets)", () => {
    const info = [
      {
        formatWarnings: [
          warning("9x16", "continues", "info"),
          warning("3x4", "widget_hidden", "info"),
        ],
      },
    ];
    expect(renderI18n(<FormatAttention slides={info} />, "en")).toBe("");
    expect(renderI18n(<FormatAttention slides={[]} />, "en")).toBe("");
  });

  it("writes formats as ratios", () => {
    expect(formatRatio("16x9")).toBe("16:9");
    expect(formatRatio("3x4")).toBe("3:4");
  });
});
