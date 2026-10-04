"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useState,
} from "react";

import type {
  Dashboard,
  Device,
  ImageContentType,
  WorkspaceImage,
  WorkspaceMetric,
} from "@netrics/contracts";
import { isDataWidgetType, type ScreenFormat } from "@netrics/domain";

import {
  ApiError,
  apiErrorMessage,
  createDashboard,
  deleteImage,
  loadDashboard,
  saveDashboard,
  uploadImage,
} from "@/lib/api";
import {
  copyName,
  createStudioReducer,
  documentProblems,
  initialStudioState,
  isDirty,
  primaryOf,
  selectedSlide,
  selectedWidget,
  toCopyRequest,
  toReplaceRequest,
} from "@/lib/studio-document";
import { dataWidgetLabel } from "@/components/studio/metric-widget";
import type { SlideLayouts } from "@/lib/screen-view";
import { rebaseBlockers } from "@/lib/studio-layouts";
import {
  deviceOf,
  draftFormatWarnings,
  formatViewReducer,
  initialFormatView,
  isEditableTarget,
  screensByTarget,
  targetStatuses,
  type PreviewDeviceId,
  type PreviewTarget,
} from "@/lib/studio-formats";
import { resolveDashboardTheme } from "@/lib/studio-theme";
import {
  metricKeyOf,
  referencedImageIds,
  toStudioImage,
  type DataWidget,
  type StudioConnection,
  type StudioEnv,
} from "@/lib/studio-widgets";

import { AddWidgetMenu } from "./add-widget-menu";
import { AssignTvs } from "./assign-tvs";
import { CustomFormatEditor, MakePrimaryButton } from "./custom-format";
import {
  WidgetClipboardBar,
  useUnreadableLabels,
  useWidgetClipboard,
} from "./canvas-extras";
import { EditorCanvas, type CanvasOutline } from "./editor-canvas";
import { FormatAttention, formatRatio } from "./format-attention";
import {
  FormatOverview,
  FormatPreview,
  draftSlidePages,
  type PreviewContext,
} from "./format-preview";
import { FormatSwitcher, useTargetName } from "./format-switcher";
import { useResourceIcons, type PickableImage } from "./image-picker";
import {
  DashboardSettingsPanel,
  WidgetPanel,
  type StudioThemes,
} from "./inspector";
import { PlayMode } from "./play-mode";
import { SlideRail } from "./slide-rail";
import { useLeaveGuard } from "./use-leave-guard";
import type { StudioCurrency } from "./widget-panel";
import { useLocale, useT } from "@/lib/i18n/client";
import { builtinThemeName } from "@/lib/theme-name";

const reducer = createStudioReducer(() => crypto.randomUUID());

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/**
 * The Studio (ADR 0015, section 9; #223): slide rail, canvas and inspector
 * around one draft of the dashboard. Nothing reaches the TVs until Save,
 * which sends the whole document with its version; a conflict offers the
 * saved version or a copy. The canvas (#224) and the widget inspector
 * (#225) plug into this shell through the same reducer.
 */
