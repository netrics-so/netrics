import type {
  CreateDashboardRequest,
  Dashboard,
  DashboardSettings,
  DashboardSlide,
  DashboardSlideInput,
  DashboardWidget,
  DashboardWidgetInput,
  ReplaceDashboardRequest,
} from "@netrics/contracts";
import {
  DEFAULT_THEME_KEY,
  SLIDE_SECONDS,
  STUDIO_GRID,
  STUDIO_LIMITS,
  STUDIO_MIN_WIDGET_SIZE,
  isBuiltinThemeKey,
  isDataWidgetType,
  isInsideGrid,
  meetsMinimumSize,
  placementsOverlap,
  type StudioPlacement,
  type WidgetType,
} from "@netrics/domain";

import {
  nudgePlacement,
  placementBlocker,
  resizePlacement,
  samePlacement,
} from "./studio-grid";
import { widgetInputProblem } from "./studio-inspector";
import { slideTitle } from "./studio-widgets";

// The Studio's draft of one dashboard (ADR 0015, section 9): the document
// as the user edits it, what is selected, and undo history. Everything here
// is pure, so the editor's behaviour is tested without a browser. The
// document is saved as a whole with an explicit Save (no autosave): screens
// show a dashboard as soon as it is saved.

/** A slide in the draft; its position is its index. */
export type StudioSlide = Omit<DashboardSlide, "position">;

/** What a Save sends: name, project, settings, slides and widgets. */
export interface StudioDocument {
  name: string;
  projectId: string | null;
  settings: DashboardSettings;
  slides: StudioSlide[];
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
  /** A finished drag on the canvas: one undo step, refused on overlap. */
  | { type: "placeWidget"; widgetId: string; placement: StudioPlacement }
  /** Arrow keys: one cell that way (over widgets in the way). */
  | { type: "nudgeWidget"; widgetId: string; dx: number; dy: number }
  /** Shift+Arrow keys: one cell wider, narrower, taller or shorter. */
  | { type: "resizeWidgetBy"; widgetId: string; dw: number; dh: number }
  /** Merges into the widget's type-specific options (#225). */
  | { type: "updateWidgetOptions"; widgetId: string; patch: object }
  /**
   * The widget becomes another type (#225): `widget` holds its new fields
   * (see convertWidget); id and position stay, and the size grows to the
   * new type's minimum where there is room.
   */
  | { type: "changeWidgetType"; widgetId: string; widget: NewWidget }
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
    slides: dashboard.slides.map(({ position: _position, ...slide }) => ({
      ...slide,
      widgets: slide.widgets.map((widget) => ({ ...widget })),
    })),
  };
}

export function initialStudioState(dashboard: Dashboard): StudioState {
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
  };
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
 * the slide has no room for it.
 */
