import { describe, expect, it } from "vitest";

import {
  FORMAT_WARNING_CODES,
  FORMAT_WARNING_SEVERITY,
  STUDIO_HEADER_METRICS,
  formatWarnings,
  formatsNeedingAttention,
  headerFit,
  slideFormatWarnings,
  textWidgetFit,
  type FormatWarningItem,
  type ReadabilityContext,
  type ReadabilitySlide,
  type ReadabilityWidget,
} from "./format-readability.js";
import { reflowSlide, type CustomLayout } from "./screen-formats.js";
import {
  SCREEN_FORMAT_KEYS,
  estimateTextWidth,
  labelFit,
  type ScreenFormat,
} from "./studio-layout.js";

// Readability per format (ADR 0017 section 6, #280): one case per warning
// kind, in the formats where it shows and not where it does not.

const context: ReadabilityContext = {
  primaryFormat: "16x9",
  fontScale: 1,
  showHeader: true,
  dashboardName: "Overview",
  logoAspect: null,
};

function slide(
  widgets: ReadabilityWidget[],
  layouts: ReadabilitySlide["layouts"] = {},
  name: string | null = "Sales",
): ReadabilitySlide {
  return { name, widgets, layouts };
}

/** "format code widget" per warning, compact for expectations. */
function codes(warnings: readonly FormatWarningItem[]): string[] {
  return warnings.map((warning) =>
    [
      warning.format,
      warning.code,
      warning.widgetId ?? "-",
      ...(warning.pages === null ? [] : [String(warning.pages)]),
    ].join(" "),
  );
}

function byFormat(
  warnings: readonly FormatWarningItem[],
): Record<ScreenFormat, string[]> {
  return Object.fromEntries(
    SCREEN_FORMAT_KEYS.map((format) => [
      format,
      warnings
        .filter((warning) => warning.format === format)
        .map((warning) => `${warning.code} ${warning.widgetId ?? "-"}`),
    ]),
  ) as Record<ScreenFormat, string[]>;
}

/** Two metrics side by side, half the 16:9 grid each. */
const halves = (label: string): ReadabilityWidget[] => [
  { id: "a", type: "metric", x: 0, y: 0, w: 6, h: 2, label },
  { id: "b", type: "metric", x: 6, y: 0, w: 6, h: 2, label },
];

