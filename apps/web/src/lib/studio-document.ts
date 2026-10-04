import type {
  CreateDashboardRequest,
  Dashboard,
  DashboardSettings,
  DashboardSlide,
  DashboardSlideInput,
  DashboardWidget,
  DashboardWidgetInput,
  ReplaceDashboardRequest,
  SlideLayout,
} from "@netrics/contracts";
import {
  DEFAULT_THEME_KEY,
  SCREEN_FORMATS,
  SLIDE_SECONDS,
  STUDIO_LIMITS,
  STUDIO_MIN_WIDGET_SIZE,
  isBuiltinThemeKey,
  isDataWidgetType,
  isInsideFormatGrid,
  meetsMinimumSize,
  placementsOverlap,
  type CustomLayout,
  type Locale,
  type ScreenFormat,
  type StudioPlacement,
  type WidgetType,
} from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";

import {
  nearestFreePlacement,
  nudgePlacement,
  placementBlocker,
  resizePlacement,
  samePlacement,
} from "./studio-grid";
import { widgetInputProblem } from "./studio-inspector";
import {
  addPage,
  autoAsCustom,
  confirmPlacements,
  copyLayouts,
  customLayoutOf,
  layoutsForSave,
  moveInLayout,
  moveToPage,
  removePage,
  setHidden,
  withLayout,
  withoutWidget,
  type LayoutEdit,
  type LayoutMove,
} from "./studio-layouts";
import { slideTitle } from "./studio-widgets";

// The Studio's draft of one dashboard (ADR 0015, section 9): the document
// as the user edits it, what is selected, and undo history. Everything here
// is pure, so the editor's behaviour is tested without a browser. The
// document is saved as a whole with an explicit Save (no autosave): screens
// show a dashboard as soon as it is saved.

/**
 * A slide in the draft; its position is its index. Its custom layouts per
 * format (ADR 0017 section 4, #284) are edited with the document and
 * saved with it; missing `layouts` (a draft built without them) leaves the
 * stored ones as they are. Format warnings are computed, not edited.
 */
export type StudioSlide = Omit<
  DashboardSlide,
  "position" | "layouts" | "formatWarnings"
> & { layouts?: SlideLayout[] };

/** What a Save sends: name, project, settings, slides and widgets. */
export interface StudioDocument {
  name: string;
  projectId: string | null;
  settings: DashboardSettings;
  slides: StudioSlide[];
  /**
   * The format widgets are placed in (ADR 0017); missing: `16x9`. Changed
   * only by a save that re-bases the dashboard (see `toReplaceRequest`).
   */
  primaryFormat?: ScreenFormat;
}

/** The document's primary format. */
export function primaryOf(document: Pick<StudioDocument, "primaryFormat">) {
  return document.primaryFormat ?? "16x9";
}

export interface StudioState {
  dashboardId: string;
  /** The server version the draft is based on (sent with Save). */
  version: number;
  /** The document as last loaded or saved. */
  saved: StudioDocument;
  draft: StudioDocument;
  selectedSlideId: string;
  /** Null: the slide (and dashboard settings) are being edited. */
  selectedWidgetId: string | null;
  /** Earlier drafts, newest last, for undo. */
  past: StudioDocument[];
  /** Undone drafts, newest last, for redo. */
  future: StudioDocument[];
  /** Consecutive edits with the same key (typing) undo as one. */
  lastEditKey: string | null;
  /** For the polite live region; the counter makes a repeat re-announce. */
  announcement: { id: number; text: string } | null;
  /** The editor's language: announcements and problems use it. */
  locale: Locale;
}

/** A widget as the add menu creates it: no id or placement yet. */
export type NewWidget = DistributiveOmit<
  DashboardWidget,
  "id" | "x" | "y" | "w" | "h"
>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** The fields of a widget the inspector edits (title, text, options, …). */
export type WidgetPatch = Partial<
  DistributiveOmit<DashboardWidget, "id" | "type">
>;

export type SlidePatch = Partial<
  Pick<StudioSlide, "name" | "durationSeconds" | "enabled" | "background">
>;

export type StudioAction =
  | { type: "selectSlide"; slideId: string }
  | { type: "selectWidget"; widgetId: string | null }
  | { type: "rename"; name: string }
  | { type: "setProject"; projectId: string | null }
  | { type: "updateSettings"; patch: Partial<DashboardSettings> }
  | { type: "addSlide" }
  | { type: "duplicateSlide"; slideId: string }
  | { type: "deleteSlide"; slideId: string }
  | { type: "moveSlide"; slideId: string; to: number }
  | { type: "updateSlide"; slideId: string; patch: SlidePatch }
  | { type: "addWidget"; widget: NewWidget }
  | { type: "updateWidget"; widgetId: string; patch: WidgetPatch }
  | { type: "deleteWidget"; widgetId: string }
  /**
   * A finished drag on the canvas: one undo step, refused on overlap. With
   * a `format` other than the primary it moves the widget in the slide's
   * custom layout of that format (#284), and so do the two below.
   */
  | {
      type: "placeWidget";
      widgetId: string;
      placement: StudioPlacement;
      format?: ScreenFormat;
    }
  /** Arrow keys: one cell that way (over widgets in the way). */
  | {
      type: "nudgeWidget";
      widgetId: string;
      dx: number;
      dy: number;
      format?: ScreenFormat;
    }
  /** Shift+Arrow keys: one cell wider, narrower, taller or shorter. */
  | {
      type: "resizeWidgetBy";
      widgetId: string;
      dw: number;
      dh: number;
      format?: ScreenFormat;
    }
  // Custom layouts per format (ADR 0017 section 4, #284)
  /** "Customize": the format's auto layout becomes the slide's own. */
  | { type: "customizeFormat"; slideId: string; format: ScreenFormat }
  /** "Back to automatic": the slide's custom layout is removed. */
  | { type: "resetFormat"; slideId: string; format: ScreenFormat }
  | { type: "addLayoutPage"; slideId: string; format: ScreenFormat }
  | {
      type: "removeLayoutPage";
      slideId: string;
      format: ScreenFormat;
      page: number;
    }
  | {
      type: "moveWidgetToPage";
      widgetId: string;
      format: ScreenFormat;
      page: number;
    }
  /** Hide in (or show again in) one format; `page`: where to show it. */
  | {
      type: "setWidgetHidden";
      widgetId: string;
      format: ScreenFormat;
      hidden: boolean;
      page?: number;
    }
  /** "Looks good": one widget's review flag, or every flag of the slide. */
  | {
      type: "confirmPlacement";
      slideId: string;
      format: ScreenFormat;
      widgetId: string | null;
    }
  /** Merges into the widget's type-specific options (#225). */
  | { type: "updateWidgetOptions"; widgetId: string; patch: object }
  /**
   * The widget becomes another type (#225): `widget` holds its new fields
   * (see convertWidget); id and position stay, and the size grows to the
   * new type's minimum where there is room.
   */
  | { type: "changeWidgetType"; widgetId: string; widget: NewWidget }
  /** Cmd/Ctrl+D: a copy on the same slide, in the nearest free spot. */
  | { type: "duplicateWidget"; widgetId: string }
  /** Cmd/Ctrl+V: a copied widget onto the selected slide. */
  | { type: "pasteWidget"; widget: DashboardWidget }
  /** A new widget dropped from the add menu at a spot on the canvas. */
  | { type: "addWidgetAt"; widget: NewWidget; placement: StudioPlacement }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "discard" }
  /** The server's copy after a Save: the new base, the draft follows it. */
  | { type: "saved"; dashboard: Dashboard }
  /** The server's copy replaces the draft (after a conflict). */
  | { type: "reload"; dashboard: Dashboard }
  | { type: "announce"; text: string };

