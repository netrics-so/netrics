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
  CLOCK_DATE_SAMPLES,
  STUDIO_REFERENCE_CANVAS,
  STUDIO_SPACING,
  STUDIO_MIN_WIDGET_SIZE,
  STUDIO_WIDGET_TYPES,
  compactNumber,
  countdownLayout,
  countdownParts,
  estimateTextWidth,
  findOverlaps,
  fitTextSize,
  gaugeLayout,
  isInsideGrid,
  labelFit,
  legacyGrid,
  legacyLayout,
  meetsMinimumSize,
  parseTextWidget,
  clockLayout,
  studioFrame,
  statusAge,
  statusLayout,
  statusRowsShown,
  tableChangeKind,
  tableLayout,
  tableRowLabel,
  tableRowsShown,
  reviewLayout,
  reviewStarsFilled,
  textWidgetSizes,
  widgetRect,
  widgetTypeScale,
  wrappedLineCount,
  zoneLabel,
  zoneLabelSample,
  zonedInstant,
  type ClockDateStyle,
  type StudioCanvas,
  type StudioFontWeight,
  type StudioPlacement,
  type StudioTextSize,
} from "./studio-layout.js";
import { compareChange, compareLayout, ratioOf } from "./compare.js";
import { goalPercent, goalReached, goalTimeText } from "./goals.js";

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

/** Zones for the zone line: DST in both hemispheres, half and quarter hours. */
const ZONES = [
  "Europe/Berlin",
  "America/New_York",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Australia/Adelaide",
  "Pacific/Chatham",
  "America/St_Johns",
  "Etc/UTC",
  "UTC",
  "Etc/GMT+3",
  "Etc/GMT-14",
];

/** Summer and winter in the north, and a daylight saving change in Berlin. */
const INSTANTS = [
  "2026-07-04T12:00:00.000Z",
  "2026-01-10T12:00:00.000Z",
  "2026-03-29T00:59:59.000Z",
  "2026-03-29T01:00:00.000Z",
];

const CLOCK_CASES = [
  { w: 2, h: 1 },
  { w: 2, h: 2 },
  { w: 3, h: 2 },
  { w: 3, h: 3 },
  { w: 4, h: 2 },
  { w: 12, h: 8 },
];