describe("formatWarnings", () => {
  it("a slide that reads well everywhere has none", () => {
    const warnings = slideFormatWarnings(
      slide([
        ...halves("Downloads · Wurfel"),
        {
          id: "t",
          type: "text",
          x: 0,
          y: 2,
          w: 12,
          h: 2,
          text: "## This week\nShip it.",
          textSize: "body",
        },
        { id: "c", type: "clock", x: 0, y: 4, w: 2, h: 1 },
      ]),
      context,
    );
    expect(codes(warnings)).toEqual(
      // The 16:9 slide is too tall for the portrait grid once each widget
      // keeps its minimum: auto continues on a second page, never cuts.
      codes(warnings).filter((code) => code.includes(" continues ")),
    );
  });

  it("label_cut: a long German label fits at 16:9 but not in the narrow formats", () => {
    const label =
      "Registrierungen · Durchschnittliche Bestellwerte aller Neukunden";
    expect(
      byFormat(slideFormatWarnings(slide(halves(label)), context)),
    ).toEqual({
      "21x9": [],
      "16x9": [],
      "4x3": [],
      "3x4": ["label_cut a", "label_cut b"],
      "9x16": ["label_cut a", "label_cut b"],
    });
    // The rule is labelFit at the format's reference canvas, with the size
    // the widget has in the format's layout.
    const portrait = reflowSlide(halves(label), "16x9", "9x16")[0]!;
    expect(portrait.map(({ w }) => w)).toEqual([3, 3]);
    expect(
      labelFit(label, { type: "metric", w: 3, h: 3 }, { format: "9x16" }).fits,
    ).toBe(false);
    expect(
      labelFit(label, { type: "metric", w: 6, h: 2 }, { format: "16x9" }).fits,
    ).toBe(true);
  });

  it("label_cut follows the theme's font scale", () => {
    const label = "Durchschnittliche Sitzungsdauer pro Besucher";
    const widgets: ReadabilityWidget[] = [
      { id: "m", type: "metric", x: 0, y: 0, w: 4, h: 2, label },
    ];
    const at = (fontScale: number) =>
      formatWarnings(slide(widgets), "16x9", { ...context, fontScale });
    expect(codes(at(1))).toEqual([]);
    expect(codes(at(1.3))).toEqual(["16x9 label_cut m"]);
  });

  it("label_cut is checked on charts too, and widgets without a label never warn", () => {
    const label = "Durchschnittliche Bestellwerte aller Neukunden";
    const warnings = formatWarnings(
      slide([
        { id: "l", type: "line", x: 0, y: 0, w: 4, h: 3, label },
        { id: "n", type: "metric", x: 4, y: 0, w: 3, h: 2, label: null },
        { id: "i", type: "image", x: 8, y: 0, w: 1, h: 1 },
      ]),
      "16x9",
      context,
    );
    expect(codes(warnings)).toEqual([]);
    expect(
      codes(
        formatWarnings(
          slide([
            {
              id: "l",
              type: "bar",
              x: 0,
              y: 0,
              w: 4,
              h: 3,
              label: `${label} und Bestandskunden im Vergleichszeitraum`,
            },
          ]),
          "16x9",
          context,
        ),
      ),
    ).toEqual(["16x9 label_cut l"]);
  });

  it("text_cut: text that fits the primary box overflows the narrower auto box", () => {
    const text = Array.from(
      { length: 7 },
      () =>
        "Alle Zahlen dieser Folie beziehen sich auf die letzten sieben Tage.",
    ).join("\n");
    const widgets: ReadabilityWidget[] = [
      {
        id: "t",
        type: "text",
        x: 0,
        y: 0,
        w: 12,
        h: 3,
        text,
        textSize: "body",
      },
    ];
    const warnings = byFormat(slideFormatWarnings(slide(widgets), context));
    expect(warnings["16x9"]).toEqual([]);
    expect(warnings["21x9"]).toEqual([]);
    // The width is the grid's in every format; only the line count differs.
    expect(warnings["3x4"]).toEqual(["text_cut t"]);
    expect(warnings["9x16"]).toEqual(["text_cut t"]);
  });

  it("text_cut: a text that does not fit even at body size", () => {
    const widgets: ReadabilityWidget[] = [
      {
        id: "t",
        type: "text",
        x: 0,
        y: 0,
        w: 2,
        h: 1,
        text: "A sentence much too long for a two by one box on any screen.",
        textSize: "display",
      },
    ];
    expect(
      SCREEN_FORMAT_KEYS.every((format) =>
        codes(formatWarnings(slide(widgets), format, context)).includes(
          `${format} text_cut t`,
        ),
      ),
    ).toBe(true);
  });

  it("continues: the number of pages when auto needs continuation pages", () => {
    // A full 16:9 slide of eight 3 × 2 metrics and a chart band.
    const widgets: ReadabilityWidget[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `m${i}`,
        type: "metric" as const,
        x: (i % 4) * 3,
        y: Math.floor(i / 4) * 2,
        w: 3,
        h: 2,
        label: "Downloads",
      })),
      { id: "l", type: "line", x: 0, y: 4, w: 12, h: 4, label: "Trend" },
    ];
    const warnings = slideFormatWarnings(slide(widgets), context);
    const pages = (format: ScreenFormat) =>
      reflowSlide(widgets, "16x9", format).length;
    expect(pages("16x9")).toBe(1);
    expect(pages("3x4")).toBe(2);
    expect(codes(warnings)).toEqual(
      SCREEN_FORMAT_KEYS.filter((format) => pages(format) > 1).map(
        (format) => `${format} continues - ${pages(format)}`,
      ),
    );
    expect(warnings.every((warning) => warning.severity === "info")).toBe(true);
  });

  it("custom layouts: hidden, to review and too small widgets, and custom pages", () => {
    const widgets: ReadabilityWidget[] = [
      { id: "a", type: "metric", x: 0, y: 0, w: 3, h: 2, label: "Downloads" },
      { id: "b", type: "metric", x: 3, y: 0, w: 3, h: 2, label: "Proceeds" },
      { id: "c", type: "line", x: 0, y: 2, w: 6, h: 3, label: "Trend" },
      { id: "d", type: "clock", x: 6, y: 0, w: 2, h: 1 },
    ];
    const custom: CustomLayout = {
      pages: 2,
      placements: [
        {
          id: "a",
          page: 0,
          x: 0,
          y: 0,
          w: 3,
          h: 2,
          hidden: false,
          autoPlaced: false,
        },
        {
          id: "b",
          page: 0,
          x: 3,
          y: 0,
          w: 3,
          h: 2,
          hidden: false,
          autoPlaced: true,
        },
        // Stored below the line chart's 4 × 3 minimum (the server refuses
        // these on save; reported for completeness).
        {
          id: "c",
          page: 1,
          x: 0,
          y: 0,
          w: 3,
          h: 3,
          hidden: false,
          autoPlaced: false,
        },
        {
          id: "d",
          page: 0,
          x: 0,
          y: 2,
          w: 2,
          h: 1,
          hidden: true,
          autoPlaced: false,
        },
      ],
    };
    const warnings = formatWarnings(
      slide(widgets, { "9x16": custom }),
      "9x16",
      context,
    );
    expect(codes(warnings)).toEqual([
      "9x16 continues - 2",
      "9x16 widget_to_review b",
      // The clock comes before the chart in reading order.
      "9x16 widget_hidden d",
      "9x16 widget_too_small c",
    ]);
    expect(warnings.map((warning) => warning.severity)).toEqual([
      "info",
      "attention",
      "info",
      "attention",
    ]);
    // The custom layout is only the 9:16 one; the primary ignores layouts.
    expect(
      codes(
        formatWarnings(slide(widgets, { "16x9": custom }), "16x9", context),
      ),
    ).toEqual([]);
  });

  it("measures labels at the custom placement's size", () => {
    const label =
      "Registrierungen · Durchschnittliche Bestellwerte aller Neukunden";
    const widgets = halves(label);
    const wide: CustomLayout = {
      pages: 2,
      placements: [
        {
          id: "a",
          page: 0,
          x: 0,
          y: 0,
          w: 6,
          h: 2,
          hidden: false,
          autoPlaced: false,
        },
        {
          id: "b",
          page: 1,
          x: 0,
          y: 0,
          w: 6,
          h: 2,
          hidden: false,
          autoPlaced: false,
        },
      ],
    };
    expect(
      codes(formatWarnings(slide(widgets, { "9x16": wide }), "9x16", context)),
    ).toEqual(["9x16 continues - 2"]);
  });

  it("header_name_cut: a name that fits at 16:9 but not on narrow screens", () => {
    const name =
      "Unternehmenskennzahlen Vertrieb und Marketing Europa, Naher Osten und Afrika";
    const warnings = byFormat(
      slideFormatWarnings(slide([]), {
        ...context,
        dashboardName: name,
        logoAspect: 1,
      }),
    );
    expect(warnings).toEqual({
      "21x9": [],
      "16x9": [],
      "4x3": ["header_name_cut -"],
      "3x4": ["header_name_cut -"],
      "9x16": ["header_name_cut -"],
    });
    // Without the header nothing is checked.
    expect(
      slideFormatWarnings(slide([]), {
        ...context,
        dashboardName: name,
        showHeader: false,
      }),
    ).toEqual([]);
  });

  it("lists the header, then pages, then widgets in reading order", () => {
    const warnings = formatWarnings(
      slide([
        {
          id: "late",
          type: "metric",
          x: 6,
          y: 2,
          w: 6,
          h: 2,
          label: "x ".repeat(80),
        },
        {
          id: "early",
          type: "metric",
          x: 0,
          y: 0,
          w: 6,
          h: 2,
          label: "y ".repeat(80),
        },
      ]),
      "16x9",
      { ...context, dashboardName: "N".repeat(100) },
    );
    expect(codes(warnings)).toEqual([
      "16x9 header_name_cut -",
      "16x9 label_cut early",
      "16x9 label_cut late",
    ]);
  });

  it("every code has a severity", () => {
    expect(Object.keys(FORMAT_WARNING_SEVERITY).sort()).toEqual(
      [...FORMAT_WARNING_CODES].sort(),
    );
  });
});