const HISTORY_LIMIT = 100;

export function toDocument(dashboard: Dashboard): StudioDocument {
  return {
    name: dashboard.name,
    projectId: dashboard.projectId,
    settings: { ...dashboard.settings },
    primaryFormat: dashboard.primaryFormat,
    slides: dashboard.slides.map(
      ({ position: _position, formatWarnings: _warnings, ...slide }) => ({
        ...slide,
        widgets: slide.widgets.map((widget) => ({ ...widget })),
        layouts: (slide.layouts ?? []).map((layout) => ({
          ...layout,
          placements: layout.placements.map((placement) => ({
            ...placement,
          })),
        })),
      }),
    ),
  };
}

export function initialStudioState(
  dashboard: Dashboard,
  locale: Locale,
): StudioState {
  const document = toDocument(dashboard);
  return {
    dashboardId: dashboard.id,
    version: dashboard.version,
    saved: document,
    draft: document,
    selectedSlideId: document.slides[0]?.id ?? "",
    selectedWidgetId: null,
    past: [],
    future: [],
    lastEditKey: null,
    announcement: null,
    locale,
  };
}

/** The Studio's messages about the document, in `locale`. */
function messages(locale: Locale) {
  return webTranslator(locale, "studio.document");
}

/** JSON with sorted keys, so equal documents compare equal. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}

export function documentsEqual(a: StudioDocument, b: StudioDocument) {
  return stableStringify(a) === stableStringify(b);
}

/** Unsaved changes: the draft differs from the last loaded or saved copy. */
export function isDirty(state: StudioState): boolean {
  return (
    state.draft !== state.saved && !documentsEqual(state.draft, state.saved)
  );
}

export function selectedSlide(state: StudioState): StudioSlide | undefined {
  return (
    state.draft.slides.find((slide) => slide.id === state.selectedSlideId) ??
    state.draft.slides[0]
  );
}

