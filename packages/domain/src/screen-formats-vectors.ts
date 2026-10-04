/**
 * Test vectors for screen formats (ADR 0017): format classes, frames, auto
 * reflow, custom-layout sync, display modes and the scroll view layout,
 * computed from the TypeScript implementation. They are checked in at
 * packages/domain/test-vectors/screen-formats.json; the domain tests fail
 * when the file and this output differ, and the Swift tests in
 * apps/tvos/NetricsKit run the same file (#278). Regenerate with
 * `pnpm vectors:formats` after a deliberate change, and port the change.
 *
 * Not exported from the package index: only tests use it.
 */
import {
  CUSTOM_LAYOUT_MAX_PAGES,
  completeCustomLayout,
  defaultDisplayMode,
  reflowSlide,
  scrollLayout,
  studioReadingOrder,
  validateCustomLayout,
  type CustomLayout,
  type CustomPlacement,
  type DisplayMode,
  type LayoutWidget,
} from "./screen-formats.js";
import {
  SCREEN_FORMATS,
  SCREEN_FORMAT_KEYS,
  formatFor,
  labelFit,
  legacyLayout,
  placementRect,
  screenFrame,
  sizeClassFor,
  type ScreenFormat,
  type ScreenSizeClass,
  type StudioCanvas,
  type StudioPlacement,
  type StudioWidgetType,
} from "./studio-layout.js";

function widget(
  id: string,
  type: StudioWidgetType,
  x: number,
  y: number,
  w: number,
  h: number,
): LayoutWidget {
  return { id, type, x, y, w, h };
}

export interface SlideFixture {
  name: string;
  format: ScreenFormat;
  widgets: LayoutWidget[];
}

/** Primary slides the reflow, reading order and scroll vectors run on. */
export const SLIDE_FIXTURES: SlideFixture[] = [
  { name: "empty", format: "16x9", widgets: [] },
  {
    name: "one metric",
    format: "16x9",
    widgets: [widget("m", "metric", 0, 0, 3, 2)],
  },
  {
    name: "one full-screen chart",
    format: "16x9",
    widgets: [widget("chart", "line", 0, 0, 12, 8)],
  },
  {
    name: "four metrics in a row",
    format: "16x9",
    widgets: [0, 3, 6, 9].map((x, i) => widget(`m${i}`, "metric", x, 0, 3, 2)),
  },
  {
    name: "four mixed",
    format: "16x9",
    widgets: [
      widget("title", "text", 0, 0, 12, 1),
      widget("m1", "metric", 0, 1, 4, 3),
      widget("chart", "line", 4, 1, 8, 7),
      widget("m2", "metric", 0, 4, 4, 4),
    ],
  },
  {
    name: "seven",
    format: "16x9",
    widgets: [
      widget("title", "text", 0, 0, 12, 1),
      widget("m1", "metric", 0, 1, 4, 2),
      widget("m2", "metric", 4, 1, 4, 2),
      widget("m3", "metric", 8, 1, 4, 2),
      widget("chart", "line", 0, 3, 8, 5),
      widget("m4", "metric", 8, 3, 4, 2),
      widget("m5", "metric", 8, 5, 4, 3),
    ],
  },
  {
    name: "sixteen metrics",
    format: "16x9",
    widgets: legacyLayout(16)[0]!.map((placement, i) => ({
      id: `m${String(i).padStart(2, "0")}`,
      type: "metric" as const,
      ...placement,
    })),
  },
  {
    name: "stacked metrics beside a chart",
    format: "16x9",
    widgets: [
      widget("chart", "line", 0, 0, 8, 6),
      widget("m1", "metric", 8, 0, 4, 3),
      widget("m2", "metric", 8, 3, 4, 3),
      widget("note", "text", 0, 6, 12, 2),
    ],
  },
  {
    name: "full-width text band",
    format: "16x9",
    widgets: [
      widget("band", "text", 0, 0, 12, 2),
      widget("line", "line", 0, 2, 6, 6),
      widget("bar", "bar", 6, 2, 6, 6),
    ],
  },
  {
    name: "deliberate gaps, clock and image",
    format: "16x9",
    widgets: [
      widget("left", "metric", 0, 0, 3, 2),
      widget("right", "metric", 9, 0, 3, 2),
      widget("clock", "clock", 5, 7, 2, 1),
      widget("logo", "image", 11, 7, 1, 1),
    ],
  },
  {
    name: "clocks and a large image",
    format: "16x9",
    widgets: [
      widget("utc", "clock", 0, 0, 4, 2),
      widget("photo", "image", 4, 0, 8, 8),
      widget("local", "clock", 0, 2, 4, 6),
    ],
  },
  {
    name: "portrait with a tall stack",
    format: "9x16",
    widgets: [
      widget("m1", "metric", 0, 0, 3, 3),
      widget("m2", "metric", 0, 3, 3, 3),
      widget("m3", "metric", 0, 6, 3, 3),
      widget("m4", "metric", 0, 9, 3, 3),
      widget("side", "text", 3, 0, 3, 12),
      widget("footer", "text", 0, 12, 6, 2),
    ],
  },
  {
    name: "portrait column",
    format: "9x16",
    widgets: [
      widget("title", "text", 0, 0, 6, 2),
      widget("chart", "line", 0, 2, 6, 6),
      widget("m1", "metric", 0, 8, 3, 2),
      widget("m2", "metric", 3, 8, 3, 2),
      widget("bar", "bar", 0, 10, 6, 4),
    ],
  },
  {
    name: "ultra-wide",
    format: "21x9",
    widgets: [
      widget("m1", "metric", 0, 0, 4, 2),
      widget("m2", "metric", 4, 0, 4, 2),
      widget("m3", "metric", 8, 0, 4, 2),
      widget("m4", "metric", 12, 0, 4, 2),
      widget("line", "line", 0, 2, 10, 6),
      widget("bar", "bar", 10, 2, 6, 6),
    ],
  },
  {
    name: "classic",
    format: "4x3",
    widgets: [
      widget("m1", "metric", 0, 0, 3, 2),
      widget("m2", "metric", 3, 0, 3, 2),
      widget("m3", "metric", 6, 0, 3, 2),
      widget("line", "line", 0, 2, 9, 6),
    ],
  },
  {
    name: "tablet portrait",
    format: "3x4",
    widgets: [
      widget("m1", "metric", 0, 0, 3, 2),
      widget("m2", "metric", 3, 0, 3, 2),
      widget("line", "line", 0, 2, 6, 4),
      widget("bar", "bar", 0, 6, 6, 4),
    ],
  },
];