const CLOCK_OPTIONS: Array<{
  time: string;
  showDate: boolean;
  dateStyle: ClockDateStyle;
  zone: string | null;
}> = [
  { time: "14:05", showDate: true, dateStyle: "short", zone: null },
  { time: "14:05", showDate: false, dateStyle: "short", zone: null },
  { time: "14:05", showDate: true, dateStyle: "long", zone: "Europe/Berlin" },
  { time: "2:05 PM", showDate: false, dateStyle: "long", zone: "Etc/UTC" },
  {
    time: "12:59 PM",
    showDate: true,
    dateStyle: "short",
    zone: "America/Argentina/Buenos_Aires",
  },
];

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
        { type: "table", w: 4, h: 4 },
        { type: "review", w: 4, h: 3 },
        { type: "compare", w: 4, h: 3 },
        { type: "text", w: 2, h: 1 },
        { type: "clock", w: 2, h: 1 },
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

  // Tables (ADR 0019 section 6): content boxes of 4 × 4, 3 wide and 3
  // high, 6 × 6 and 12 × 8 at 16:9 with the header, and odd ones.
  const tableBoxes = [
    { width: 560, height: 414.2 },
    { width: 404, height: 414.2 },
    { width: 560, height: 294.65 },
    { width: 872, height: 652.1 },
    { width: 1808, height: 892.4 },
    { width: 200, height: 100 },
    { width: 0, height: 0 },
  ];
  const tableValues = [
    [],
    [
      { full: "8,120", compact: "8.1K" },
      { full: "7,250", compact: "7.3K" },
      { full: "512", compact: "512" },
    ],
    [
      { full: "$1,234,567.89", compact: "$1.2M" },
      { full: "$98,765.43", compact: "$98.8K" },
    ],
  ];
  const tableLayouts = tableBoxes.flatMap((box) =>
    ["Page views", "Page views · netrics.so", LABELS[5]!].flatMap((label) =>
      FONT_SCALES.flatMap((fontScale) =>
        tableValues.flatMap((values) =>
          [true, false].map((showChange) => ({
            label,
            width: box.width,
            height: box.height,
            fontScale,
            values,
            showChange,
            layout: tableLayout({
              label,
              width: box.width,
              height: box.height,
              fontScale,
              values,
              showChange,
            }),
          })),
        ),
      ),
    ),
  );
  const tableRowsShownCases = [
    [5, 8, 4],
    [3, 2, 6],
    [10, 10, 10],
    [5, 0, 6],
    [5, 6, 0],
  ].map(([limit, rows, capacity]) => ({
    limit: limit!,
    rows: rows!,
    capacity: capacity!,
    shown: tableRowsShown(limit!, rows!, capacity!),
  }));
  const tableRowLabels = [
    "/pricing",
    "/blog/how-we-built-a-dashboard-for-the-office-tv",
    "Germany",
    "United States of America",
    "日本語のアプリ",
    "",
  ].flatMap((text) =>
    [100, 250, 370].flatMap((labelWidth) =>
      [1, 1.3].map((fontScale) => {
        const sizes = { cell: 28 * fontScale, cellMin: 24 * fontScale };
        return {
          text,
          labelWidth,
          ...sizes,
          ...tableRowLabel(text, labelWidth, sizes),
        };
      }),
    ),
  );
  const tableChanges = [
    { value: 8120, previousValue: 7250, ratio: 0.12 },
    { value: 10, previousValue: 0, ratio: null },
    { value: 10, previousValue: null, ratio: null },
    { value: 0, previousValue: null, ratio: null },
    { value: 0, previousValue: 0, ratio: null },
    { value: null, previousValue: 5, ratio: null },
    { value: 3, previousValue: 4, ratio: -0.25 },
  ].map((row) => ({ ...row, kind: tableChangeKind(row) }));

  // Status boards (ADR 0019 section 7): 3 × 3, 3 × 4, 4 × 3 and 6 × 8 at
  // 16:9 with the header, and odd ones.
  const statusBoxes = [
    { width: 404, height: 294.65 },
    { width: 404, height: 414.2 },
    { width: 560, height: 294.65 },
    { width: 872, height: 892.4 },
    { width: 200, height: 100 },
    { width: 0, height: 0 },
  ];
  const statusLayouts = statusBoxes.flatMap((box) =>
    ["Sources", "Quellen · netrics.so", LABELS[5]!].flatMap((label) =>
      FONT_SCALES.flatMap((fontScale) =>
        [true, false].map((showAge) => ({
          label,
          width: box.width,
          height: box.height,
          fontScale,
          showAge,
          layout: statusLayout({
            label,
            width: box.width,
            height: box.height,
            fontScale,
            showAge,
          }),
        })),
      ),
    ),
  );
  const statusRowsShownCases = [
    [0, 5],
    [3, 5],
    [5, 5],
    [6, 5],
    [12, 3],
    [2, 1],
    [4, 0],
  ].map(([items, capacity]) => ({
    items: items!,
    capacity: capacity!,
    ...statusRowsShown(items!, capacity!),
  }));
  const STATUS_NOW = Date.parse("2026-10-04T12:00:00Z");
  const statusAges = [
    null,
    "2026-10-04T12:00:00Z",
    "2026-10-04T11:59:30Z",
    "2026-10-04T11:46:00Z",
    "2026-10-04T11:00:01Z",
    "2026-10-04T11:00:00Z",
    "2026-10-04T09:00:00Z",
    "2026-10-03T12:00:01Z",
    "2026-10-03T12:00:00Z",
    "2026-10-02T09:00:00Z",
    "2026-07-04T12:00:00Z",
    "2026-10-04T12:05:00Z",
  ].map((lastSuccessAt) => ({
    lastSuccessAt,
    now: STATUS_NOW,
    age: statusAge(lastSuccessAt, STATUS_NOW),
  }));

  // Compare (ADR 0019 section 10): A ÷ B, its change, and the layout at
  // 4 × 3 (the minimum), 6 × 4 and 12 × 8 at 16:9 with the header, and
  // odd boxes.
  const ratios = [
    [12_500, 38_200],
    [4_620, 1_000],
    [1, 3],
    [0, 5],
    [5, 0],
    [0, 0],
    [null, 5],
    [5, null],
    [-12, 4],
    [1e300, 1e-300],
  ].map(([numerator, denominator]) => ({
    numerator: numerator!,
    denominator: denominator!,
    ratio: ratioOf(numerator!, denominator!),
  }));
  const compareChanges = (
    [
      [0.327, 0.308, "percent"],
      [0.308, 0.327, "percent"],
      [0.5, 0.5, "percent"],
      [4.62, 4.4, "ratio"],
      [3, 0, "ratio"],
      [0, 0, "percent"],
      [null, 0.3, "percent"],
      [0.3, null, "ratio"],
      [-2, 4, "ratio"],
    ] as const
  ).map(([value, previousValue, format]) => ({
    value,
    previousValue,
    format,
    change: compareChange({ value, previousValue, format }),
  }));
  const compareBoxes = [
    { width: 560, height: 294.65 },
    { width: 872, height: 414.2 },
    { width: 1808, height: 892.4 },
    { width: 404, height: 175.1 },
    { width: 0, height: 0 },
  ];
  const compareTexts = [
    {
      numerator: { full: "12,500", compact: "12.5K" },
      denominator: { full: "38,200", compact: "38.2K" },
      ratio: "32.7%",
      ratioLabel: "conversion",
      change: "▲ 1.9 pt",
    },
    {
      numerator: { full: "$1,234,567.89", compact: "$1.2M" },
      denominator: { full: "$98,765.43", compact: "$98.8K" },
      ratio: "12.5",
      ratioLabel: "ROAS",
      change: null,
    },
    {
      numerator: { full: "2,310", compact: "2.3K" },
      denominator: { full: "500", compact: "500" },
      ratio: "4.62",
      ratioLabel: "average rating of the last thirty d",
      change: "▼ −3.1%",
    },
  ];
  const compareLayouts = compareBoxes.flatMap((box) =>
    ["Conversion", "Downloads · Wurfel", LABELS[5]!].flatMap((label) =>
      FONT_SCALES.flatMap((fontScale) =>
        compareTexts.map((texts) => ({
          label,
          width: box.width,
          height: box.height,
          fontScale,
          ...texts,
          layout: compareLayout({
            label,
            width: box.width,
            height: box.height,
            fontScale,
            ...texts,
          }),
        })),
      ),
    ),
  );

  // Goal widgets (ADR 0019 section 5): content boxes of 3 × 3, 3 × 4,
  // 6 × 3 (side by side), 4 × 4 and 12 × 8 at 16:9 with the header, and
  // odd ones.
  const gaugeBoxes = [
    { width: 404, height: 294.65 },
    { width: 404, height: 414.2 },
    { width: 872, height: 294.65 },
    { width: 560, height: 414.2 },
    { width: 1808, height: 892.4 },
    { width: 250, height: 175 },
    { width: 200, height: 900 },
    { width: 0, height: 0 },
  ];
  const gaugeValues = [
    { value: null, suffix: null },
    { value: { full: "83", compact: "83" }, suffix: "%" },
    { value: { full: "612", compact: "612" }, suffix: null },
    { value: { full: "€1,234,567", compact: "€1.2M" }, suffix: null },
  ];
  const gaugeLayouts = gaugeBoxes.flatMap((box) =>
    ["Monthly downloads", "Downloads · Wurfel", LABELS[5]!].flatMap((label) =>
      [1, 1.3].flatMap((fontScale) =>
        gaugeValues.flatMap(({ value, suffix }) =>
          [
            null,
            "2,520 to go · 9 days left",
            "2.520 noch bis zum Ziel · noch 9 Tage übrig",
          ].map((progress) => {
            const input = {
              label,
              width: box.width,
              height: box.height,
              fontScale,
              value,
              suffix,
              progress,
            };
            return { ...input, layout: gaugeLayout(input) };
          }),
        ),
      ),
    ),
  );
  const goalPercents = [
    0,
    0.004,
    0.29,
    0.5,
    0.832,
    0.99,
    0.9999,
    1,
    1.224,
    3,
    null,
  ].map((progress) => ({
    progress,
    percent: goalPercent(progress),
    reached: goalReached(progress),
  }));
  const goalTimeCases = [
    // In progress this month, Berlin (the month ends after the DST change).
    [
      "this_month",
      "2026-11-01T00:00:00+01:00",
      null,
      0.83,
      "2026-10-22T13:00:00Z",
      "Europe/Berlin",
    ],
    [
      "this_month",
      "2026-11-01T00:00:00+01:00",
      null,
      0.83,
      "2026-10-21T22:30:00Z",
      "Europe/Berlin",
    ],
    [
      "this_month",
      "2026-11-01T00:00:00+01:00",
      null,
      0.83,
      "2026-10-31T22:59:00Z",
      "Europe/Berlin",
    ],
    [
      "this_month",
      "2026-11-01T00:00:00+01:00",
      null,
      0.83,
      "2026-10-31T23:00:00Z",
      "Europe/Berlin",
    ],
    [
      "this_month",
      "2026-11-01T00:00:00+01:00",
      null,
      null,
      "2026-10-22T13:00:00Z",
      "Europe/Berlin",
    ],
    // Today: hours.
    [
      "today",
      "2026-10-23T00:00:00+02:00",
      null,
      0.4,
      "2026-10-22T16:30:00Z",
      "Europe/Berlin",
    ],
    [
      "today",
      "2026-10-23T00:00:00+02:00",
      null,
      0.4,
      "2026-10-22T21:20:00Z",
      "Europe/Berlin",
    ],
    [
      "today",
      "2026-10-23T00:00:00+02:00",
      null,
      0.4,
      "2026-10-21T22:00:00Z",
      "Europe/Berlin",
    ],
    [
      "today",
      "2026-10-23T00:00:00+02:00",
      "2026-10-22T00:00:00Z",
      1.5,
      "2026-10-22T16:30:00Z",
      "Europe/Berlin",
    ],
    // Reached this week, this quarter and this year.
    [
      "this_week",
      "2026-10-26T00:00:00+01:00",
      "2026-10-21T22:00:00.000Z",
      1.22,
      "2026-10-24T10:00:00Z",
      "Europe/Berlin",
    ],
    [
      "this_week",
      "2026-10-26T00:00:00+01:00",
      "2026-10-24T23:00:00.000Z",
      1.22,
      "2026-10-25T10:00:00Z",
      "Europe/Berlin",
    ],
    [
      "this_week",
      "2026-10-26T00:00:00+01:00",
      null,
      1,
      "2026-10-24T10:00:00Z",
      "Europe/Berlin",
    ],
    [
      "this_quarter",
      "2027-01-01T00:00:00-08:00",
      "2026-11-30T08:00:00.000Z",
      1.01,
      "2026-12-02T10:00:00Z",
      "America/Los_Angeles",
    ],
    [
      "this_year",
      "2027-01-01T00:00:00+00:00",
      "2026-06-01T00:00:00.000Z",
      1.4,
      "2026-12-02T10:00:00Z",
      "UTC",
    ],
    // In progress over a year, and in a half-hour zone.
    [
      "this_year",
      "2027-01-01T00:00:00+05:30",
      null,
      0.2,
      "2026-03-01T12:00:00Z",
      "Asia/Kolkata",
    ],
    [
      "this_week",
      "2026-03-30T00:00:00+02:00",
      null,
      0.2,
      "2026-03-28T23:30:00Z",
      "Europe/Berlin",
    ],
  ] as const;
  const goalTimeTexts = goalTimeCases.map(
    ([period, periodEnd, reachedAt, progress, now, timeZone]) => ({
      period,
      periodEnd,
      reachedAt,
      progress,
      now,
      timeZone,
      text: goalTimeText({
        period,
        periodEnd,
        reachedAt,
        progress,
        now: new Date(now),
        timeZone,
      }),
    }),
  );

  // Latest reviews (ADR 0019 section 12): the 4 × 3 minimum, a wider and
  // a taller box at 16:9, and odd ones; with and without an icon, title,
  // body and a notice line.
  const reviewBoxes = [
    { width: 560, height: 294.65 },
    { width: 872, height: 414.2 },
    { width: 404, height: 533.75 },
    { width: 200, height: 100 },
    { width: 0, height: 0 },
  ];
  const reviewTexts: Array<{ title: string | null; body: string | null }> = [
    {
      title: "Finally",
      body: "Finally a dashboard I can leave on the office TV. Everyone sees the numbers without asking me.",
    },
    { title: null, body: "Short." },
    {
      title: "A very long review title that will not fit on one line at all",
      body: null,
    },
    { title: "   ", body: "日本語のレビューです。とても良いアプリ。" },
    { title: null, body: null },
  ];
  const reviewLayouts = reviewBoxes.flatMap((box) =>
    ["Latest review", "Latest review · Wurfel", LABELS[5]!].flatMap((label) =>
      [1, 1.3].flatMap((fontScale) =>
        reviewTexts.flatMap((text) =>
          [true, false].flatMap((icon) =>
            [false, true].map((notice) => ({
              label,
              width: box.width,
              height: box.height,
              fontScale,
              icon,
              notice,
              ...text,
              layout: reviewLayout({
                label,
                width: box.width,
                height: box.height,
                fontScale,
                icon,
                notice,
                ...text,
              }),
            })),
          ),
        ),
      ),
    ),
  );
  const reviewStars = [5, 4, 1, 0, 6, -1, 3.4, 3.5, Number.NaN].map(
    (rating) => ({
      rating: Number.isNaN(rating) ? null : rating,
      filled: reviewStarsFilled(rating),
    }),
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

  const zoneLabels = ZONES.flatMap((timeZone) =>
    INSTANTS.map((at) => ({
      timeZone,
      at,
      label: zoneLabel(timeZone, new Date(at)),
      sample: zoneLabelSample(timeZone),
    })),
  );

  const clockLayouts = CLOCK_CASES.flatMap((size) =>
    [1, 1.3].flatMap((fontScale) =>
      CLOCK_OPTIONS.map((options) => {
        const placement = { x: 0, y: 0, w: size.w, h: size.h };
        const rect = widgetRect(placement, STUDIO_REFERENCE_CANVAS, true);
        const box = {
          width: rect.width - 2 * STUDIO_SPACING.widgetPadding,
          height: rect.height - 2 * STUDIO_SPACING.widgetPadding,
        };
        return {
          w: size.w,
          h: size.h,
          box,
          fontScale,
          ...options,
          layout: clockLayout({
            placement,
            box,
            fontScale,
            showHeader: true,
            ...options,
          }),
        };
      }),
    ),
  );

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
    tableLayouts,
    tableRowsShown: tableRowsShownCases,
    tableRowLabels,
    tableChanges,
    reviewLayouts,
    reviewStars,
    statusLayouts,
    statusRowsShown: statusRowsShownCases,
    statusAges,
    ratios,
    compareChanges,
    compareLayouts,
    gaugeLayouts,
    goalPercents,
    goalTimeTexts,
    legacy,
    markdown,
    compact,
    clockDateSamples: CLOCK_DATE_SAMPLES,
    zoneLabels,
    clockLayouts,
    ...countdownVectors(),
  };
}

