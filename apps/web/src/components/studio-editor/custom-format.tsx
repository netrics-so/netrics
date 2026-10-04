"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { DashboardSettings } from "@netrics/contracts";
import type {
  FormatWarningItem,
  ScreenFormat,
  ThemeTokens,
} from "@netrics/domain";

import { useLocale, useT } from "@/lib/i18n/client";
import { pageLabel } from "@/lib/screen-view";
import {
  widgetName,
  type StudioAction,
  type StudioDocument,
  type StudioSlide,
} from "@/lib/studio-document";
import { tabKeyTarget } from "@/lib/studio-formats";
import {
  customLayoutOf,
  hiddenPlacements,
  pagePlacements,
  reviewPlacements,
  setHidden,
  type RebaseBlocker,
} from "@/lib/studio-layouts";
import type { UnreadableLabel } from "@/lib/studio-readability";
import { slideTitle, type StudioEnv } from "@/lib/studio-widgets";

import { EditorCanvas, type CanvasOutline } from "./editor-canvas";
import { formatRatio } from "./format-attention";
import { FormatWarningsList } from "./format-preview";
import { useTargetName } from "./format-switcher";

// Editing a slide in a format other than the primary (ADR 0017 section 4,
// #284): the canvas on that format's grid, one page at a time, with pages,
// hiding and the review flags of widgets the sync rules placed. Widget
// content stays shared: the inspector edits the widget in every format.

/**
 * "Make 9:16 the primary format" (ADR 0017 section 4): asks first, and
 * says why not while a slide continues on more pages or hides widgets in
 * that format (the server refuses those too).
 */
