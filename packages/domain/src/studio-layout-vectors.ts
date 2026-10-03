/**
 * Test vectors for the studio layout (ADR 0015, section 8), computed from
 * the TypeScript implementation. They are checked in at
 * packages/domain/test-vectors/studio-layout.json; the domain tests fail
 * when the file and this output differ, and the Swift tests in
 * apps/tvos/NetricsKit run the same file. Regenerate with
 * `pnpm vectors:studio` after a deliberate change, and port the change to
 * StudioLayout.swift.
 *
 * Not exported from the package index: only tests use it.
 */
import {
  STUDIO_MIN_WIDGET_SIZE,
  STUDIO_WIDGET_TYPES,
  compactNumber,
  estimateTextWidth,
  findOverlaps,
  fitTextSize,
  isInsideGrid,
  labelFit,
  legacyGrid,
  legacyLayout,
  meetsMinimumSize,
  parseTextWidget,
  studioFrame,
  textWidgetSizes,
  widgetRect,
  widgetTypeScale,
  wrappedLineCount,
  type StudioCanvas,
  type StudioFontWeight,
  type StudioPlacement,
  type StudioTextSize,
} from "./studio-layout.js";

const CANVASES: StudioCanvas[] = [
  { width: 1920, height: 1080 },
  { width: 3840, height: 2160 },
  { width: 1280, height: 720 },
  { width: 1000, height: 700 },
];

const PLACEMENTS: StudioPlacement[] = [
  { x: 0, y: 0, w: 1, h: 1 },
  { x: 0, y: 0, w: 12, h: 8 },
  { x: 3, y: 2, w: 4, h: 3 },
  { x: 11, y: 7, w: 1, h: 1 },
  { x: 0, y: 0, w: 3, h: 2 },
  { x: 6, y: 4, w: 6, h: 4 },
];

const SIZES: StudioPlacement[] = [
  { x: 0, y: 0, w: 1, h: 1 },
  { x: 0, y: 0, w: 2, h: 1 },
  { x: 0, y: 0, w: 3, h: 2 },
  { x: 0, y: 0, w: 4, h: 3 },
  { x: 0, y: 0, w: 6, h: 4 },
  { x: 0, y: 0, w: 12, h: 8 },
];

const FONT_SCALES = [1, 1.15, 1.3, 0.8];

const TEXTS = [
  "",
  "Downloads",
  "Proceeds · Wurfel",
  "WWWWWWWWWW",
  "iiiiiiiiii",
  "12,345.67",
  "$4.2M",
  "Übersicht — Ärger",
  "日本語のアプリ",
  "App 🚀 launch",
];

const LABELS = [
  "Downloads",
  "Downloads · Wurfel",
  "Proceeds · All apps",
  "Impressions · sc-domain:example.com",
  "Average position · https://www.example.com/blog/",
  "Ratings and reviews · Wurfel: Würfel-Spiel für die ganze Familie",
  "Visitors · my-very-long-vercel-project-name-for-the-marketing-site",
  "A custom title that the owner typed in a rather long-winded way, much longer than any tile would need",
  "Downloads ·  ",
  "Supercalifragilisticexpialidocious",
];

const MARKDOWN = [
  "",
  "Hello",
  "Hello\nWorld",
  "One\n\nTwo",
  "One\n\n\n\nTwo\r\nThree",
  "# Wurfel\nDaily numbers",
  "## Sales\n\nUp **12%** this *week*",
  "#No space is literal",
  "### Three is literal",
  "#",
  "# ",
  "**bold** and *italic*",
  "***both***",
  "**bold with *italic* inside**",
  "*italic with **bold** inside*",
  "2 * 3 * 4",
  "a ** b ** c",
  "**unclosed bold",
  "*unclosed italic",
  "** not bold**",
  "*not italic *",
  "<b>html</b> & <script>alert(1)</script>",
  "[link](https://example.com) ![img](x.png)",
  "- list item\n1. numbered",
  "`code` and _underscore_ and __double__",
  "   indented line   \n\ttabbed\t",
  "**a**b**c**",
  "*a*b*c*",
  "Emoji 🚀 *fast*",
  "****",
  "**",
  "* *",
];

const COMPACT = [
  0,
  -0,
  0.004,
  0.005,
  1,
  3.14159,
  42.25,
  99.995,
  100.4,
  999,
  999.4,
  999.6,
  1000,
  1049,
  1050,
  1234,
  9999,
  10_000,
  12_345,
  12_350,
  99_949,
  99_950,
  999_949,
  999_950,
  1_000_000,
  1_234_567,
  4_200_000,
  999_999_999,
  1.5e9,
  2.75e12,
  1.2e15,
  -1284,
  -12_345,
  -4_200_000,
  Number.NaN,
];

function words(): Array<{
  text: string;
  fontSize: number;
  weight: StudioFontWeight;
}> {
  const weights: StudioFontWeight[] = ["regular", "semibold", "bold"];
  return TEXTS.flatMap((text, i) => [
    { text, fontSize: 30, weight: weights[i % 3]! },
    { text, fontSize: 64, weight: "bold" as const },
  ]);
}