describe("headerFit", () => {
  it("keeps short names on one line with the slide name", () => {
    for (const format of SCREEN_FORMAT_KEYS) {
      expect(
        headerFit({
          name: "Overview",
          slideName: "Sales",
          format,
          logoAspect: 1,
        }),
      ).toMatchObject({ nameLines: 1, showSlideName: true, fits: true });
    }
  });

  it("drops the slide name before the dashboard name wraps or is cut", () => {
    const name = "Unternehmenskennzahlen Vertrieb und Marketing Europa";
    expect(
      headerFit({ name, slideName: "Heute", format: "16x9", logoAspect: 1 }),
    ).toMatchObject({ nameLines: 1, showSlideName: true, fits: true });
    expect(
      headerFit({ name, slideName: "Heute", format: "4x3", logoAspect: 1 }),
    ).toMatchObject({ nameLines: 1, showSlideName: false, fits: true });
    // Narrow formats wrap the name to two lines before it would shrink.
    expect(
      headerFit({ name, slideName: "Heute", format: "9x16", logoAspect: 1 }),
    ).toMatchObject({
      nameLines: 2,
      maxNameLines: 2,
      showSlideName: false,
      fits: true,
    });
  });

  it("counts the logo's width at its aspect ratio", () => {
    const m = STUDIO_HEADER_METRICS;
    const without = headerFit({
      name: "A",
      slideName: null,
      format: "16x9",
      logoAspect: null,
    });
    const wide = headerFit({
      name: "A",
      slideName: null,
      format: "16x9",
      logoAspect: 3,
    });
    expect(without.width - wide.width).toBeCloseTo(m.logo * 3 + m.gap);
    // A logo without a usable size counts as none.
    expect(
      headerFit({ name: "A", slideName: null, format: "16x9", logoAspect: 0 })
        .width,
    ).toBe(without.width);
    expect(without.width).toBeCloseTo(
      1920 -
        2 * m.padding -
        2 * m.gap -
        m.clockSpace -
        estimateTextWidth("12:00 PM", m.meta),
    );
  });
});