export function MakePrimaryButton({
  format,
  primaryFormat,
  document,
  blockers,
  disabled,
  onMake,
}: {
  format: ScreenFormat;
  primaryFormat: ScreenFormat;
  document: StudioDocument;
  blockers: ReadonlyArray<{ slideId: string; reason: RebaseBlocker }>;
  disabled: boolean;
  onMake: () => void;
}) {
  const t = useT("studio.formats");
  const locale = useLocale();
  const nameOf = useTargetName();
  const [explain, setExplain] = useState(false);
  const { name, ratio } = nameOf(format);
  const primary = formatRatio(primaryFormat);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={blockers.length > 0 ? explain : undefined}
        onClick={() => {
          if (blockers.length > 0) {
            setExplain(true);
            return;
          }
          if (
            window.confirm(t("makePrimaryConfirm", { name, ratio, primary }))
          ) {
            onMake();
          }
        }}
      >
        {t("makePrimary", { ratio })}
      </button>
      {explain && blockers.length > 0 ? (
        <div className="format-blocked" role="status">
          <p>{t("makePrimaryBlocked", { ratio })}</p>
          <ul>
            {blockers.map((blocker) => {
              const index = document.slides.findIndex(
                (slide) => slide.id === blocker.slideId,
              );
              const slide = document.slides[index];
              const title = slide ? slideTitle(slide, index, locale) : "";
              return (
                <li key={blocker.slideId}>
                  {blocker.reason === "overflow"
                    ? t("blockedOverflow", { slide: title })
                    : t("blockedHidden", { slide: title })}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </>
  );
}

/** The custom layout editor of one slide in one format. */
export function CustomFormatEditor({
  slide,
  format,
  primaryFormat,
  page: requestedPage,
  document,
  settings,
  tokens,
  env,
  selectedWidgetId,
  widgetsWithProblems,
  warnings,
  panelId,
  dispatch,
  onPage,
  makePrimary,
  unreadable,
  incoming = null,
}: {
  slide: StudioSlide;
  format: ScreenFormat;
  primaryFormat: ScreenFormat;
  /** The page shown (clamped to the layout's pages). */
  page: number;
  document: StudioDocument;
  settings: DashboardSettings;
  tokens: ThemeTokens;
  env: StudioEnv;
  selectedWidgetId: string | null;
  widgetsWithProblems: ReadonlySet<string>;
  warnings: ReadonlyMap<string, readonly FormatWarningItem[]>;
  panelId: string;
  dispatch: (action: StudioAction) => void;
  onPage: (page: number) => void;
  /** The "Make primary" control. */
  makePrimary?: ReactNode;
  unreadable?: ReadonlyMap<string, UnreadableLabel>;
  incoming?: CanvasOutline | null;
}) {
  const t = useT("studio.formats");
  const locale = useLocale();
  const pageTabs = useRef<Array<HTMLButtonElement | null>>([]);
  const custom = customLayoutOf(slide, primaryFormat, format);
  if (!custom) return null;
  const ratio = formatRatio(format);
  const primary = formatRatio(primaryFormat);
  const pages = custom.pages;
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const shown = pagePlacements(custom, page);
  const review = reviewPlacements(custom);
  const hidden = hiddenPlacements(custom);
  const widgetsById = new Map(
    slide.widgets.map((widget) => [widget.id, widget]),
  );
  const selected = selectedWidgetId
    ? custom.placements.find((placement) => placement.id === selectedWidgetId)
    : undefined;
  const selectedWidget = selected ? widgetsById.get(selected.id) : undefined;

  function onPageKey(event: KeyboardEvent<HTMLDivElement>) {
    const next = tabKeyTarget(event.key, page, pages);
    if (next === null) return;
    event.preventDefault();
    onPage(next);
    pageTabs.current[next]?.focus();
  }

  function show(widgetId: string) {
    const widget = widgetsById.get(widgetId);
    if (!widget) return;
    dispatch({
      type: "setWidgetHidden",
      widgetId,
      format,
      hidden: false,
      page,
    });
    // Follow the widget to the page it comes back on.
    const result = setHidden(
      custom!,
      widgetId,
      widget.type,
      format,
      false,
      page,
    );
    if (result.ok && result.placement) onPage(result.placement.page);
  }

  return (
    <div
      id={panelId}
      role="tabpanel"
      aria-labelledby={`${panelId}-tab-${format}`}
      className="format-editor format-editor--custom"
      data-format={format}
    >
      <div className="format-preview-bar">
        <div className="format-pages-group">
          {pages > 1 ? (
            <div
              className="format-pages"
              role="tablist"
              aria-label={t("pages")}
              onKeyDown={onPageKey}
            >
              {Array.from({ length: pages }, (_, index) => (
                <button
                  key={index}
                  ref={(element) => {
                    pageTabs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  aria-selected={index === page}
                  tabIndex={index === page ? 0 : -1}
                  onClick={() => onPage(index)}
                >
                  {t("page", { page: index + 1, pages })}
                </button>
              ))}
            </div>
          ) : null}
          <div className="format-layout-actions">
            <button
              type="button"
              disabled={pages >= 8}
              onClick={() => {
                dispatch({ type: "addLayoutPage", slideId: slide.id, format });
                onPage(pages);
              }}
            >
              + {t("addPage")}
            </button>
            {pages > 1 ? (
              <button
                type="button"
                disabled={shown.length > 0}
                title={shown.length > 0 ? t("pageEmpty") : undefined}
                onClick={() => {
                  dispatch({
                    type: "removeLayoutPage",
                    slideId: slide.id,
                    format,
                    page,
                  });
                  onPage(Math.max(0, page - 1));
                }}
              >
                {t("removePage", { page: page + 1 })}
              </button>
            ) : null}
          </div>
        </div>
        <div className="format-layout-actions">
          <button
            type="button"
            onClick={() => {
              if (window.confirm(t("backToAutoConfirm", { ratio }))) {
                dispatch({ type: "resetFormat", slideId: slide.id, format });
              }
            }}
          >
            {t("backToAuto")}
          </button>
          {makePrimary}
        </div>
      </div>
      <p className="help">{t("customEditorNote", { ratio, primary })}</p>
      {review.length > 0 ? (
        <div className="format-review" role="status">
          <span>{t("reviewNote", { count: review.length, primary })}</span>
          <button
            type="button"
            onClick={() =>
              dispatch({
                type: "confirmPlacement",
                slideId: slide.id,
                format,
                widgetId: null,
              })
            }
          >
            {t("looksGoodAll", { count: review.length })}
          </button>
        </div>
      ) : null}
      {selected && selectedWidget && !selected.hidden ? (
        <div
          className="format-widget-bar"
          role="group"
          aria-label={widgetName(selectedWidget, locale)}
        >
          <strong>{widgetName(selectedWidget, locale)}</strong>
          {selected.autoPlaced ? (
            <button
              type="button"
              className="primary"
              onClick={() =>
                dispatch({
                  type: "confirmPlacement",
                  slideId: slide.id,
                  format,
                  widgetId: selected.id,
                })
              }
            >
              {t("looksGood")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              dispatch({
                type: "setWidgetHidden",
                widgetId: selected.id,
                format,
                hidden: true,
              })
            }
          >
            {t("hideIn", { ratio })}
          </button>
          {pages > 1 ? (
            <label className="format-move-page">
              {t("moveToPage")}{" "}
              <select
                value={selected.page}
                onChange={(event) => {
                  const target = Number(event.target.value);
                  dispatch({
                    type: "moveWidgetToPage",
                    widgetId: selected.id,
                    format,
                    page: target,
                  });
                  onPage(target);
                }}
              >
                {Array.from({ length: pages }, (_, index) => (
                  <option key={index} value={index}>
                    {index + 1}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      <EditorCanvas
        slide={slide}
        dashboardName={document.name}
        settings={settings}
        tokens={tokens}
        env={env}
        selectedWidgetId={selectedWidgetId}
        widgetsWithProblems={widgetsWithProblems}
        dispatch={dispatch}
        unreadable={unreadable}
        incoming={incoming}
        primaryFormat={primaryFormat}
        format={format}
        layout={{
          placements: shown,
          review: new Set(review.map((placement) => placement.id)),
        }}
        pageLabel={pageLabel(page, pages)}
      />
      {hidden.length > 0 ? (
        <section
          className="format-hidden"
          aria-label={t("hiddenTitle", { ratio })}
        >
          <h3>{t("hiddenTitle", { ratio })}</h3>
          <ul>
            {hidden.map((placement) => {
              const widget = widgetsById.get(placement.id);
              if (!widget) return null;
              const name = widgetName(widget, locale);
              return (
                <li key={placement.id}>
                  <span>{name}</span>
                  <button
                    type="button"
                    aria-label={t("showInLabel", { name, ratio })}
                    onClick={() => show(placement.id)}
                  >
                    {t("showIn")}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <FormatWarningsList
        document={document}
        format={format}
        primaryFormat={format}
        warnings={warnings}
        onShow={(_slideId, widgetId) => {
          if (!widgetId) return;
          const placement = custom.placements.find(
            (entry) => entry.id === widgetId,
          );
          if (placement && !placement.hidden) onPage(placement.page);
          dispatch({ type: "selectWidget", widgetId });
        }}
      />
    </div>
  );
}
