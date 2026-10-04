"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";

import type {
  Dashboard,
  Device,
  ImageContentType,
  WorkspaceImage,
  WorkspaceMetric,
} from "@netrics/contracts";

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
  selectedSlide,
  selectedWidget,
  toCopyRequest,
  toReplaceRequest,
} from "@/lib/studio-document";
import { resolveDashboardTheme } from "@/lib/studio-theme";
import {
  referencedImageIds,
  toStudioImage,
  type StudioConnection,
  type StudioEnv,
} from "@/lib/studio-widgets";

import { AddWidgetMenu } from "./add-widget-menu";
import { AssignTvs } from "./assign-tvs";
import {
  WidgetClipboardBar,
  useUnreadableLabels,
  useWidgetClipboard,
} from "./canvas-extras";
import { EditorCanvas, type CanvasOutline } from "./editor-canvas";
import type { PickableImage } from "./image-picker";
import {
  DashboardSettingsPanel,
  WidgetPanel,
  type StudioThemes,
} from "./inspector";
import { PlayMode } from "./play-mode";
import { SlideRail } from "./slide-rail";
import { useLeaveGuard } from "./use-leave-guard";
import type { StudioCurrency } from "./widget-panel";

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
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, dashboard, initialStudioState);
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
  const widget = selectedWidget(state);
  const problems = useMemo(() => documentProblems(draft), [draft]);
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
  const widgetClipboard = useWidgetClipboard(widget, dispatch, !playing);
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

  const onUploadImage = useCallback(
    async (file: File): Promise<string | null> => {
      try {
        const { image } = await uploadImage(workspaceId, {
          name: file.name,
          type: file.type as ImageContentType,
          body: file,
        });
        setImages((current) => [image, ...current]);
        dispatch({ type: "announce", text: `Image “${image.name}” uploaded.` });
        return image.id;
      } catch (cause) {
        setError(apiErrorMessage(cause));
        return null;
      }
    },
    [workspaceId],
  );

  const imagesInUse = useMemo(
    () => new Set(referencedImageIds(draft)),
    [draft],
  );
  const onDeleteImage = useCallback(
    async (imageId: string): Promise<string | null> => {
      try {
        await deleteImage(workspaceId, imageId);
        setImages((current) => current.filter((image) => image.id !== imageId));
        dispatch({ type: "announce", text: "Image deleted." });
        return null;
      } catch (cause) {
        return apiErrorMessage(cause);
      }
    },
    [workspaceId],
  );

  const save = useCallback(async () => {
    if (saving) return;
    if (problems.length > 0) {
      setShowProblems(true);
      setError(
        "Fix the problems marked on the slides before saving. Nothing was saved.",
      );
      return;
    }
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const { dashboard: saved } = await saveDashboard(
        workspaceId,
        state.dashboardId,
        toReplaceRequest(state),
      );
      dispatch({ type: "saved", dashboard: saved });
      setShowProblems(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "version_conflict") {
        setConflict(true);
      } else {
        setError(apiErrorMessage(cause));
      }
    } finally {
      setSaving(false);
    }
  }, [saving, problems, workspaceId, state]);

  async function reloadSaved() {
    setSaving(true);
    try {
      const { dashboard: current } = await loadDashboard(
        workspaceId,
        state.dashboardId,
      );
      dispatch({ type: "reload", dashboard: current });
      setConflict(false);
      setError(null);
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function saveAsCopy() {
    setSaving(true);
    try {
      const { dashboard: copy } = await createDashboard(
        workspaceId,
        toCopyRequest(draft, copyName(draft.name)),
      );
      router.push(`/workspaces/${workspaceId}/dashboards/${copy.id}/studio`);
    } catch (cause) {
      setError(apiErrorMessage(cause));
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

  return (
    <div className="studio">
      <div className="studio-toolbar">
        <div className="studio-title">
          <Link href={dashboardHref} className="muted">
            ← Dashboard
          </Link>
          <h1>{draft.name.trim() || "Untitled"}</h1>
          <span
            className={
              dirty ? "studio-state studio-state--dirty" : "studio-state"
            }
          >
            {saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}
          </span>
        </div>
        <div className="actions studio-actions">
          <button
            type="button"
            onClick={() => dispatch({ type: "undo" })}
            disabled={state.past.length === 0}
            aria-keyshortcuts="Control+Z Meta+Z"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "redo" })}
            disabled={state.future.length === 0}
            aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
          >
            Redo
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Discard all unsaved changes?")) {
                dispatch({ type: "discard" });
                setError(null);
                setShowProblems(false);
              }
            }}
            disabled={!dirty || saving}
          >
            Discard
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void save()}
            disabled={!dirty || saving}
            aria-keyshortcuts="Control+S Meta+S"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => setPlaying(true)}>
            ▶ Play
          </button>
          {activeDevices ? (
            <button type="button" onClick={() => setAssigning(true)}>
              Show on TVs{assignedCount > 0 ? ` (${assignedCount})` : ""}
            </button>
          ) : null}
        </div>
      </div>

      {conflict ? (
        <div className="error studio-banner" role="alert">
          <p>
            Someone else saved this dashboard while you were editing. Your
            changes are not saved.
          </p>
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                if (
                  !dirty ||
                  window.confirm(
                    "Load the saved version? Your unsaved changes are lost.",
                  )
                ) {
                  void reloadSaved();
                }
              }}
              disabled={saving}
            >
              Load their version
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void saveAsCopy()}
              disabled={saving}
            >
              Save mine as a copy
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
          selectedSlideId={slide?.id ?? ""}
          tokens={theme.tokens}
          defaultSeconds={draft.settings.defaultSlideSeconds}
          slidesWithProblems={slidesWithProblems}
          unreadableCounts={unreadable.perSlide}
          images={pickable}
          dispatch={dispatch}
          onUploadImage={onUploadImage}
        />
        <section className="studio-stage" aria-label="Slide">
          {slide ? (
            <>
              <div className="stage-toolbar">
                <AddWidgetMenu
                  document={draft}
                  slide={slide}
                  metrics={metrics}
                  imageIds={images.map((image) => image.id)}
                  dispatch={dispatch}
                  showHeader={draft.settings.showHeader}
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
              />
              <p className="help">
                {theme.name} theme. Click a widget to edit it, drag it to move
                it and its edges to resize it (arrow keys and Shift+arrow keys
                do the same); click the slide&apos;s background for the
                dashboard settings.
              </p>
            </>
          ) : null}
        </section>
        <aside className="studio-inspector" aria-label="Inspector">
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