// Countdown (ADR 0019 section 8): targets in zones with and without DST,
// in gaps and twice-existing hours, at the edges of the years.
const COUNTDOWN_TARGETS = [
  "2026-10-07T10:00",
  "2026-03-29T02:30",
  "2026-03-29T03:00",
  "2026-10-25T02:30",
  "2026-10-25T03:00",
  "2026-03-08T02:15",
  "2026-11-01T01:30",
  "2026-04-05T02:30",
  "2026-10-04T02:00",
  "2000-01-01T00:00",
  "2100-12-31T23:59",
  "2028-02-29T12:00",
  "2027-02-29T12:00",
  "2026-10-07T24:00",
  "1999-12-31T23:59",
  "2026-10-07 10:00",
];

const COUNTDOWN_ZONES = [
  "Europe/Berlin",
  "America/New_York",
  "Australia/Sydney",
  "Australia/Lord_Howe",
  "Asia/Kathmandu",
  "America/St_Johns",
  "Pacific/Chatham",
  "UTC",
  "Etc/GMT-14",
];

const COUNTDOWN_NOWS = [
  "2026-10-04T17:55:00.000Z",
  "2026-10-06T07:00:00.000Z",
  "2026-10-06T17:55:00.000Z",
  "2026-10-07T07:00:00.000Z",
  "2026-10-07T07:00:00.300Z",
  "2026-10-07T07:00:01.000Z",
  "2026-10-07T07:19:00.000Z",
  "2026-10-07T07:59:00.000Z",
  "2026-10-07T07:59:30.000Z",
  "2026-10-07T07:59:59.999Z",
  "2026-10-07T08:00:00.000Z",
  "2026-10-09T00:00:00.000Z",
  "2025-01-01T00:00:00.000Z",
];