export function selectedWidget(state: StudioState): DashboardWidget | null {
  if (!state.selectedWidgetId) {
    return null;
  }
  return (
    selectedSlide(state)?.widgets.find(
      (widget) => widget.id === state.selectedWidgetId,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Placement

/** The size the add menu gives a new widget, when there is room. */
export const DEFAULT_WIDGET_SIZE: Readonly<
  Record<WidgetType, { w: number; h: number }>
> = {
  metric: { w: 4, h: 3 },
  line: { w: 6, h: 4 },
  bar: { w: 6, h: 4 },
  image: { w: 3, h: 3 },
  text: { w: 4, h: 2 },
  clock: { w: 3, h: 2 },
};

/**
 * Where a new widget of `type` goes on a slide: the first free spot in
 * reading order at its default size, else at its minimum size; null when
 * the slide has no room for it. On the grid of `format` (the primary).
 */
export function findFreePlacement(
  widgets: readonly StudioPlacement[],
  type: WidgetType,
  format: ScreenFormat = "16x9",
): StudioPlacement | null {
  const { columns, rows } = SCREEN_FORMATS[format];
  for (const size of [
    {
      w: Math.min(DEFAULT_WIDGET_SIZE[type].w, columns),
      h: Math.min(DEFAULT_WIDGET_SIZE[type].h, rows),
    },
    STUDIO_MIN_WIDGET_SIZE[type],
  ]) {
    for (let y = 0; y + size.h <= rows; y++) {
      for (let x = 0; x + size.w <= columns; x++) {
        const candidate = { x, y, ...size };
        if (!widgets.some((other) => placementsOverlap(candidate, other))) {
          return candidate;
        }
      }
    }
  }
  return null;
}

/**
 * The placement of a widget that becomes `type`: the same, grown to the
 * type's minimum size where it is smaller (kept inside the grid, moved
 * left or up when it would leave it); null when the grown widget would
 * overlap another.
 */
export function grownPlacement(
  placement: StudioPlacement,
  type: WidgetType,
  others: readonly StudioPlacement[],
  format: ScreenFormat = "16x9",
): StudioPlacement | null {
  const { columns, rows } = SCREEN_FORMATS[format];
  const minimum = STUDIO_MIN_WIDGET_SIZE[type];
  const w = Math.max(placement.w, minimum.w);
  const h = Math.max(placement.h, minimum.h);
  const candidate = {
    x: Math.max(0, Math.min(placement.x, columns - w)),
    y: Math.max(0, Math.min(placement.y, rows - h)),
    w,
    h,
  };
  if (
    w > columns ||
    h > rows ||
    others.some((other) => placementsOverlap(candidate, other))
  ) {
    return null;
  }
  return candidate;
}

/** Why a widget of `type` cannot be added to a slide, or null. */
export function addWidgetBlocker(
  document: StudioDocument,
  slide: StudioSlide,
  type: WidgetType,
  locale: Locale,
): string | null {
  const limit = widgetLimitBlocker(document, slide, type, locale);
  if (limit) {
    return limit;
  }
  if (!findFreePlacement(slide.widgets, type, primaryOf(document))) {
    return messages(locale)("noSpace");
  }
  return null;
}

export function dataWidgetCount(document: StudioDocument): number {
  return document.slides
    .flatMap((slide) => slide.widgets)
    .filter((widget) => isDataWidgetType(widget.type)).length;
}

/**
 * The index a dragged slide lands on: `insertAt` is the gap it is dropped
 * in (0 before the first slide … n after the last), counted before the
 * slide is taken out.
 */
export function reorderTarget(from: number, insertAt: number): number {
  return insertAt > from ? insertAt - 1 : insertAt;
}

/**
 * The gap a pointer at `y` points to, given the vertical midpoints of the
 * slides in the rail (top to bottom).
 */
export function insertionIndex(midpoints: readonly number[], y: number) {
  const index = midpoints.findIndex((midpoint) => y < midpoint);
  return index === -1 ? midpoints.length : index;
}

// ---------------------------------------------------------------------------
// Validation (shown at the slide and widget, before Save)

export interface StudioProblem {
  /** Null: the dashboard itself. */
  slideId: string | null;
  widgetId: string | null;
  message: string;
}

function durationOk(seconds: number) {
  return (
    Number.isInteger(seconds) &&
    seconds >= SLIDE_SECONDS.min &&
    seconds <= SLIDE_SECONDS.max
  );
}

/**
 * What the server would refuse, found before saving: names, durations,
 * limits, and every widget outside the grid, below its minimum size or
 * overlapping another (the same rules as slideLayoutProblem).
 */
export function documentProblems(
  document: StudioDocument,
  locale: Locale,
): StudioProblem[] {
  const t = messages(locale);
  const seconds = { min: SLIDE_SECONDS.min, max: SLIDE_SECONDS.max };
  const problems: StudioProblem[] = [];
  const dashboard = (message: string) =>
    problems.push({ slideId: null, widgetId: null, message });
  if (document.name.trim() === "") {
    dashboard(t("problems.nameMissing"));
  } else if (document.name.trim().length > 100) {
    dashboard(t("problems.nameTooLong", { max: 100 }));
  }
  if (!durationOk(document.settings.defaultSlideSeconds)) {
    dashboard(t("problems.defaultDuration", seconds));
  }
  if (document.slides.length > STUDIO_LIMITS.slides) {
    dashboard(t("limits.slides", { max: STUDIO_LIMITS.slides }));
  }
  if (dataWidgetCount(document) > STUDIO_LIMITS.dataWidgets) {
    dashboard(t("limits.dataWidgets", { max: STUDIO_LIMITS.dataWidgets }));
  }
  document.slides.forEach((slide, index) => {
    const title = slideTitle(slide, index, locale);
    const atSlide = (message: string, widgetId: string | null = null) =>
      problems.push({ slideId: slide.id, widgetId, message });
    if (
      slide.name !== null &&
      slide.name.trim().length > STUDIO_LIMITS.slideNameLength
    ) {
      atSlide(
        t("problems.slideNameTooLong", {
          slide: title,
          max: STUDIO_LIMITS.slideNameLength,
        }),
      );
    }
    if (slide.durationSeconds !== null && !durationOk(slide.durationSeconds)) {
      atSlide(t("problems.slideDuration", { slide: title, ...seconds }));
    }
    if (slide.widgets.length > STUDIO_LIMITS.widgetsPerSlide) {
      atSlide(
        t("problems.slideWidgets", {
          slide: title,
          max: STUDIO_LIMITS.widgetsPerSlide,
        }),
      );
    }
    slide.widgets.forEach((widget, widgetIndex) => {
      const at = (message: string) =>
        atSlide(t("problems.atSlide", { slide: title, message }), widget.id);
      const name = widgetName(widget, locale);
      if (!isInsideFormatGrid(widget, primaryOf(document))) {
        at(t("problems.outside", { name }));
      } else if (!meetsMinimumSize(widget.type, widget)) {
        const minimum = STUDIO_MIN_WIDGET_SIZE[widget.type];
        at(t("problems.tooSmall", { name, w: minimum.w, h: minimum.h }));
      }
      const overlaps = slide.widgets.some(
        (other, otherIndex) =>
          otherIndex !== widgetIndex && placementsOverlap(widget, other),
      );
      if (overlaps) {
        at(t("problems.overlaps", { name }));
      }
      if (widget.title !== null && widget.title.trim() === "") {
        at(t("problems.emptyTitle", { name }));
      } else if (
        widget.title !== null &&
        widget.title.trim().length > STUDIO_LIMITS.widgetTitleLength
      ) {
        at(
          t("problems.titleTooLong", {
            name,
            max: STUDIO_LIMITS.widgetTitleLength,
          }),
        );
      }
      if (widget.type === "text") {
        if (widget.text.trim() === "") {
          at(t("problems.textEmpty"));
        } else if (widget.text.length > STUDIO_LIMITS.textLength) {
          at(t("problems.textTooLong", { max: STUDIO_LIMITS.textLength }));
        }
      }
      // Anything else the API would refuse in the widget's own fields
      // (options per type), unless a clearer message above says it.
      if (!problems.some((problem) => problem.widgetId === widget.id)) {
        const invalid = widgetInputProblem(widget);
        if (invalid) {
          at(t("problems.invalid", { name, problem: invalid }));
        }
      }
    });
  });
  return problems;
}

/** "Downloads (metric)", "Text", … for announcements and problems. */
export function widgetName(widget: DashboardWidget, locale: Locale): string {
  const t = messages(locale);
  return widget.title
    ? t("namedWidget", { title: widget.title, type: widget.type })
    : widgetTypeName(widget.type, locale);
}

/** "Metric", "Line chart", … */
export function widgetTypeName(type: WidgetType, locale: Locale): string {
  return messages(locale)("typeName", { type });
}

// ---------------------------------------------------------------------------
// Requests

function widgetInput(widget: DashboardWidget): DashboardWidgetInput {
  switch (widget.type) {
    case "metric":
    case "line":
    case "bar": {
      const {
        resourceName: _resourceName,
        allResourcesName: _allResourcesName,
        ...input
      } = widget;
      return { ...input, title: input.title?.trim() || null };
    }
    case "text":
      return { ...widget, title: widget.title?.trim() || null };
    default:
      return { ...widget, title: widget.title?.trim() || null };
  }
}

/**
 * The slides as sent. Custom layouts go along completed against the
 * draft's widgets (`layoutsForSave`); they name widgets by id, so a copy
 * keeps the ids of widgets on slides with custom layouts (a new dashboard
 * gets new ids for all of them anyway).
 */
function slideInputs(
  document: StudioDocument,
  keepIds: boolean,
): DashboardSlideInput[] {
  const primary = primaryOf(document);
  return document.slides.map((slide) => {
    const layouts =
      slide.layouts === undefined ? undefined : layoutsForSave(slide, primary);
    const keepWidgetIds = keepIds || (layouts?.length ?? 0) > 0;
    return {
      ...(keepIds ? { id: slide.id } : {}),
      name: slide.name?.trim() || null,
      durationSeconds: slide.durationSeconds,
      enabled: slide.enabled,
      background: slide.background,
      widgets: slide.widgets.map((widget) => {
        const input = widgetInput(widget);
        if (!keepWidgetIds) {
          delete input.id;
        }
        return input;
      }),
      ...(layouts === undefined ? {} : { layouts }),
    };
  });
}

function settingsInput(settings: DashboardSettings) {
  const builtin =
    settings.themeBuiltin && isBuiltinThemeKey(settings.themeBuiltin)
      ? settings.themeBuiltin
      : null;
  const themeId = builtin ? null : settings.themeId;
  return {
    showHeader: settings.showHeader,
    autoAdvance: settings.autoAdvance,
    defaultSlideSeconds: settings.defaultSlideSeconds,
    transition: settings.transition,
    themeBuiltin: builtin ?? (themeId ? null : DEFAULT_THEME_KEY),
    themeId,
    accentColor: settings.accentColor,
    logoImageId: settings.logoImageId,
  };
}

/**
 * The PUT body for a Save: the whole document with its base version. With
 * `primaryFormat` (other than the draft's) the save also re-bases the
 * dashboard on that format (ADR 0017 section 4): the server answers 409
 * format_has_overflow or format_has_hidden_widgets when it cannot.
 */
export function toReplaceRequest(
  state: StudioState,
  options: { primaryFormat?: ScreenFormat } = {},
): ReplaceDashboardRequest {
  const { draft } = state;
  const rebase =
    options.primaryFormat !== undefined &&
    options.primaryFormat !== primaryOf(draft);
  return {
    version: state.version,
    name: draft.name.trim(),
    projectId: draft.projectId,
    settings: settingsInput(draft.settings),
    ...(rebase ? { primaryFormat: options.primaryFormat } : {}),
    slides: slideInputs(draft, true),
  } as ReplaceDashboardRequest;
}

/** The draft as a new dashboard ("Save as copy" after a conflict). */
export function toCopyRequest(
  document: StudioDocument,
  name: string,
): CreateDashboardRequest {
  const primary = primaryOf(document);
  return {
    name,
    projectId: document.projectId,
    settings: settingsInput(document.settings),
    ...(primary === "16x9" ? {} : { primaryFormat: primary }),
    slides: slideInputs(document, false),
  } as CreateDashboardRequest;
}

/** "Overview (copy)", kept within the 100-character name limit. */
export function copyName(name: string, locale: Locale): string {
  return copyOf(name, 100, locale);
}

/** "<name> (copy)" in `locale`, the name cut so it stays within `max`. */
function copyOf(name: string, max: number, locale: Locale): string {
  const t = messages(locale);
  const suffix = t("copyOf", { name: "" });
  return t("copyOf", {
    name: name.trim().slice(0, Math.max(0, max - suffix.length)),
  });
}

// ---------------------------------------------------------------------------
// Reducer

function announce(state: StudioState, text: string): StudioState {
  return {
    ...state,
    announcement: { id: (state.announcement?.id ?? 0) + 1, text },
  };
}

/** A new draft, remembered for undo (typing with one key undoes at once). */
function edit(
  state: StudioState,
  draft: StudioDocument,
  editKey: string | null = null,
): StudioState {
  const coalesce = editKey !== null && editKey === state.lastEditKey;
  return {
    ...state,
    draft,
    past: coalesce
      ? state.past
      : [...state.past, state.draft].slice(-HISTORY_LIMIT),
    future: [],
    lastEditKey: editKey,
  };
}

function mapSlide(
  document: StudioDocument,
  slideId: string,
  change: (slide: StudioSlide) => StudioSlide,
): StudioDocument {
  return {
    ...document,
    slides: document.slides.map((slide) =>
      slide.id === slideId ? change(slide) : slide,
    ),
  };
}

function emptySlide(id: string): StudioSlide {
  return {
    id,
    name: null,
    durationSeconds: null,
    enabled: true,
    background: null,
    widgets: [],
    layouts: [],
  };
}

/** Selection that still exists in `draft`, else the nearest slide. */
function keepSelection(
  state: StudioState,
  draft: StudioDocument,
  fallbackIndex = 0,
): Pick<StudioState, "selectedSlideId" | "selectedWidgetId"> {
  const slide = draft.slides.find((s) => s.id === state.selectedSlideId);
  if (slide) {
    return {
      selectedSlideId: slide.id,
      selectedWidgetId: slide.widgets.some(
        (widget) => widget.id === state.selectedWidgetId,
      )
        ? state.selectedWidgetId
        : null,
    };
  }
  const index = Math.min(Math.max(fallbackIndex, 0), draft.slides.length - 1);
  return {
    selectedSlideId: draft.slides[index]?.id ?? "",
    selectedWidgetId: null,
  };
}

/**
 * The editor's reducer. Ids for new slides and widgets come from `newId`
 * (crypto.randomUUID in the browser): the server keeps ids it knows and
 * replaces unknown ones, so a new id is only a client-side handle.
 */
export function createStudioReducer(newId: () => string) {
  return function studioReducer(
    state: StudioState,
    action: StudioAction,
  ): StudioState {
    const { draft, locale } = state;
    const t = messages(locale);
    switch (action.type) {
      case "selectSlide":
        if (!draft.slides.some((slide) => slide.id === action.slideId)) {
          return state;
        }
        return {
          ...state,
          selectedSlideId: action.slideId,
          selectedWidgetId:
            action.slideId === state.selectedSlideId
              ? state.selectedWidgetId
              : null,
          lastEditKey: null,
        };
      case "selectWidget":
        return {
          ...state,
          selectedWidgetId:
            action.widgetId &&
            selectedSlide(state)?.widgets.some((w) => w.id === action.widgetId)
              ? action.widgetId
              : null,
          lastEditKey: null,
        };
      case "rename":
        return edit(state, { ...draft, name: action.name }, "name");
      case "setProject":
        return edit(state, { ...draft, projectId: action.projectId });
      case "updateSettings": {
        const keys = Object.keys(action.patch).sort().join(",");
        return edit(
          state,
          { ...draft, settings: { ...draft.settings, ...action.patch } },
          `settings:${keys}`,
        );
      }
      case "addSlide": {
        if (draft.slides.length >= STUDIO_LIMITS.slides) {
          return announce(
            state,
            t("limits.slides", { max: STUDIO_LIMITS.slides }),
          );
        }
        const at =
          draft.slides.findIndex((s) => s.id === state.selectedSlideId) + 1 ||
          draft.slides.length;
        const slide = emptySlide(newId());
        const slides = [...draft.slides];
        slides.splice(at, 0, slide);
        return announce(
          {
            ...edit(state, { ...draft, slides }),
            selectedSlideId: slide.id,
            selectedWidgetId: null,
          },
          t("announce.slideAdded", { number: at + 1 }),
        );
      }
      case "duplicateSlide": {
        const index = draft.slides.findIndex((s) => s.id === action.slideId);
        const source = draft.slides[index];
        if (!source) {
          return state;
        }
        if (draft.slides.length >= STUDIO_LIMITS.slides) {
          return announce(
            state,
            t("limits.slides", { max: STUDIO_LIMITS.slides }),
          );
        }
        const renamed = new Map(
          source.widgets.map((widget) => [widget.id, newId()]),
        );
        const copy: StudioSlide = {
          ...source,
          id: newId(),
          name: source.name
            ? copyOf(source.name, STUDIO_LIMITS.slideNameLength, locale)
            : null,
          widgets: source.widgets.map((widget) => ({
            ...widget,
            id: renamed.get(widget.id)!,
          })),
        };
        const layouts = copyLayouts(source.layouts, renamed);
        if (layouts) {
          copy.layouts = layouts;
        }
        const slides = [...draft.slides];
        slides.splice(index + 1, 0, copy);
        const next: StudioDocument = { ...draft, slides };
        if (dataWidgetCount(next) > STUDIO_LIMITS.dataWidgets) {
          return announce(
            state,
            t("limits.dataWidgets", { max: STUDIO_LIMITS.dataWidgets }),
          );
        }
        return announce(
          {
            ...edit(state, next),
            selectedSlideId: copy.id,
            selectedWidgetId: null,
          },
          t("announce.slideDuplicated", {
            slide: slideTitle(source, index, locale),
            number: index + 2,
          }),
        );
      }
      case "deleteSlide": {
        const index = draft.slides.findIndex((s) => s.id === action.slideId);
        if (index === -1 || draft.slides.length <= 1) {
          return state;
        }
        const removed = draft.slides[index]!;
        const next: StudioDocument = {
          ...draft,
          slides: draft.slides.filter((s) => s.id !== action.slideId),
        };
        return announce(
          { ...edit(state, next), ...keepSelection(state, next, index - 1) },
          t("announce.deleted", { name: slideTitle(removed, index, locale) }),
        );
      }
      case "moveSlide": {
        const from = draft.slides.findIndex((s) => s.id === action.slideId);
        const to = Math.min(Math.max(action.to, 0), draft.slides.length - 1);
        if (from === -1 || from === to) {
          return state;
        }
        const slides = [...draft.slides];
        const [slide] = slides.splice(from, 1);
        slides.splice(to, 0, slide!);
        const label = slide!.name
          ? t("quoted", { name: slide!.name })
          : slideTitle(slide!, from, locale);
        return announce(
          { ...edit(state, { ...draft, slides }), selectedSlideId: slide!.id },
          t("announce.slideMoved", {
            slide: label,
            position: to + 1,
            count: slides.length,
          }),
        );
      }
      case "updateSlide": {
        const keys = Object.keys(action.patch).sort().join(",");
        return edit(
          state,
          mapSlide(draft, action.slideId, (slide) => ({
            ...slide,
            ...action.patch,
          })),
          `slide:${action.slideId}:${keys}`,
        );
      }
      case "addWidget": {
        const slide = selectedSlide(state);
        if (!slide) {
          return state;
        }
        const blocker = addWidgetBlocker(
          draft,
          slide,
          action.widget.type,
          locale,
        );
        if (blocker) {
          return announce(state, blocker);
        }
        const placement = findFreePlacement(
          slide.widgets,
          action.widget.type,
          primaryOf(draft),
        )!;
        const widget = {
          ...action.widget,
          id: newId(),
          ...placement,
        } as DashboardWidget;
        return announce(
          {
            ...edit(
              state,
              mapSlide(draft, slide.id, (s) => ({
                ...s,
                widgets: [...s.widgets, widget],
              })),
            ),
            selectedWidgetId: widget.id,
          },
          t("announce.widgetPlaced", {
            name: widgetName(widget, locale),
            verb: "added",
            column: placement.x + 1,
            row: placement.y + 1,
          }),
        );
      }
      case "updateWidget": {
        const slide = draft.slides.find((s) =>
          s.widgets.some((widget) => widget.id === action.widgetId),
        );
        if (!slide) {
          return state;
        }
        const keys = Object.keys(action.patch).sort().join(",");
        return edit(
          state,
          mapSlide(draft, slide.id, (s) => ({
            ...s,
            widgets: s.widgets.map((widget) =>
              widget.id === action.widgetId
                ? ({ ...widget, ...action.patch } as DashboardWidget)
                : widget,
            ),
          })),
          `widget:${action.widgetId}:${keys}`,
        );
      }
      case "deleteWidget": {
        const slide = draft.slides.find((s) =>
          s.widgets.some((widget) => widget.id === action.widgetId),
        );
        const widget = slide?.widgets.find((w) => w.id === action.widgetId);
        if (!slide || !widget) {
          return state;
        }
        return announce(
          {
            ...edit(
              state,
              mapSlide(draft, slide.id, (s) => {
                const next: StudioSlide = {
                  ...s,
                  widgets: s.widgets.filter((w) => w.id !== action.widgetId),
                };
                const layouts = withoutWidget(s.layouts, action.widgetId);
                if (layouts) {
                  next.layouts = layouts;
                }
                return next;
              }),
            ),
            selectedWidgetId:
              state.selectedWidgetId === action.widgetId
                ? null
                : state.selectedWidgetId,
          },
          t("announce.deleted", { name: widgetName(widget, locale) }),
        );
      }
      case "placeWidget":
      case "nudgeWidget":
      case "resizeWidgetBy":
        return action.format !== undefined && action.format !== primaryOf(draft)
          ? placeInLayout(state, action, action.format)
          : placeWidget(state, action);
      case "customizeFormat":
      case "resetFormat":
      case "addLayoutPage":
      case "removeLayoutPage":
      case "moveWidgetToPage":
      case "setWidgetHidden":
      case "confirmPlacement":
        return editLayout(state, action);
      case "updateWidgetOptions": {
        const slide = draft.slides.find((s) =>
          s.widgets.some((widget) => widget.id === action.widgetId),
        );
        if (!slide) {
          return state;
        }
        const keys = Object.keys(action.patch).sort().join(",");
        return edit(
          state,
          mapSlide(draft, slide.id, (s) => ({
            ...s,
            widgets: s.widgets.map((widget) =>
              widget.id === action.widgetId
                ? ({
                    ...widget,
                    options: { ...widget.options, ...action.patch },
                  } as DashboardWidget)
                : widget,
            ),
          })),
          `widget:${action.widgetId}:options:${keys}`,
        );
      }
      case "changeWidgetType": {
        const slide = draft.slides.find((s) =>
          s.widgets.some((widget) => widget.id === action.widgetId),
        );
        const current = slide?.widgets.find((w) => w.id === action.widgetId);
        if (!slide || !current) {
          return state;
        }
        const to = action.widget.type;
        if (
          isDataWidgetType(to) &&
          !isDataWidgetType(current.type) &&
          dataWidgetCount(draft) >= STUDIO_LIMITS.dataWidgets
        ) {
          return announce(
            state,
            t("limits.dataWidgets", { max: STUDIO_LIMITS.dataWidgets }),
          );
        }
        const placement = grownPlacement(
          current,
          to,
          slide.widgets.filter((w) => w.id !== current.id),
          primaryOf(draft),
        );
        if (!placement) {
          const minimum = STUDIO_MIN_WIDGET_SIZE[to];
          return announce(
            state,
            t("announce.typeNoRoom", { type: to, w: minimum.w, h: minimum.h }),
          );
        }
        const widget = {
          ...action.widget,
          id: current.id,
          ...placement,
        } as DashboardWidget;
        return announce(
          edit(
            state,
            mapSlide(draft, slide.id, (s) => ({
              ...s,
              widgets: s.widgets.map((w) => (w.id === current.id ? widget : w)),
            })),
          ),
          t("announce.typeChanged", {
            name: widgetName(current, locale),
            type: to,
          }),
        );
      }
      case "duplicateWidget":
      case "pasteWidget":
      case "addWidgetAt":
        return insertWidget(state, action, newId);
      case "undo": {
        const previous = state.past.at(-1);
        if (!previous) {
          return state;
        }
        return announce(
          {
            ...state,
            draft: previous,
            past: state.past.slice(0, -1),
            future: [...state.future, draft],
            lastEditKey: null,
            ...keepSelection(state, previous),
          },
          t("announce.undone"),
        );
      }
      case "redo": {
        const next = state.future.at(-1);
        if (!next) {
          return state;
        }
        return announce(
          {
            ...state,
            draft: next,
            past: [...state.past, draft],
            future: state.future.slice(0, -1),
            lastEditKey: null,
            ...keepSelection(state, next),
          },
          t("announce.redone"),
        );
      }
      case "discard":
        return announce(
          {
            ...state,
            draft: state.saved,
            past: [],
            future: [],
            lastEditKey: null,
            ...keepSelection(state, state.saved),
          },
          t("announce.discarded"),
        );
      case "saved": {
        // New slides and widgets got their ids on the server: keep the
        // selection by position.
        const document = toDocument(action.dashboard);
        const slideIndex = Math.max(
          0,
          draft.slides.findIndex((s) => s.id === state.selectedSlideId),
        );
        const widgetIndex =
          draft.slides[slideIndex]?.widgets.findIndex(
            (w) => w.id === state.selectedWidgetId,
          ) ?? -1;
        const slide = document.slides[slideIndex] ?? document.slides[0];
        return announce(
          {
            ...state,
            version: action.dashboard.version,
            saved: document,
            draft: document,
            past: [],
            future: [],
            lastEditKey: null,
            selectedSlideId: slide?.id ?? "",
            selectedWidgetId:
              widgetIndex >= 0
                ? (slide?.widgets[widgetIndex]?.id ?? null)
                : null,
          },
          t("announce.saved"),
        );
      }
      case "reload": {
        const document = toDocument(action.dashboard);
        return announce(
          {
            ...state,
            version: action.dashboard.version,
            saved: document,
            draft: document,
            past: [],
            future: [],
            lastEditKey: null,
            ...keepSelection(state, document),
          },
          t("announce.reloaded"),
        );
      }
      case "announce":
        return announce(state, action.text);
    }
  };
}

// ---------------------------------------------------------------------------
// Moving and resizing on the grid (#224)

type PlacementAction = Extract<
  StudioAction,
  { type: "placeWidget" | "nudgeWidget" | "resizeWidgetBy" }
>;

function placementText(
  widget: DashboardWidget,
  to: StudioPlacement,
  locale: Locale,
  from: StudioPlacement = widget,
): string {
  const t = messages(locale);
  const values = {
    name: widgetName(widget, locale),
    column: to.x + 1,
    row: to.y + 1,
    w: to.w,
    h: to.h,
  };
  const moved = from.x !== to.x || from.y !== to.y;
  const resized = from.w !== to.w || from.h !== to.h;
  if (moved && resized) {
    return t("announce.resizedAt", values);
  }
  return resized ? t("announce.resized", values) : t("announce.moved", values);
}

/**
 * A widget's new place on its slide, from a drag or the keyboard. Refused,
 * with an announcement and no undo step, when it would leave the grid, go
 * below the type's minimum size or overlap another widget. The widget is
 * selected either way.
 */
function placeWidget(state: StudioState, action: PlacementAction): StudioState {
  const slide = state.draft.slides.find((s) =>
    s.widgets.some((widget) => widget.id === action.widgetId),
  );
  const widget = slide?.widgets.find((w) => w.id === action.widgetId);
  if (!slide || !widget) {
    return state;
  }
  const selected: StudioState = {
    ...state,
    selectedSlideId: slide.id,
    selectedWidgetId: widget.id,
    lastEditKey: null,
  };
  const { locale } = state;
  const t = messages(locale);
  const name = widgetName(widget, locale);
  const others = slide.widgets.filter((w) => w.id !== widget.id);
  const format = primaryOf(state.draft);
  let target: StudioPlacement | null;
  if (action.type === "nudgeWidget") {
    target = nudgePlacement(widget, action.dx, action.dy, others, format);
    if (!target) {
      return announce(selected, t("announce.cannotMove", { name }));
    }
  } else if (action.type === "resizeWidgetBy") {
    target = resizePlacement(widget, action.dw, action.dh, widget.type, format);
    if (!target) {
      const minimum = STUDIO_MIN_WIDGET_SIZE[widget.type];
      const shrinking = action.dw < 0 || action.dh < 0;
      return announce(
        selected,
        shrinking
          ? t("announce.minimumSize", { name, w: minimum.w, h: minimum.h })
          : t("announce.atEdge", { name }),
      );
    }
  } else {
    target = {
      x: action.placement.x,
      y: action.placement.y,
      w: action.placement.w,
      h: action.placement.h,
    };
  }
  if (samePlacement(widget, target)) {
    return selected;
  }
  const blocker = placementBlocker(target, widget.type, others, format);
  const sameSize = widget.w === target.w && widget.h === target.h;
  if (blocker && !(blocker.kind === "tooSmall" && sameSize)) {
    switch (blocker.kind) {
      case "outside":
        return announce(selected, t("announce.mustStay", { name }));
      case "tooSmall":
        return announce(
          selected,
          t("problems.tooSmall", {
            name,
            w: blocker.minimum.w,
            h: blocker.minimum.h,
          }),
        );
      case "overlap":
        return announce(
          selected,
          t("announce.wouldOverlap", {
            name,
            other: widgetName(others[blocker.index]!, locale),
          }),
        );
    }
  }
  const placed = target;
  return announce(
    edit(
      selected,
      mapSlide(state.draft, slide.id, (s) => ({
        ...s,
        widgets: s.widgets.map((w) =>
          w.id === widget.id ? ({ ...w, ...placed } as DashboardWidget) : w,
        ),
      })),
    ),
    placementText(widget, placed, locale),
  );
}

// ---------------------------------------------------------------------------
// Duplicate, paste and drop from the add menu (#241)

type InsertAction = Extract<
  StudioAction,
  { type: "duplicateWidget" | "pasteWidget" | "addWidgetAt" }
>;

/** Why one more widget of `type` cannot go on `slide` (limits only). */
export function widgetLimitBlocker(
  document: StudioDocument,
  slide: StudioSlide,
  type: WidgetType,
  locale: Locale,
): string | null {
  const t = messages(locale);
  if (slide.widgets.length >= STUDIO_LIMITS.widgetsPerSlide) {
    return t("limits.widgetsPerSlide", { max: STUDIO_LIMITS.widgetsPerSlide });
  }
  if (
    isDataWidgetType(type) &&
    dataWidgetCount(document) >= STUDIO_LIMITS.dataWidgets
  ) {
    return t("limits.dataWidgets", { max: STUDIO_LIMITS.dataWidgets });
  }
  return null;
}

/**
 * A widget added to a slide as one undo step, selected and announced: a
 * duplicate next to its source, a pasted copy near where it was on its own
 * slide, or a new widget where it was dropped. Refused, with the reason
 * announced, at the slide and dashboard limits and when there is no room
 * (or, for a drop, when the spot is taken).
 */
function insertWidget(
  state: StudioState,
  action: InsertAction,
  newId: () => string,
): StudioState {
  const { draft, locale } = state;
  const t = messages(locale);
  let slide: StudioSlide | undefined;
  let source: DashboardWidget | NewWidget;
  let verb: "added" | "duplicated" | "pasted";
  if (action.type === "duplicateWidget") {
    slide = draft.slides.find((s) =>
      s.widgets.some((widget) => widget.id === action.widgetId),
    );
    const found = slide?.widgets.find((w) => w.id === action.widgetId);
    if (!slide || !found) {
      return state;
    }
    source = found;
    verb = "duplicated";
  } else {
    slide = selectedSlide(state);
    if (!slide) {
      return state;
    }
    source = action.widget;
    verb = action.type === "pasteWidget" ? "pasted" : "added";
  }
  const blocker = widgetLimitBlocker(draft, slide, source.type, locale);
  if (blocker) {
    return announce(state, blocker);
  }
  const format = primaryOf(draft);
  let placement: StudioPlacement | null;
  if (action.type === "addWidgetAt") {
    placement = placementBlocker(
      action.placement,
      source.type,
      slide.widgets,
      format,
    )
      ? null
      : action.placement;
    if (!placement) {
      return announce(state, t("spotTaken"));
    }
  } else {
    const from = source as DashboardWidget;
    placement = nearestFreePlacement(from, from.type, slide.widgets, format);
    if (!placement) {
      return announce(state, t("noSpace"));
    }
  }
  const widget = {
    ...source,
    id: newId(),
    ...placement,
  } as DashboardWidget;
  const target = slide;
  return announce(
    {
      ...edit(
        state,
        mapSlide(draft, target.id, (s) => ({
          ...s,
          widgets: [...s.widgets, widget],
        })),
      ),
      selectedSlideId: target.id,
      selectedWidgetId: widget.id,
    },
    t("announce.widgetPlaced", {
      name: widgetName(widget, locale),
      verb,
      column: placement.x + 1,
      row: placement.y + 1,
    }),
  );
}

// ---------------------------------------------------------------------------
// Custom layouts per format (ADR 0017 section 4, #284)

/** "9:16" for `9x16`. */
function ratioOf(format: ScreenFormat): string {
  return format.replace("x", ":");
}

/** The slide holding a widget, and the widget. */
function findWidget(document: StudioDocument, widgetId: string) {
  for (const slide of document.slides) {
    const widget = slide.widgets.find((entry) => entry.id === widgetId);
    if (widget) return { slide, widget };
  }
  return null;
}

/** The draft with a slide's custom layout of `format` replaced. */
function withSlideLayout(
  document: StudioDocument,
  slideId: string,
  format: ScreenFormat,
  custom: CustomLayout | null,
): StudioDocument {
  return mapSlide(document, slideId, (slide) => ({
    ...slide,
    layouts: withLayout(slide.layouts, format, custom),
  }));
}

/**
 * A widget moved or resized in a custom layout (a drag or the keyboard on
 * a non-primary format): refused, announced and without an undo step as on
 * the primary; on a format without a custom layout, nothing happens.
 */
function placeInLayout(
  state: StudioState,
  action: PlacementAction,
  format: ScreenFormat,
): StudioState {
  const found = findWidget(state.draft, action.widgetId);
  if (!found) return state;
  const { slide, widget } = found;
  const custom = customLayoutOf(slide, primaryOf(state.draft), format);
  const from = custom?.placements.find((entry) => entry.id === widget.id);
  if (!custom || !from) return state;
  const selected: StudioState = {
    ...state,
    selectedSlideId: slide.id,
    selectedWidgetId: widget.id,
    lastEditKey: null,
  };
  const { locale } = state;
  const t = messages(locale);
  const name = widgetName(widget, locale);
  const move: LayoutMove =
    action.type === "nudgeWidget"
      ? { kind: "nudge", dx: action.dx, dy: action.dy }
      : action.type === "resizeWidgetBy"
        ? { kind: "resize", dw: action.dw, dh: action.dh }
        : { kind: "place", placement: action.placement };
  const result = moveInLayout(custom, widget.id, widget.type, format, move);
  if (!result.ok) {
    const { error } = result;
    switch (error.kind) {
      case "cannotMove":
        return announce(selected, t("announce.cannotMove", { name }));
      case "minimumSize": {
        const minimum = STUDIO_MIN_WIDGET_SIZE[widget.type];
        return announce(
          selected,
          t("announce.minimumSize", { name, w: minimum.w, h: minimum.h }),
        );
      }
      case "atEdge":
        return announce(selected, t("announce.atEdge", { name }));
      case "blocked": {
        const { blocker } = error;
        if (blocker.kind === "outside") {
          return announce(selected, t("announce.mustStay", { name }));
        }
        if (blocker.kind === "tooSmall") {
          return announce(
            selected,
            t("problems.tooSmall", {
              name,
              w: blocker.minimum.w,
              h: blocker.minimum.h,
            }),
          );
        }
        const other = error.otherId
          ? slide.widgets.find((entry) => entry.id === error.otherId)
          : undefined;
        return announce(
          selected,
          t("announce.wouldOverlap", {
            name,
            other: other ? widgetName(other, locale) : "",
          }),
        );
      }
      default:
        return selected;
    }
  }
  const placed = result.placement!;
  if (result.layout === custom) {
    return selected;
  }
  return announce(
    edit(
      selected,
      withSlideLayout(state.draft, slide.id, format, result.layout),
    ),
    placementText(widget, placed, locale, from),
  );
}

type LayoutAction = Extract<
  StudioAction,
  {
    type:
      | "customizeFormat"
      | "resetFormat"
      | "addLayoutPage"
      | "removeLayoutPage"
      | "moveWidgetToPage"
      | "setWidgetHidden"
      | "confirmPlacement";
  }
>;

/**
 * Customize and reset a format, its pages, hiding and the review flags:
 * each one undo step, announced; refused with the reason announced.
 */
function editLayout(state: StudioState, action: LayoutAction): StudioState {
  const { draft, locale } = state;
  const t = messages(locale);
  const primary = primaryOf(draft);
  const format = action.format;
  const ratio = ratioOf(format);
  if (format === primary) return state;
  const slideId =
    "slideId" in action
      ? action.slideId
      : findWidget(draft, action.widgetId)?.slide.id;
  const slide = draft.slides.find((entry) => entry.id === slideId);
  if (!slide) return state;
  if (action.type === "customizeFormat") {
    if (customLayoutOf(slide, primary, format)) return state;
    const custom = autoAsCustom(slide, primary, format);
    return announce(
      edit(state, withSlideLayout(draft, slide.id, format, custom)),
      t("announce.customized", { format: ratio, pages: custom.pages }),
    );
  }
  const custom = customLayoutOf(slide, primary, format);
  if (!custom) return state;
  if (action.type === "resetFormat") {
    return announce(
      edit(state, withSlideLayout(draft, slide.id, format, null)),
      t("announce.backToAuto", { format: ratio }),
    );
  }
  if (action.type === "confirmPlacement") {
    const next = confirmPlacements(custom, action.widgetId);
    const widget = action.widgetId
      ? slide.widgets.find((entry) => entry.id === action.widgetId)
      : undefined;
    return announce(
      edit(state, withSlideLayout(draft, slide.id, format, next)),
      widget
        ? t("announce.looksGood", {
            name: widgetName(widget, locale),
            format: ratio,
          })
        : t("announce.looksGoodAll", { format: ratio }),
    );
  }
  let result: LayoutEdit;
  let text: (placement: CustomLayout) => string;
  if (action.type === "addLayoutPage") {
    result = addPage(custom);
    text = (layout) =>
      t("announce.pageAdded", { page: layout.pages, format: ratio });
  } else if (action.type === "removeLayoutPage") {
    result = removePage(custom, action.page);
    text = () =>
      t("announce.pageRemoved", { page: action.page + 1, format: ratio });
  } else {
    const widget = slide.widgets.find((entry) => entry.id === action.widgetId);
    if (!widget) return state;
    const name = widgetName(widget, locale);
    if (action.type === "moveWidgetToPage") {
      result = moveToPage(custom, widget.id, widget.type, format, action.page);
      text = () => t("announce.movedToPage", { name, page: action.page + 1 });
    } else {
      result = setHidden(
        custom,
        widget.id,
        widget.type,
        format,
        action.hidden,
        action.page,
      );
      text = (layout) => {
        const placement = layout.placements.find(
          (entry) => entry.id === widget.id,
        );
        return action.hidden
          ? t("announce.hidden", { name, format: ratio })
          : t("announce.shown", {
              name,
              format: ratio,
              page: (placement?.page ?? 0) + 1,
            });
      };
    }
    if (!result.ok && result.error.kind === "noRoom") {
      return announce(state, t("announce.noRoomIn", { name, format: ratio }));
    }
  }
  if (!result.ok) {
    switch (result.error.kind) {
      case "pageLimit":
        return announce(
          state,
          t("announce.pageLimit", { max: CUSTOM_PAGES, format: ratio }),
        );
      case "lastPage":
        return announce(state, t("announce.lastPage"));
      case "pageNotEmpty":
        return announce(
          state,
          t("announce.pageNotEmpty", {
            page: action.type === "removeLayoutPage" ? action.page + 1 : 1,
          }),
        );
      default:
        return state;
    }
  }
  if (result.layout === custom) return state;
  const next = edit(
    state,
    withSlideLayout(draft, slide.id, format, result.layout),
  );
  return announce(
    "widgetId" in action
      ? { ...next, selectedWidgetId: action.widgetId }
      : next,
    text(result.layout),
  );
}

/** At most this many pages per custom layout (ADR 0017). */
const CUSTOM_PAGES = 8;