export function findFreePlacement(
  widgets: readonly StudioPlacement[],
  type: WidgetType,
): StudioPlacement | null {
  for (const size of [
    DEFAULT_WIDGET_SIZE[type],
    STUDIO_MIN_WIDGET_SIZE[type],
  ]) {
    for (let y = 0; y + size.h <= STUDIO_GRID.rows; y++) {
      for (let x = 0; x + size.w <= STUDIO_GRID.columns; x++) {
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
): StudioPlacement | null {
  const minimum = STUDIO_MIN_WIDGET_SIZE[type];
  const w = Math.max(placement.w, minimum.w);
  const h = Math.max(placement.h, minimum.h);
  const candidate = {
    x: Math.max(0, Math.min(placement.x, STUDIO_GRID.columns - w)),
    y: Math.max(0, Math.min(placement.y, STUDIO_GRID.rows - h)),
    w,
    h,
  };
  if (
    w > STUDIO_GRID.columns ||
    h > STUDIO_GRID.rows ||
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
): string | null {
  if (slide.widgets.length >= STUDIO_LIMITS.widgetsPerSlide) {
    return `A slide holds at most ${STUDIO_LIMITS.widgetsPerSlide} widgets.`;
  }
  if (
    isDataWidgetType(type) &&
    dataWidgetCount(document) >= STUDIO_LIMITS.dataWidgets
  ) {
    return `A dashboard shows at most ${STUDIO_LIMITS.dataWidgets} data widgets.`;
  }
  if (!findFreePlacement(slide.widgets, type)) {
    return "There is no free space on this slide for it.";
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

const DURATION_HINT = `between ${SLIDE_SECONDS.min} and ${SLIDE_SECONDS.max} seconds`;

/**
 * What the server would refuse, found before saving: names, durations,
 * limits, and every widget outside the grid, below its minimum size or
 * overlapping another (the same rules as slideLayoutProblem).
 */
export function documentProblems(document: StudioDocument): StudioProblem[] {
  const problems: StudioProblem[] = [];
  const dashboard = (message: string) =>
    problems.push({ slideId: null, widgetId: null, message });
  if (document.name.trim() === "") {
    dashboard("The dashboard needs a name.");
  } else if (document.name.trim().length > 100) {
    dashboard("The dashboard name is longer than 100 characters.");
  }
  if (!durationOk(document.settings.defaultSlideSeconds)) {
    dashboard(`The default slide duration must be ${DURATION_HINT}.`);
  }
  if (document.slides.length > STUDIO_LIMITS.slides) {
    dashboard(`A dashboard holds at most ${STUDIO_LIMITS.slides} slides.`);
  }
  if (dataWidgetCount(document) > STUDIO_LIMITS.dataWidgets) {
    dashboard(
      `A dashboard shows at most ${STUDIO_LIMITS.dataWidgets} data widgets.`,
    );
  }
  document.slides.forEach((slide, index) => {
    const title = slideTitle(slide, index);
    const atSlide = (message: string, widgetId: string | null = null) =>
      problems.push({ slideId: slide.id, widgetId, message });
    if (
      slide.name !== null &&
      slide.name.trim().length > STUDIO_LIMITS.slideNameLength
    ) {
      atSlide(
        `${title}: the name is longer than ${STUDIO_LIMITS.slideNameLength} characters.`,
      );
    }
    if (slide.durationSeconds !== null && !durationOk(slide.durationSeconds)) {
      atSlide(`${title}: the duration must be ${DURATION_HINT}.`);
    }
    if (slide.widgets.length > STUDIO_LIMITS.widgetsPerSlide) {
      atSlide(
        `${title}: a slide holds at most ${STUDIO_LIMITS.widgetsPerSlide} widgets.`,
      );
    }
    slide.widgets.forEach((widget, widgetIndex) => {
      const at = (message: string) =>
        atSlide(`${title}: ${message}`, widget.id);
      const name = widgetName(widget);
      if (!isInsideGrid(widget)) {
        at(`${name} lies outside the grid.`);
      } else if (!meetsMinimumSize(widget.type, widget)) {
        const minimum = STUDIO_MIN_WIDGET_SIZE[widget.type];
        at(`${name} must be at least ${minimum.w} × ${minimum.h} cells.`);
      }
      const overlaps = slide.widgets.some(
        (other, otherIndex) =>
          otherIndex !== widgetIndex && placementsOverlap(widget, other),
      );
      if (overlaps) {
        at(`${name} overlaps another widget.`);
      }
      if (widget.title !== null && widget.title.trim() === "") {
        at(`${name} has an empty title.`);
      } else if (
        widget.title !== null &&
        widget.title.trim().length > STUDIO_LIMITS.widgetTitleLength
      ) {
        at(
          `${name}: the title is longer than ${STUDIO_LIMITS.widgetTitleLength} characters.`,
        );
      }
      if (widget.type === "text") {
        if (widget.text.trim() === "") {
          at("A text widget needs some text.");
        } else if (widget.text.length > STUDIO_LIMITS.textLength) {
          at(
            `A text widget holds at most ${STUDIO_LIMITS.textLength} characters.`,
          );
        }
      }
      // Anything else the API would refuse in the widget's own fields
      // (options per type), unless a clearer message above says it.
      if (!problems.some((problem) => problem.widgetId === widget.id)) {
        const invalid = widgetInputProblem(widget);
        if (invalid) {
          at(`${name}: ${invalid}`);
        }
      }
    });
  });
  return problems;
}

const TYPE_NAMES: Record<WidgetType, string> = {
  metric: "Metric",
  line: "Line chart",
  bar: "Bar chart",
  image: "Image",
  text: "Text",
  clock: "Clock",
};

/** "Downloads (metric)", "Text", … for announcements and problems. */
export function widgetName(widget: DashboardWidget): string {
  const type = TYPE_NAMES[widget.type] ?? "Widget";
  return widget.title ? `${widget.title} (${type.toLowerCase()})` : type;
}

export function widgetTypeName(type: WidgetType): string {
  return TYPE_NAMES[type];
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

function slideInputs(
  document: StudioDocument,
  keepIds: boolean,
): DashboardSlideInput[] {
  return document.slides.map((slide) => ({
    ...(keepIds ? { id: slide.id } : {}),
    name: slide.name?.trim() || null,
    durationSeconds: slide.durationSeconds,
    enabled: slide.enabled,
    background: slide.background,
    widgets: slide.widgets.map((widget) => {
      const input = widgetInput(widget);
      if (!keepIds) {
        delete input.id;
      }
      return input;
    }),
  }));
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

/** The PUT body for a Save: the whole document with its base version. */
export function toReplaceRequest(state: StudioState): ReplaceDashboardRequest {
  const { draft } = state;
  return {
    version: state.version,
    name: draft.name.trim(),
    projectId: draft.projectId,
    settings: settingsInput(draft.settings),
    slides: slideInputs(draft, true),
  } as ReplaceDashboardRequest;
}

/** The draft as a new dashboard ("Save as copy" after a conflict). */
export function toCopyRequest(
  document: StudioDocument,
  name: string,
): CreateDashboardRequest {
  return {
    name,
    projectId: document.projectId,
    settings: settingsInput(document.settings),
    slides: slideInputs(document, false),
  } as CreateDashboardRequest;
}

/** "Overview (copy)", kept within the 100-character name limit. */
export function copyName(name: string): string {
  const suffix = " (copy)";
  return `${name.trim().slice(0, 100 - suffix.length)}${suffix}`;
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
    const { draft } = state;
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
            `A dashboard holds at most ${STUDIO_LIMITS.slides} slides.`,
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
          `Slide ${at + 1} added.`,
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
            `A dashboard holds at most ${STUDIO_LIMITS.slides} slides.`,
          );
        }
        const copy: StudioSlide = {
          ...source,
          id: newId(),
          name: source.name
            ? `${source.name.slice(0, STUDIO_LIMITS.slideNameLength - 7)} (copy)`
            : null,
          widgets: source.widgets.map((widget) => ({
            ...widget,
            id: newId(),
          })),
        };
        const slides = [...draft.slides];
        slides.splice(index + 1, 0, copy);
        const next: StudioDocument = { ...draft, slides };
        if (dataWidgetCount(next) > STUDIO_LIMITS.dataWidgets) {
          return announce(
            state,
            `A dashboard shows at most ${STUDIO_LIMITS.dataWidgets} data widgets.`,
          );
        }
        return announce(
          {
            ...edit(state, next),
            selectedSlideId: copy.id,
            selectedWidgetId: null,
          },
          `${slideTitle(source, index)} duplicated as slide ${index + 2}.`,
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
          `${slideTitle(removed, index)} deleted.`,
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
        const label = slide!.name ? `“${slide!.name}”` : `Slide ${from + 1}`;
        return announce(
          { ...edit(state, { ...draft, slides }), selectedSlideId: slide!.id },
          `${label} moved to position ${to + 1} of ${slides.length}.`,
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
        const blocker = addWidgetBlocker(draft, slide, action.widget.type);
        if (blocker) {
          return announce(state, blocker);
        }
        const placement = findFreePlacement(slide.widgets, action.widget.type)!;
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
          `${widgetName(widget)} added at column ${placement.x + 1}, row ${placement.y + 1}.`,
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
              mapSlide(draft, slide.id, (s) => ({
                ...s,
                widgets: s.widgets.filter((w) => w.id !== action.widgetId),
              })),
            ),
            selectedWidgetId:
              state.selectedWidgetId === action.widgetId
                ? null
                : state.selectedWidgetId,
          },
          `${widgetName(widget)} deleted.`,
        );
      }
      case "placeWidget":
      case "nudgeWidget":
      case "resizeWidgetBy":
        return placeWidget(state, action);
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
            `A dashboard shows at most ${STUDIO_LIMITS.dataWidgets} data widgets.`,
          );
        }
        const placement = grownPlacement(
          current,
          to,
          slide.widgets.filter((w) => w.id !== current.id),
        );
        if (!placement) {
          const minimum = STUDIO_MIN_WIDGET_SIZE[to];
          return announce(
            state,
            `A ${widgetTypeName(to).toLowerCase()} needs at least ${minimum.w} × ${minimum.h} cells; there is no room for it here.`,
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
          `${widgetName(current)} is now a ${widgetTypeName(to).toLowerCase()}.`,
        );
      }
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
          "Undone.",
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
          "Redone.",
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
          "Changes discarded.",
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
          "Saved. Screens show the new version.",
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
          "Reloaded the saved version.",
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

function placementText(widget: DashboardWidget, to: StudioPlacement): string {
  const name = widgetName(widget);
  const at = `column ${to.x + 1}, row ${to.y + 1}`;
  const size = `${to.w} × ${to.h} cells`;
  const moved = widget.x !== to.x || widget.y !== to.y;
  const resized = widget.w !== to.w || widget.h !== to.h;
  if (moved && resized) {
    return `${name} resized to ${size} at ${at}.`;
  }
  return resized ? `${name} resized to ${size}.` : `${name} moved to ${at}.`;
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
  const name = widgetName(widget);
  const others = slide.widgets.filter((w) => w.id !== widget.id);
  let target: StudioPlacement | null;
  if (action.type === "nudgeWidget") {
    target = nudgePlacement(widget, action.dx, action.dy, others);
    if (!target) {
      return announce(selected, `${name} cannot move further that way.`);
    }
  } else if (action.type === "resizeWidgetBy") {
    target = resizePlacement(widget, action.dw, action.dh, widget.type);
    if (!target) {
      const minimum = STUDIO_MIN_WIDGET_SIZE[widget.type];
      const shrinking = action.dw < 0 || action.dh < 0;
      return announce(
        selected,
        shrinking
          ? `${name} is at its minimum size, ${minimum.w} × ${minimum.h} cells.`
          : `${name} is at the edge of the slide.`,
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
  const blocker = placementBlocker(target, widget.type, others);
  const sameSize = widget.w === target.w && widget.h === target.h;
  if (blocker && !(blocker.kind === "tooSmall" && sameSize)) {
    switch (blocker.kind) {
      case "outside":
        return announce(selected, `${name} must stay on the slide.`);
      case "tooSmall":
        return announce(
          selected,
          `${name} must be at least ${blocker.minimum.w} × ${blocker.minimum.h} cells.`,
        );
      case "overlap":
        return announce(
          selected,
          `${name} would overlap ${widgetName(others[blocker.index]!)}; it stays where it was.`,
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
    placementText(widget, placed),
  );
}