const COUNTDOWN_SIZES = [
  { w: 3, h: 2 },
  { w: 4, h: 2 },
  { w: 3, h: 3 },
  { w: 6, h: 4 },
  { w: 12, h: 8 },
];

const COUNTDOWN_CONTENTS: Array<{
  label: string;
  groups: Array<{ value: string; unit: string }>;
  target: string | null;
  doneText: string | null;
}> = [
  {
    label: "Launch in",
    groups: [
      { value: "2", unit: "d" },
      { value: "14", unit: "h" },
      { value: "05", unit: "m" },
    ],
    target: "Wed 7 Oct · 10:00",
    doneText: null,
  },
  {
    label: "Countdown",
    groups: [
      { value: "1234", unit: "T" },
      { value: "08", unit: "Std" },
      { value: "41", unit: "Min" },
    ],
    target: "Mo., 7. Okt. 2030 · 10:00",
    doneText: null,
  },
  {
    label: "Launch · netrics.so",
    groups: [{ value: "< 1", unit: "m" }],
    target: null,
    doneText: null,
  },
  {
    label: "Bis zum Start der neuen Version unserer Anwendung für alle",
    groups: [
      { value: "14", unit: "h" },
      { value: "05", unit: "m" },
    ],
    target: "Wed 7 Oct · 10:00",
    doneText: null,
  },
  {
    label: "Launch in",
    groups: [],
    target: "Wed 7 Oct · 10:00",
    doneText: "Now",
  },
  {
    label: "Launch in",
    groups: [],
    target: null,
    doneText: "We launched, thank you all for your help",
  },
];