/** Screen sizes: every format boundary, common screens and edge cases. */
const SCREENS: StudioCanvas[] = [
  { width: 2040, height: 1000 },
  { width: 2039, height: 1000 },
  { width: 1540, height: 1000 },
  { width: 1539, height: 1000 },
  { width: 1000, height: 1000 },
  { width: 999, height: 1000 },
  { width: 650, height: 1000 },
  { width: 649, height: 1000 },
  { width: 1920, height: 1080 },
  { width: 3840, height: 2160 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1200 },
  { width: 1500, height: 1000 },
  { width: 2560, height: 1080 },
  { width: 3440, height: 1440 },
  { width: 5120, height: 1440 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 1080, height: 1920 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 600, height: 1800 },
  { width: 599, height: 2000 },
  { width: 1099, height: 2000 },
  { width: 1100, height: 2000 },
  { width: 0, height: 0 },
];

/** Screens the frames are computed for, per format. */
const FRAME_SCREENS: StudioCanvas[] = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1200 },
  { width: 2560, height: 1080 },
  { width: 5120, height: 1440 },
  { width: 1024, height: 768 },
  { width: 1000, height: 1000 },
  { width: 768, height: 1024 },
  { width: 1080, height: 1920 },
  { width: 390, height: 844 },
  { width: 600, height: 1800 },
];

const LABELS = [
  "Downloads · Wurfel",
  "Impressions · sc-domain:example.com",
  "Ratings and reviews · Wurfel: Würfel-Spiel für die ganze Familie",
];

const SCROLL_WIDTHS = [320, 599, 600, 1023, 1024, 1440];

function custom(
  pages: number,
  placements: Array<
    Omit<CustomPlacement, "hidden" | "autoPlaced"> &
      Partial<Pick<CustomPlacement, "hidden" | "autoPlaced">>
  >,
): CustomLayout {
  return {
    pages,
    placements: placements.map((placement) => ({
      hidden: false,
      autoPlaced: false,
      ...placement,
    })),
  };
}

/** A custom layout started from the auto result ("Customize"). */
function fromAuto(fixture: SlideFixture, format: ScreenFormat): CustomLayout {
  const pages = reflowSlide(fixture.widgets, fixture.format, format);
  return custom(
    pages.length,
    pages.flatMap((page, index) =>
      page.map((placement) => ({ ...placement, page: index })),
    ),
  );
}

function fixture(name: string): SlideFixture {
  return SLIDE_FIXTURES.find((entry) => entry.name === name)!;
}

interface SyncCase {
  name: string;
  format: ScreenFormat;
  primaryFormat: ScreenFormat;
  widgets: LayoutWidget[];
  custom: CustomLayout;
}