export function buildStudioLayoutVectors() {
  const frames = CANVASES.flatMap((canvas) =>
    [true, false].map((showHeader) => ({
      canvas,
      showHeader,
      ...studioFrame(canvas, showHeader),
    })),
  );

  const rects = CANVASES.flatMap((canvas) =>
    [true, false].flatMap((showHeader) =>
      PLACEMENTS.map((placement) => ({
        canvas,
        showHeader,
        placement,
        rect: widgetRect(placement, canvas, showHeader),
      })),
    ),
  );

  const insideGrid = [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 0, y: 0, w: 12, h: 8 },
    { x: 11, y: 7, w: 1, h: 1 },
    { x: 11, y: 7, w: 2, h: 1 },
    { x: 0, y: 7, w: 1, h: 2 },
    { x: -1, y: 0, w: 1, h: 1 },
    { x: 0, y: 0, w: 0, h: 1 },
    { x: 0, y: 0, w: 1, h: 0 },
    { x: 0.5, y: 0, w: 1, h: 1 },
    { x: 0, y: 0, w: 13, h: 1 },
  ].map((placement) => ({ placement, inside: isInsideGrid(placement) }));

  const minimumSize = STUDIO_WIDGET_TYPES.flatMap((type) =>
    SIZES.map((placement) => ({
      type,
      w: placement.w,
      h: placement.h,
      meets: meetsMinimumSize(type, placement),
    })),
  );

  const overlapSets: StudioPlacement[][] = [
    [],
    [{ x: 0, y: 0, w: 3, h: 2 }],
    [
      { x: 0, y: 0, w: 3, h: 2 },
      { x: 3, y: 0, w: 3, h: 2 },
      { x: 0, y: 2, w: 3, h: 2 },
    ],
    [
      { x: 0, y: 0, w: 4, h: 3 },
      { x: 3, y: 2, w: 4, h: 3 },
      { x: 6, y: 0, w: 2, h: 8 },
      { x: 0, y: 0, w: 12, h: 8 },
    ],
  ];
  const overlaps = overlapSets.map((placements) => ({
    placements,
    pairs: findOverlaps(placements),
  }));

  const typeScales = STUDIO_WIDGET_TYPES.flatMap((type) =>
    SIZES.filter((size) => meetsMinimumSize(type, size)).flatMap((placement) =>
      FONT_SCALES.flatMap((fontScale) =>
        [true, false].map((showHeader) => ({
          type,
          w: placement.w,
          h: placement.h,
          fontScale,
          showHeader,
          sizes: widgetTypeScale(type, placement, { fontScale, showHeader }),
        })),
      ),
    ),
  );

  const textSizes = (
    ["body", "heading", "display"] as StudioTextSize[]
  ).flatMap((size) =>
    FONT_SCALES.map((fontScale) => ({
      size,
      fontScale,
      ...textWidgetSizes(size, fontScale),
    })),
  );

  const textWidths = words().map((input) => ({
    ...input,
    width: estimateTextWidth(input.text, input.fontSize, input.weight),
  }));

  const wrapping = [...TEXTS, ...LABELS].flatMap((text) =>
    [200, 404, 900].map((maxWidth) => ({
      text,
      maxWidth,
      fontSize: 30,
      weight: "semibold" as const,
      lines: wrappedLineCount(text, maxWidth, 30, "semibold"),
    })),
  );

  const fitSizes = [
    "1,284",
    "12,345,678",
    "$1,234.56",
    "12.3K",
    "—",
    "",
  ].flatMap((text) =>
    [100, 300, 600].map((maxWidth) => ({
      text,
      maxWidth,
      min: 64,
      max: 160,
      weight: "bold" as const,
      size: fitTextSize(text, maxWidth, { min: 64, max: 160, weight: "bold" }),
    })),
  );

  const labelFits = LABELS.flatMap((label) =>
    (
      [
        { type: "metric", w: 3, h: 2 },
        { type: "metric", w: 4, h: 3 },
        { type: "line", w: 6, h: 4 },
        { type: "bar", w: 12, h: 8 },
        { type: "text", w: 2, h: 1 },
      ] as const
    ).flatMap((widget) =>
      [1, 1.3].map((fontScale) => ({
        label,
        type: widget.type,
        w: widget.w,
        h: widget.h,
        fontScale,
        ...labelFit(label, widget, { fontScale }),
      })),
    ),
  );

  const legacy = Array.from({ length: 41 }, (_, tiles) => ({
    tiles,
    grid: legacyGrid(tiles),
    slides: legacyLayout(tiles),
  }));

  const markdown = MARKDOWN.map((source) => ({
    source,
    blocks: parseTextWidget(source),
  }));

  const compact = COMPACT.map((value) => ({
    // JSON has no NaN; the Swift side reads null as NaN.
    value: Number.isNaN(value) ? null : value,
    text: compactNumber(value),
  }));

  return {
    about:
      "Generated from packages/domain/src/studio-layout.ts by `pnpm vectors:studio`. Do not edit by hand.",
    minimumWidgetSizes: STUDIO_MIN_WIDGET_SIZE,
    frames,
    rects,
    insideGrid,
    minimumSize,
    overlaps,
    typeScales,
    textSizes,
    textWidths,
    wrapping,
    fitSizes,
    labelFits,
    legacy,
    markdown,
    compact,
  };
}