function countdownVectors() {
  const zonedInstants = COUNTDOWN_ZONES.flatMap((timeZone) =>
    COUNTDOWN_TARGETS.map((target) => ({
      target,
      timeZone,
      targetAt: zonedInstant(target, timeZone)?.toISOString() ?? null,
    })),
  );
  const targetAt = "2026-10-07T08:00:00.000Z";
  const countdownPartsCases = COUNTDOWN_NOWS.map((now) => ({
    now,
    targetAt,
    ...countdownParts(new Date(now), new Date(targetAt)),
  }));
  const countdownLayouts = COUNTDOWN_SIZES.flatMap((size) =>
    [1, 1.3].flatMap((fontScale) =>
      COUNTDOWN_CONTENTS.map((content) => {
        const placement = { x: 0, y: 0, w: size.w, h: size.h };
        const rect = widgetRect(placement, STUDIO_REFERENCE_CANVAS, true);
        const box = {
          width: rect.width - 2 * STUDIO_SPACING.widgetPadding,
          height: rect.height - 2 * STUDIO_SPACING.widgetPadding,
        };
        return {
          w: size.w,
          h: size.h,
          box,
          fontScale,
          ...content,
          layout: countdownLayout({
            placement,
            box,
            fontScale,
            showHeader: true,
            ...content,
          }),
        };
      }),
    ),
  );
  return {
    zonedInstants,
    countdownParts: countdownPartsCases,
    countdownLayouts,
  };
}