/** One case per sync rule of ADR 0017, section 4, and the edge cases. */
export function syncCases(): SyncCase[] {
  const seven = fixture("seven");
  const stacked = fixture("stacked metrics beside a chart");
  const sixteen = fixture("sixteen metrics");
  const cases: SyncCase[] = [];
  const add = (
    name: string,
    base: SlideFixture,
    format: ScreenFormat,
    widgets: LayoutWidget[],
    layout: CustomLayout,
  ) =>
    cases.push({
      name,
      format,
      primaryFormat: base.format,
      widgets,
      custom: layout,
    });

  add("unchanged", seven, "9x16", seven.widgets, fromAuto(seven, "9x16"));

  // The user rearranged 4:3 by hand: chart and metrics side by side.
  const hand = custom(1, [
    { id: "chart", page: 0, x: 0, y: 0, w: 5, h: 6 },
    { id: "m1", page: 0, x: 5, y: 0, w: 4, h: 3 },
    { id: "m2", page: 0, x: 5, y: 3, w: 4, h: 3 },
    { id: "note", page: 0, x: 0, y: 6, w: 9, h: 2 },
  ]);
  add("unchanged by hand", stacked, "4x3", stacked.widgets, hand);
  add(
    "widget moved and resized in the primary",
    stacked,
    "4x3",
    stacked.widgets.map((entry) =>
      entry.id === "note" ? { ...entry, x: 4, w: 8 } : entry,
    ),
    hand,
  );
  const four = fixture("four metrics in a row");
  add(
    "widget added fits beside its neighbour",
    four,
    "9x16",
    [...four.widgets, widget("m4", "metric", 0, 2, 3, 2)],
    fromAuto(four, "9x16"),
  );
  add(
    "widget added to a full page goes to a new page",
    stacked,
    "4x3",
    [...stacked.widgets, widget("new", "metric", 8, 6, 4, 2)].map((entry) =>
      entry.id === "note" ? { ...entry, w: 8 } : entry,
    ),
    hand,
  );
  add(
    "two widgets added follow each other",
    stacked,
    "4x3",
    [
      ...stacked.widgets.map((entry) =>
        entry.id === "note" ? { ...entry, w: 4 } : entry,
      ),
      widget("new1", "metric", 4, 6, 4, 2),
      widget("new2", "metric", 8, 6, 4, 2),
    ],
    hand,
  );
  add(
    "widget deleted leaves the hole",
    stacked,
    "4x3",
    stacked.widgets.filter((entry) => entry.id !== "m2"),
    hand,
  );
  add(
    "type change below the minimum is re-placed",
    fixture("full-width text band"),
    "9x16",
    [
      widget("band", "metric", 0, 0, 12, 2),
      widget("line", "line", 0, 2, 6, 6),
      widget("bar", "bar", 6, 2, 6, 6),
    ],
    custom(1, [
      { id: "band", page: 0, x: 0, y: 0, w: 6, h: 1 },
      { id: "line", page: 0, x: 0, y: 1, w: 6, h: 6 },
      { id: "bar", page: 0, x: 0, y: 7, w: 6, h: 6 },
    ]),
  );
  add(
    "overlapping placement is re-placed",
    stacked,
    "4x3",
    stacked.widgets,
    custom(1, [
      { id: "chart", page: 0, x: 0, y: 0, w: 5, h: 6 },
      { id: "m1", page: 0, x: 5, y: 0, w: 4, h: 3 },
      { id: "m2", page: 0, x: 4, y: 2, w: 4, h: 3 },
      { id: "note", page: 0, x: 0, y: 6, w: 9, h: 2 },
    ]),
  );
  add(
    "outside the grid is re-placed",
    stacked,
    "3x4",
    stacked.widgets,
    custom(2, [
      { id: "chart", page: 0, x: 0, y: 0, w: 6, h: 6 },
      { id: "m1", page: 0, x: 0, y: 6, w: 3, h: 3 },
      { id: "m2", page: 0, x: 3, y: 6, w: 4, h: 3 },
      { id: "note", page: 1, x: 0, y: 0, w: 6, h: 2 },
    ]),
  );
  add(
    "hidden widgets stay hidden",
    stacked,
    "4x3",
    stacked.widgets,
    custom(1, [
      { id: "chart", page: 0, x: 0, y: 0, w: 9, h: 6 },
      { id: "m1", page: 0, x: 0, y: 0, w: 4, h: 3, hidden: true },
      { id: "m2", page: 3, x: 0, y: 0, w: 4, h: 3, hidden: true },
      { id: "note", page: 0, x: 0, y: 6, w: 9, h: 2, autoPlaced: true },
    ]),
  );
  add(
    "page out of range is re-placed",
    stacked,
    "4x3",
    stacked.widgets,
    custom(1, [
      { id: "chart", page: 0, x: 0, y: 0, w: 5, h: 6 },
      { id: "m1", page: 0, x: 5, y: 0, w: 4, h: 3 },
      { id: "m2", page: 2, x: 5, y: 3, w: 4, h: 3 },
      { id: "note", page: 0, x: 0, y: 6, w: 9, h: 2 },
    ]),
  );
  add("unknown and duplicate placements go", stacked, "4x3", stacked.widgets, {
    pages: 1,
    placements: [
      ...hand.placements,
      { ...hand.placements[1]!, x: 0, y: 0 },
      {
        id: "gone",
        page: 0,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        hidden: false,
        autoPlaced: false,
      },
    ],
  });
  add(
    "first widget added before all others takes the next one's page",
    stacked,
    "4x3",
    [
      widget("top", "text", 0, 0, 12, 1),
      ...stacked.widgets.map((entry) => ({
        ...entry,
        y: entry.y + 1,
        h: entry.id === "note" ? 1 : entry.h,
      })),
    ],
    custom(2, [
      { id: "chart", page: 1, x: 0, y: 0, w: 5, h: 6 },
      { id: "m1", page: 1, x: 5, y: 0, w: 4, h: 3 },
      { id: "m2", page: 1, x: 5, y: 3, w: 4, h: 3 },
      { id: "note", page: 1, x: 0, y: 6, w: 9, h: 1 },
    ]),
  );
  add(
    "a custom layout with nothing placed is filled",
    sixteen,
    "9x16",
    sixteen.widgets,
    custom(1, []),
  );
  // Eight full pages: the added widget takes a free minimum spot or is hidden.
  const full = custom(
    CUSTOM_LAYOUT_MAX_PAGES,
    Array.from({ length: CUSTOM_LAYOUT_MAX_PAGES }, (_, page) => ({
      id: `p${page}`,
      page,
      x: 0,
      y: 0,
      w: 6,
      h: page === 5 ? 12 : 14,
    })),
  );
  const pages = full.placements.map((placement, i) =>
    widget(placement.id, "text", 0, i, 6, 1),
  );
  const pagesSlide: SlideFixture = {
    name: "pages",
    format: "16x9",
    widgets: pages,
  };
  add(
    "eight pages: a free minimum spot on any page",
    pagesSlide,
    "9x16",
    [...pages, widget("late", "metric", 6, 0, 3, 2)],
    full,
  );
  add(
    "eight full pages: hidden and flagged",
    pagesSlide,
    "9x16",
    [...pages, widget("late", "line", 6, 0, 6, 4)],
    custom(
      CUSTOM_LAYOUT_MAX_PAGES,
      full.placements.map((placement) => ({ ...placement, h: 14 })),
    ),
  );
  return cases;
}