describe("textWidgetFit", () => {
  it("steps down from display to body before it overflows", () => {
    const placement = { x: 0, y: 0, w: 6, h: 2 };
    const fit = (text: string) =>
      textWidgetFit({
        text,
        size: "display",
        placement,
        fontScale: 1,
        showHeader: true,
      });
    expect(fit("Hi")).toMatchObject({ size: "display", overflow: false });
    expect(fit("A headline that needs several words")).toMatchObject({
      size: "heading",
      overflow: false,
    });
    expect(fit("word ".repeat(200)).overflow).toBe(true);
  });

  it("measures at the format's reference canvas", () => {
    const text = "word ".repeat(40);
    const at = (format: ScreenFormat) =>
      textWidgetFit({
        text,
        size: "body",
        placement: { x: 0, y: 0, w: 6, h: 2 },
        fontScale: 1,
        showHeader: true,
        format,
      }).overflow;
    // Six columns are half the 16:9 grid but all of the portrait one.
    expect(at("16x9")).toBe(true);
    expect(at("9x16")).toBe(false);
  });
});

describe("formatsNeedingAttention", () => {
  it("counts formats with an attention warning, widest first", () => {
    const warning = (format: ScreenFormat, severity: "attention" | "info") => ({
      format,
      severity,
    });
    expect(
      formatsNeedingAttention([
        {
          formatWarnings: [
            warning("9x16", "attention"),
            warning("3x4", "info"),
          ],
        },
        {
          formatWarnings: [
            warning("21x9", "attention"),
            warning("9x16", "attention"),
          ],
        },
        { formatWarnings: [] },
      ]),
    ).toEqual(["21x9", "9x16"]);
    expect(formatsNeedingAttention([])).toEqual([]);
  });
});