export function StudioEditor({
  workspaceId,
  dashboard,
  timeZone,
  metrics,
  connections,
  themes,
  images: initialImages,
  projects,
  devices: initialDevices,
  dashboardNames,
  currency,
}: {
  workspaceId: string;
  dashboard: Dashboard;
  timeZone: string;
  metrics: WorkspaceMetric[];
  connections: Record<string, StudioConnection>;
  themes: StudioThemes;
  images: WorkspaceImage[];
  projects: Array<{ id: string; name: string }>;
  /** Active TVs, or null when the role cannot assign them. */
  devices: Device[] | null;
  /** Every dashboard of the workspace by id (what TVs show now). */
  dashboardNames: Record<string, string>;
  /** Display currency and convertible currencies for amounts (#191). */
  currency?: StudioCurrency;
}) {
  const locale = useLocale();
  const t = useT("studio.editor");
  const formatsT = useT("studio.formats");
  const targetName = useTargetName();
  const common = useT("common");
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, dashboard, (initial) =>
    initialStudioState(initial, locale),
  );
  // Readability per format of the saved version (ADR 0017 §6, #280).
  const [savedSlides, setSavedSlides] = useState(dashboard.slides);
  // The format widgets are placed in; a save can re-base it (#284).
  const primaryFormat = primaryOf(state.draft);
  // The format switcher (ADR 0017 section 10, #283): the primary format
  // and formats the slide is arranged by hand in are edited (#284); the
  // others are device-frame previews.
  const [formatView, formatDispatch] = useReducer(
    formatViewReducer,
    primaryFormat,
    initialFormatView,
  );
  const stagePanelId = useId();
  const [images, setImages] = useState(initialImages);
  const [devices, setDevices] = useState(initialDevices);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const stopPlaying = useCallback(() => setPlaying(false), []);
  /** A new widget dragged from the add menu over the canvas (#241). */
  const [incoming, setIncoming] = useState<CanvasOutline | null>(null);

  const dirty = isDirty(state);
  useLeaveGuard(dirty);

  const { draft } = state;
  const slide = selectedSlide(state);
  const slideId = slide?.id;
  // Another slide starts on its first page.
  useEffect(() => {
    formatDispatch({ type: "slideChanged" });
  }, [slideId]);
  const widget = selectedWidget(state);
  const problems = useMemo(
    () => documentProblems(draft, locale),
    [draft, locale],
  );
  const slidesWithProblems = useMemo(
    () => new Set(problems.flatMap((p) => (p.slideId ? [p.slideId] : []))),
    [problems],
  );
  const widgetsWithProblems = useMemo(
    () => new Set(problems.flatMap((p) => (p.widgetId ? [p.widgetId] : []))),
    [problems],
  );

  const customTheme = draft.settings.themeId
    ? (themes.custom.find((theme) => theme.id === draft.settings.themeId) ??
      null)
    : null;
  const theme = resolveDashboardTheme(draft.settings, customTheme);
  const baseTheme = resolveDashboardTheme(
    { ...draft.settings, accentColor: null },
    customTheme,
  );

  const studioImages = useMemo(
    () =>
      new Map(
        images.map((image) => [image.id, toStudioImage(workspaceId, image)]),
      ),
    [images, workspaceId],
  );
  const pickable: PickableImage[] = useMemo(
    () =>
      images.map((image) => ({
        ...studioImages.get(image.id)!,
        name: image.name,
      })),
    [images, studioImages],
  );
  const metricsById = useMemo(
    () =>
      new Map(
        metrics.map((metric) => [
          `${metric.connectionId}|${metric.key}`,
          metric,
        ]),
      ),
    [metrics],
  );
  const unreadable = useUnreadableLabels(
    draft,
    metricsById,
    theme.tokens.fontScale,
  );
  const editing =
    !formatView.overview &&
    isEditableTarget(formatView.target, primaryFormat, slide);
  /** A format other than the primary, arranged by hand for this slide. */
  const customFormat: ScreenFormat | null =
    editing &&
    formatView.target !== primaryFormat &&
    formatView.target !== "scroll"
      ? formatView.target
      : null;
  // Copy, paste and duplicate add widgets: in the primary format only.
  const widgetClipboard = useWidgetClipboard(
    widget,
    dispatch,
    !playing && editing && customFormat === null,
  );
  const env: StudioEnv = useMemo(
    () => ({
      workspaceId,
      timeZone,
      fontScale: theme.tokens.fontScale,
      showHeader: draft.settings.showHeader,
      metrics: metricsById,
      connections,
      images: studioImages,
    }),
    [
      workspaceId,
      timeZone,
      theme.tokens.fontScale,
      draft.settings.showHeader,
      metricsById,
      connections,
      studioImages,
    ],
  );
  // The draft's custom layouts (ADR 0017 section 4, #284): Play, the
  // previews and the warnings complete them against the draft's widgets.
  const draftLayouts: ReadonlyMap<string, SlideLayouts> = useMemo(
    () => new Map(draft.slides.map((entry) => [entry.id, entry.layouts ?? []])),
    [draft.slides],
  );

  // Readability per format of the draft (ADR 0017 section 6), as the
  // server computes it on save, so the switcher shows unsaved changes.
  const logoImage = draft.settings.logoImageId
    ? studioImages.get(draft.settings.logoImageId)
    : undefined;
  const draftWarnings = useMemo(() => {
    const context = {
      primaryFormat,
      fontScale: theme.tokens.fontScale,
      showHeader: draft.settings.showHeader,
      dashboardName: draft.name.trim(),
      logoAspect:
        logoImage && logoImage.width > 0 && logoImage.height > 0
          ? logoImage.width / logoImage.height
          : null,
      labelOf: (entry: DataWidget | { type: string }) =>
        isDataWidgetType(entry.type)
          ? dataWidgetLabel(
              entry as DataWidget,
              metricsById.get(metricKeyOf(entry as DataWidget)),
            )
          : null,
    };
    return new Map(
      draft.slides.map((entry) => [
        entry.id,
        draftFormatWarnings(
          { ...entry, layouts: draftLayouts.get(entry.id) ?? null },
          context,
        ),
      ]),
    );
  }, [
    draft,
    primaryFormat,
    theme.tokens.fontScale,
    logoImage,
    metricsById,
    draftLayouts,
  ]);
  const previewContext: PreviewContext = useMemo(
    () => ({
      document: draft,
      primaryFormat,
      layouts: draftLayouts,
      tokens: theme.tokens,
      env,
    }),
    [draft, primaryFormat, draftLayouts, theme.tokens, env],
  );

  const onUploadImage = useCallback(
    async (file: File): Promise<string | null> => {
      try {
        const { image } = await uploadImage(workspaceId, {
          name: file.name,
          type: file.type as ImageContentType,
          body: file,
        });
        setImages((current) => [image, ...current]);
        dispatch({
          type: "announce",
          text: t("imageUploaded", { name: image.name }),
        });
        return image.id;
      } catch (cause) {
        setError(apiErrorMessage(cause, locale));
        return null;
      }
    },
    [workspaceId, locale, t],
  );

  // "Use app icon" in the pickers (#226): an icon the server stored joins
  // the editor's images like an upload.
  const onIconImage = useCallback(
    (image: WorkspaceImage) => {
      setImages((current) => [
        image,
        ...current.filter((entry) => entry.id !== image.id),
      ]);
      dispatch({
        type: "announce",
        text: t("iconAdded", { name: image.name }),
      });
    },
    [t],
  );
  useResourceIcons(workspaceId, onIconImage);

  const imagesInUse = useMemo(
    () => new Set(referencedImageIds(draft)),
    [draft],
  );
  const onDeleteImage = useCallback(
    async (imageId: string): Promise<string | null> => {
      try {
        await deleteImage(workspaceId, imageId);
        setImages((current) => current.filter((image) => image.id !== imageId));
        dispatch({ type: "announce", text: t("imageDeleted") });
        return null;
      } catch (cause) {
        return apiErrorMessage(cause, locale);
      }
    },
    [workspaceId, locale, t],
  );

  /**
   * Saves the draft; with `rebaseTo`, also makes that format the primary
   * (ADR 0017 section 4), which the server refuses with 409
   * format_has_overflow or format_has_hidden_widgets.
   */
  const save = useCallback(
    async (rebaseTo?: ScreenFormat) => {
      if (saving) return;
      if (problems.length > 0) {
        setShowProblems(true);
        setError(t("fixProblems"));
        return;
      }
      setSaving(true);
      setError(null);
      setConflict(false);
      try {
        const { dashboard: saved } = await saveDashboard(
          workspaceId,
          state.dashboardId,
          toReplaceRequest(state, rebaseTo ? { primaryFormat: rebaseTo } : {}),
        );
        dispatch({ type: "saved", dashboard: saved });
        setSavedSlides(saved.slides);
        setShowProblems(false);
        if (rebaseTo && saved.primaryFormat === rebaseTo) {
          dispatch({
            type: "announce",
            text: formatsT("primaryChanged", { ratio: formatRatio(rebaseTo) }),
          });
        }
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === "version_conflict") {
          setConflict(true);
        } else {
          setError(apiErrorMessage(cause, locale));
        }
      } finally {
        setSaving(false);
      }
    },
    [saving, problems, workspaceId, state, locale, t, formatsT],
  );

  async function reloadSaved() {
    setSaving(true);
    try {
      const { dashboard: current } = await loadDashboard(
        workspaceId,
        state.dashboardId,
      );
      dispatch({ type: "reload", dashboard: current });
      setSavedSlides(current.slides);
      setConflict(false);
      setError(null);
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setSaving(false);
    }
  }

  async function saveAsCopy() {
    setSaving(true);
    try {
      const { dashboard: copy } = await createDashboard(
        workspaceId,
        toCopyRequest(draft, copyName(draft.name, locale)),
      );
      router.push(`/workspaces/${workspaceId}/dashboards/${copy.id}/studio`);
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setSaving(false);
    }
  }

  // Keyboard: Ctrl/Cmd+S saves; Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z undo and
  // redo outside text fields (which keep their own undo).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (playing || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void save();
      } else if (key === "z" && !isTyping(event.target)) {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
      } else if (key === "y" && !isTyping(event.target)) {
        event.preventDefault();
        dispatch({ type: "redo" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [playing, save]);

  const dashboardHref = `/workspaces/${workspaceId}/dashboards/${state.dashboardId}`;
  const dashboardProblems = problems.filter((p) => p.slideId === null);
  const widgetProblems = widget
    ? problems.filter((p) => p.widgetId === widget.id)
    : [];
  const activeDevices = devices?.filter((device) => !device.revokedAt) ?? null;
  const assignedCount =
    activeDevices?.filter((device) => device.dashboardId === state.dashboardId)
      .length ?? 0;
  const blockers = useMemo(
    () =>
      formatView.target === "scroll" || formatView.overview
        ? []
        : rebaseBlockers(draft.slides, primaryFormat, formatView.target),
    [draft.slides, primaryFormat, formatView.target, formatView.overview],
  );
  const makePrimary =
    formatView.target === "scroll" ||
    formatView.target === primaryFormat ? null : (
      <MakePrimaryButton
        key={formatView.target}
        format={formatView.target}
        primaryFormat={primaryFormat}
        document={draft}
        blockers={blockers}
        disabled={saving}
        onMake={() => void save(formatView.target as ScreenFormat)}
      />
    );
  const statuses = targetStatuses({
    primaryFormat,
    slides: draft.slides.map((entry) => ({
      layouts: draftLayouts.get(entry.id) ?? null,
    })),
    warnings: [...draftWarnings.values()].flat(),
    screens: screensByTarget(activeDevices),
  });
  const currentStatus =
    statuses.find((status) => status.target === formatView.target) ??
    statuses[0]!;

  function announceTarget(target: PreviewTarget, page = 0) {
    const { name, ratio } = targetName(target);
    if (target === "scroll") {
      const device = deviceOf(formatView, target);
      dispatch({
        type: "announce",
        text: formatsT("announceScroll", {
          device: formatsT(`device.${device.id}`),
        }),
      });
      return;
    }
    const pages = slide
      ? draftSlidePages(previewContext, slide.id, target).length
      : 1;
    dispatch({
      type: "announce",
      text: formatsT("announce", { name, ratio, page: page + 1, pages }),
    });
  }

  function selectTarget(target: PreviewTarget) {
    formatDispatch({ type: "select", target });
    announceTarget(target);
  }

  function showWarning(slideId: string, widgetId: string | null) {
    formatDispatch({ type: "select", target: primaryFormat });
    dispatch({ type: "selectSlide", slideId });
    dispatch({ type: "selectWidget", widgetId });
  }

  return (
    <div className="studio">
      <div className="studio-toolbar">
        <div className="studio-title">
          <Link href={dashboardHref} className="muted">
            ← {t("backToDashboard")}
          </Link>
          <h1>{draft.name.trim() || t("untitled")}</h1>
          <span
            className={
              dirty ? "studio-state studio-state--dirty" : "studio-state"
            }
          >
            {saving ? common("saving") : dirty ? t("unsaved") : t("saved")}
          </span>
          {dirty ? null : <FormatAttention slides={savedSlides} />}
        </div>
        <div className="actions studio-actions">
          <button
            type="button"
            onClick={() => dispatch({ type: "undo" })}
            disabled={state.past.length === 0}
            aria-keyshortcuts="Control+Z Meta+Z"
          >
            {t("undo")}
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "redo" })}
            disabled={state.future.length === 0}
            aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
          >
            {t("redo")}
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(t("discardConfirm"))) {
                dispatch({ type: "discard" });
                setError(null);
                setShowProblems(false);
              }
            }}
            disabled={!dirty || saving}
          >
            {t("discard")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void save()}
            disabled={!dirty || saving}
            aria-keyshortcuts="Control+S Meta+S"
          >
            {saving ? common("saving") : common("save")}
          </button>
          <button type="button" onClick={() => setPlaying(true)}>
            ▶ {t("play")}
          </button>
          {activeDevices ? (
            <button type="button" onClick={() => setAssigning(true)}>
              {assignedCount > 0
                ? t("showOnTvsCount", { count: assignedCount })
                : t("showOnTvs")}
            </button>
          ) : null}
        </div>
      </div>

      {conflict ? (
        <div className="error studio-banner" role="alert">
          <p>{t("conflict")}</p>
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                if (!dirty || window.confirm(t("loadTheirsConfirm"))) {
                  void reloadSaved();
                }
              }}
              disabled={saving}
            >
              {t("loadTheirs")}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void saveAsCopy()}
              disabled={saving}
            >
              {t("saveCopy")}
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="error studio-banner" role="alert">
          <p>{error}</p>
          {showProblems && problems.length > 0 ? (
            <ul>
              {problems.map((problem, index) => (
                <li key={index}>
                  {problem.slideId ? (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        dispatch({
                          type: "selectSlide",
                          slideId: problem.slideId!,
                        });
                        if (problem.widgetId) {
                          dispatch({
                            type: "selectWidget",
                            widgetId: problem.widgetId,
                          });
                        }
                      }}
                    >
                      {problem.message}
                    </button>
                  ) : (
                    problem.message
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="studio-body" inert={saving}>
        <SlideRail
          slides={draft.slides}
          primaryFormat={primaryFormat}
          selectedSlideId={slide?.id ?? ""}
          tokens={theme.tokens}
          defaultSeconds={draft.settings.defaultSlideSeconds}
          slidesWithProblems={slidesWithProblems}
          unreadableCounts={unreadable.perSlide}
          images={pickable}
          dispatch={dispatch}
          onUploadImage={onUploadImage}
        />
        <section className="studio-stage" aria-label={t("stage")}>
          {slide ? (
            <>
              <FormatSwitcher
                statuses={statuses}
                selected={formatView.target}
                overview={formatView.overview}
                panelId={stagePanelId}
                onSelect={selectTarget}
                onOverview={(on) => {
                  formatDispatch({ type: "overview", on });
                  if (on) {
                    dispatch({
                      type: "announce",
                      text: formatsT("announceOverview"),
                    });
                  } else {
                    announceTarget(formatView.target);
                  }
                }}
              />
              {formatView.overview ? (
                <FormatOverview
                  context={previewContext}
                  view={formatView}
                  statuses={statuses}
                  slideId={slide.id}
                  panelId={stagePanelId}
                  onOpen={selectTarget}
                />
              ) : customFormat ? (
                <CustomFormatEditor
                  slide={slide}
                  format={customFormat}
                  primaryFormat={primaryFormat}
                  page={formatView.page}
                  document={draft}
                  settings={draft.settings}
                  tokens={theme.tokens}
                  env={env}
                  selectedWidgetId={state.selectedWidgetId}
                  widgetsWithProblems={widgetsWithProblems}
                  warnings={draftWarnings}
                  panelId={stagePanelId}
                  dispatch={dispatch}
                  onPage={(page) => {
                    formatDispatch({ type: "page", page });
                    announceTarget(formatView.target, page);
                  }}
                  makePrimary={makePrimary}
                />
              ) : editing ? (
                <div
                  id={stagePanelId}
                  role="tabpanel"
                  aria-labelledby={`${stagePanelId}-tab-${formatView.target}`}
                  className="format-editor"
                >
                  <div className="stage-toolbar">
                    <AddWidgetMenu
                      document={draft}
                      slide={slide}
                      metrics={metrics}
                      imageIds={images.map((image) => image.id)}
                      dispatch={dispatch}
                      showHeader={draft.settings.showHeader}
                      primaryFormat={primaryFormat}
                      onDragNew={setIncoming}
                    />
                    <WidgetClipboardBar
                      selected={widget}
                      clipboard={widgetClipboard.clipboard}
                      onCopy={widgetClipboard.copy}
                      onPaste={widgetClipboard.paste}
                      onDuplicate={widgetClipboard.duplicate}
                    />
                  </div>
                  <EditorCanvas
                    slide={slide}
                    dashboardName={draft.name}
                    settings={draft.settings}
                    tokens={theme.tokens}
                    env={env}
                    selectedWidgetId={state.selectedWidgetId}
                    widgetsWithProblems={widgetsWithProblems}
                    dispatch={dispatch}
                    unreadable={unreadable.byWidget}
                    incoming={incoming}
                    primaryFormat={primaryFormat}
                    format={primaryFormat}
                  />
                  <p className="help">
                    {t("canvasHelp", {
                      theme: theme.builtin
                        ? builtinThemeName(theme.builtin, locale)
                        : theme.name,
                    })}
                  </p>
                </div>
              ) : (
                <FormatPreview
                  context={previewContext}
                  view={formatView}
                  status={currentStatus}
                  slideId={slide.id}
                  warnings={draftWarnings}
                  panelId={stagePanelId}
                  onDevice={(device: PreviewDeviceId) => {
                    formatDispatch({ type: "device", device });
                    if (formatView.target === "scroll") {
                      dispatch({
                        type: "announce",
                        text: formatsT("announceScroll", {
                          device: formatsT(`device.${device}`),
                        }),
                      });
                    }
                  }}
                  onPage={(page) => {
                    formatDispatch({ type: "page", page });
                    announceTarget(formatView.target, page);
                  }}
                  onShowWarning={showWarning}
                  actions={
                    formatView.target === "scroll" ? null : (
                      <>
                        <button
                          type="button"
                          title={formatsT("customizeHelp", {
                            ratio: formatRatio(formatView.target),
                            primary: formatRatio(primaryFormat),
                          })}
                          onClick={() => {
                            dispatch({
                              type: "customizeFormat",
                              slideId: slide.id,
                              format: formatView.target as ScreenFormat,
                            });
                            formatDispatch({ type: "page", page: 0 });
                          }}
                        >
                          {formatsT("customize")}
                        </button>
                        {makePrimary}
                      </>
                    )
                  }
                />
              )}
            </>
          ) : null}
        </section>
        <aside className="studio-inspector" aria-label={t("inspector")}>
          {widget && customFormat ? (
            <p className="help format-scope-note">
              {formatsT("contentEverywhere", {
                ratio: formatRatio(customFormat),
              })}
            </p>
          ) : null}
          {widget ? (
            <WidgetPanel
              widget={widget}
              workspaceId={workspaceId}
              metrics={metrics}
              images={pickable}
              imagesInUse={imagesInUse}
              problems={widgetProblems}
              timeZone={timeZone}
              fontScale={theme.tokens.fontScale}
              currency={currency}
              dispatch={dispatch}
              onUploadImage={onUploadImage}
              onDeleteImage={onDeleteImage}
            />
          ) : (
            <DashboardSettingsPanel
              document={draft}
              themes={themes}
              baseTokens={baseTheme.tokens}
              projects={projects}
              images={pickable}
              problems={dashboardProblems}
              themesHref={`/workspaces/${workspaceId}/settings/themes`}
              dispatch={dispatch}
              onUploadImage={onUploadImage}
            />
          )}
        </aside>
      </div>

      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {state.announcement ? (
          <span key={state.announcement.id}>{state.announcement.text}</span>
        ) : null}
      </div>

      {playing && slide ? (
        <PlayMode
          document={draft}
          tokens={theme.tokens}
          env={env}
          primaryFormat={primaryFormat}
          layouts={draftLayouts}
          startSlideId={slide.id}
          onClose={stopPlaying}
        />
      ) : null}
      {activeDevices ? (
        <AssignTvs
          open={assigning}
          workspaceId={workspaceId}
          dashboardId={state.dashboardId}
          dashboardName={state.saved.name}
          devices={activeDevices}
          dashboardNames={new Map(Object.entries(dashboardNames))}
          unsaved={dirty}
          onClose={() => setAssigning(false)}
          onAssigned={(updated) =>
            setDevices((current) =>
              (current ?? []).map(
                (device) =>
                  updated.find((other) => other.id === device.id) ?? device,
              ),
            )
          }
        />
      ) : null}
    </div>
  );
}