function frameScreens(format: ScreenFormat): StudioCanvas[] {
  return [SCREEN_FORMATS[format].reference, ...FRAME_SCREENS];
}

const RECT_PLACEMENTS = (format: ScreenFormat): StudioPlacement[] => {
  const { columns, rows } = SCREEN_FORMATS[format];
  return [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 0, y: 0, w: columns, h: rows },
    { x: columns - 1, y: rows - 1, w: 1, h: 1 },
    { x: 1, y: 2, w: 3, h: 2 },
  ];
};

export function buildScreenFormatVectors() {
  const formats = SCREEN_FORMAT_KEYS.map((key) => SCREEN_FORMATS[key]);

  const formatForCases = SCREENS.map((screen) => ({
    ...screen,
    format: formatFor(screen.width, screen.height),
    sizeClass: sizeClassFor(screen.width, screen.height),
  }));

  const frames = SCREEN_FORMAT_KEYS.flatMap((format) =>
    frameScreens(format).flatMap((screen) =>
      [true, false].map((showHeader) => ({
        screen,
        format,
        showHeader,
        frame: screenFrame(screen, format, showHeader),
      })),
    ),
  );

  const rects = SCREEN_FORMAT_KEYS.flatMap((format) =>
    frameScreens(format)
      .slice(0, 6)
      .flatMap((screen) =>
        RECT_PLACEMENTS(format).map((placement) => ({
          screen,
          format,
          showHeader: true,
          placement,
          rect: placementRect(placement, screenFrame(screen, format, true)),
        })),
      ),
  );

  const labelFits = SCREEN_FORMAT_KEYS.flatMap((format) =>
    LABELS.flatMap((label) =>
      (
        [
          { type: "metric", w: 3, h: 2 },
          { type: "metric", w: 4, h: 3 },
          { type: "line", w: 6, h: 4 },
        ] as const
      ).map((entry) => ({
        format,
        label,
        type: entry.type,
        w: entry.w,
        h: entry.h,
        fontScale: 1,
        ...labelFit(label, entry, { format }),
      })),
    ),
  );

  const kinds = ["tvos", "kiosk", "browser"] as const;
  const sizeClasses: ScreenSizeClass[] = ["compact", "regular", "large"];
  const deviceModes: Array<DisplayMode | null> = [null, "screen", "scroll"];
  const displayModes = kinds.flatMap((kind) =>
    sizeClasses.flatMap((sizeClass) =>
      [true, false].flatMap((coarsePointer) =>
        deviceModes.map((deviceMode) => ({
          kind,
          sizeClass,
          coarsePointer,
          deviceMode,
          mode: defaultDisplayMode({
            kind,
            sizeClass,
            coarsePointer,
            deviceMode,
          }),
        })),
      ),
    ),
  );

  const slides = SLIDE_FIXTURES.map((slide) => ({
    name: slide.name,
    format: slide.format,
    widgets: slide.widgets,
    readingOrder: studioReadingOrder(slide.widgets).map((entry) => entry.id),
    reflow: Object.fromEntries(
      SCREEN_FORMAT_KEYS.map((to) => [
        to,
        reflowSlide(slide.widgets, slide.format, to),
      ]),
    ),
    scroll: SCROLL_WIDTHS.map((width) => ({
      width,
      ...scrollLayout(slide.widgets, width),
    })),
  }));

  const sync = syncCases().map((entry) => ({
    ...entry,
    problems: validateCustomLayout(entry.custom, entry.widgets, entry.format),
    completed: completeCustomLayout(
      entry.custom,
      { format: entry.primaryFormat, widgets: entry.widgets },
      entry.format,
    ),
  }));

  const validation = validationCases().map((entry) => ({
    ...entry,
    problems: validateCustomLayout(entry.custom, entry.widgets, entry.format),
  }));

  return {
    about:
      "Generated from packages/domain/src/screen-formats.ts and studio-layout.ts by `pnpm vectors:formats`. Do not edit by hand.",
    formats,
    formatFor: formatForCases,
    frames,
    rects,
    labelFits,
    displayModes,
    slides,
    sync,
    validation,
  };
}

/** Layouts with one problem each, for `validateCustomLayout`. */
function validationCases(): Array<{
  name: string;
  format: ScreenFormat;
  widgets: LayoutWidget[];
  custom: CustomLayout;
}> {
  const widgets = [
    widget("a", "metric", 0, 0, 6, 4),
    widget("b", "line", 6, 0, 6, 4),
    widget("c", "text", 0, 4, 12, 4),
  ];
  const valid = custom(2, [
    { id: "a", page: 0, x: 0, y: 0, w: 6, h: 4 },
    { id: "b", page: 0, x: 0, y: 4, w: 6, h: 6 },
    { id: "c", page: 1, x: 0, y: 0, w: 6, h: 4 },
  ]);
  const change = (
    name: string,
    edit: (layout: CustomLayout) => CustomLayout,
  ) => ({ name, format: "3x4" as const, widgets, custom: edit(valid) });
  const patch =
    (id: string, values: Partial<CustomPlacement>) =>
    (layout: CustomLayout): CustomLayout => ({
      ...layout,
      placements: layout.placements.map((placement) =>
        placement.id === id ? { ...placement, ...values } : placement,
      ),
    });
  return [
    change("valid", (layout) => layout),
    change("no pages", (layout) => ({ ...layout, pages: 0 })),
    change("nine pages", (layout) => ({ ...layout, pages: 9 })),
    change("page out of range", patch("c", { page: 2 })),
    change("outside the grid", patch("c", { x: 1 })),
    change("too small", patch("b", { w: 3 })),
    change("overlap", patch("b", { y: 3 })),
    change("hidden may overlap", patch("b", { y: 3, hidden: true })),
    change("missing", (layout) => ({
      ...layout,
      placements: layout.placements.filter((placement) => placement.id !== "a"),
    })),
    change("duplicated", (layout) => ({
      ...layout,
      placements: [...layout.placements, { ...layout.placements[2]! }],
    })),
    change("unknown", (layout) => ({
      ...layout,
      placements: [
        ...layout.placements,
        {
          id: "z",
          page: 0,
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          hidden: false,
          autoPlaced: false,
        },
      ],
    })),
  ];
}
