"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";

import type {
  FormatWarningItem,
  ScreenFormat,
  ThemeTokens,
} from "@netrics/domain";

import { ScrollView } from "@/components/scroll/scroll-view";
import { LiveScrollWidget } from "@/components/scroll/scroll-widgets";
import { LiveWidget, SlideCanvas } from "@/components/studio/slide-canvas";
import { useLocale, useT } from "@/lib/i18n/client";
import {
  pageLabel,
  slidePages,
  type ScreenSize,
  type SlideLayouts,
} from "@/lib/screen-view";
import {
  deviceOf,
  frameLayout,
  TARGET_DEVICES,
  tabKeyTarget,
  type FormatViewState,
  type PreviewDevice,
  type PreviewDeviceId,
  type PreviewTarget,
  type TargetStatus,
} from "@/lib/studio-formats";
import { widgetName, type StudioDocument } from "@/lib/studio-document";
import { logoImageId, slideTitle, type StudioEnv } from "@/lib/studio-widgets";
import { useElementSize, useViewportSize } from "@/lib/use-screen";

import { formatRatio } from "./format-attention";
import { useTargetName } from "./format-switcher";

// Device-frame previews of the Studio (ADR 0017 section 10, #283): the
// draft in a format, inside a CSS frame of a TV, monitor, tablet or phone,
// through the real renderers (SlideCanvas in screen view, ScrollView for
// the scroll view) with live data. The renderer works at the device's real
// screen size and is scaled into the frame, so what the preview shows is
// what that screen shows.

/** Stage pixels a preview may use until the stage is measured. */
const FALLBACK_AVAILABLE: ScreenSize = { width: 760, height: 520 };

/**
 * A device's frame around `children`, which render at the device's real
 * screen size (CSS px) and are scaled to fit `available`.
 */
export function DeviceFrame({
  device,
  available,
  label,
  scroll = false,
  children,
}: {
  device: PreviewDevice;
  available: ScreenSize;
  label: string;
  /** The screen scrolls (scroll view) instead of fitting (screen view). */
  scroll?: boolean;
  children: ReactNode;
}) {
  const layout = frameLayout(device, available);
  const { bezel } = layout;
  return (
    <div
      className={`device-frame device-frame--${device.kind}`}
      data-device={device.id}
      role="group"
      aria-label={label}
      style={{
        width: layout.width,
        height: layout.height,
        padding: `${bezel.top}px ${bezel.right}px ${bezel.bottom}px ${bezel.left}px`,
        borderRadius: layout.radius,
      }}
    >
      <div
        className="device-screen"
        style={{
          width: layout.screen.width,
          height: layout.screen.height,
          borderRadius:
            device.kind === "phone" || device.kind === "tablet"
              ? layout.radius * 0.6
              : 0,
        }}
      >
        <div
          className={
            scroll
              ? "device-viewport device-viewport--scroll"
              : "device-viewport"
          }
          style={{
            width: device.screen.width,
            height: device.screen.height,
            transform: `scale(${layout.scale})`,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** What every preview needs of the Studio. */
export interface PreviewContext {
  document: StudioDocument;
  primaryFormat: ScreenFormat;
  /** The stored custom layouts by slide id. */
  layouts: ReadonlyMap<string, SlideLayouts>;
  tokens: ThemeTokens;
  env: StudioEnv;
}

/** The pages of a draft slide in a format. */
export function draftSlidePages(
  context: PreviewContext,
  slideId: string,
  format: ScreenFormat,
) {
  const slide = context.document.slides.find((entry) => entry.id === slideId);
  return slidePages(slide?.widgets ?? [], {
    primaryFormat: context.primaryFormat,
    format,
    layouts: context.layouts.get(slideId) ?? null,
  });
}

/** The draft's slide (or, for scroll view, the dashboard) on a device. */
export function PreviewScreen({
  context,
  target,
  device,
  slideId,
  page,
}: {
  context: PreviewContext;
  target: PreviewTarget;
  device: PreviewDevice;
  slideId: string;
  page: number;
}) {
  const { document, tokens, env } = context;
  const untitled = useT("studio.editor")("untitled");
  const name = document.name.trim() || untitled;
  if (target === "scroll") {
    return (
      <ScrollView
        name={name}
        logoImageId={logoImageId(document.settings)}
        slides={document.slides}
        tokens={tokens}
        images={env.images}
        initialWidth={device.screen.width}
        renderWidget={(widget, size) => (
          <LiveScrollWidget widget={widget} env={env} size={size} />
        )}
      />
    );
  }
  const slide = document.slides.find((entry) => entry.id === slideId);
  if (!slide) return null;
  const pages = draftSlidePages(context, slideId, target);
  const shown = Math.min(page, pages.length - 1);
  return (
    <SlideCanvas
      slide={{ ...slide, layouts: context.layouts.get(slide.id) ?? null }}
      tokens={tokens}
      showHeader={document.settings.showHeader}
      header={{
        name,
        slideName: slide.name,
        pageLabel: pageLabel(shown, pages.length),
        logoImageId: logoImageId(document.settings),
        timeZone: env.timeZone,
      }}
      images={env.images}
      renderWidget={(widget) => <LiveWidget widget={widget} env={env} />}
      primaryFormat={context.primaryFormat}
      format={target}
      page={shown}
      placements={pages[shown]}
      screen={device.screen}
      fill
    />
  );
}

/** Warnings of one format, grouped by slide, in slide order. */
export function warningsBySlide(
  document: StudioDocument,
  warnings: ReadonlyMap<string, readonly FormatWarningItem[]>,
  format: ScreenFormat,
) {
  return document.slides.flatMap((slide, index) => {
    const own = (warnings.get(slide.id) ?? []).filter(
      (warning) => warning.format === format,
    );
    return own.length > 0 ? [{ slide, index, warnings: own }] : [];
  });
}

/**
 * The readability warnings of a format (section 6), attention first per
 * slide; a widget's warning selects it in the primary editor, the header's
 * the dashboard settings (where the name is).
 */
export function FormatWarningsList({
  document,
  format,
  primaryFormat,
  warnings,
  onShow,
}: {
  document: StudioDocument;
  format: ScreenFormat;
  primaryFormat: ScreenFormat;
  warnings: ReadonlyMap<string, readonly FormatWarningItem[]>;
  onShow: (slideId: string, widgetId: string | null) => void;
}) {
  const t = useT("studio.formats");
  const locale = useLocale();
  const groups = warningsBySlide(document, warnings, format);
  const primary = formatRatio(primaryFormat);
  return (
    <section
      className="format-warnings"
      aria-label={t("warningsTitle", { ratio: formatRatio(format) })}
    >
      <h3>{t("warningsTitle", { ratio: formatRatio(format) })}</h3>
      {groups.length === 0 ? (
        <p className="muted">{t("noWarnings")}</p>
      ) : (
        groups.map(({ slide, index, warnings: own }) => {
          const ordered = [
            ...own.filter((warning) => warning.severity === "attention"),
            ...own.filter((warning) => warning.severity === "info"),
          ];
          return (
            <div key={slide.id} className="format-warnings-slide">
              <h4>{slideTitle(slide, index, locale)}</h4>
              <ul>
                {ordered.map((warning, position) => {
                  const widget = warning.widgetId
                    ? slide.widgets.find(
                        (entry) => entry.id === warning.widgetId,
                      )
                    : undefined;
                  const text = t(`warning.${warning.code}`, {
                    widget: widget ? widgetName(widget, locale) : "",
                    pages: warning.pages ?? 0,
                    shown: warning.rows?.shown ?? 0,
                    limit: warning.rows?.limit ?? 0,
                  });
                  const clickable =
                    warning.code !== "continues" &&
                    (widget !== undefined || warning.widgetId === null);
                  return (
                    <li
                      key={`${warning.code}-${warning.widgetId ?? "slide"}-${position}`}
                      className={`format-warning format-warning--${warning.severity}`}
                      data-code={warning.code}
                    >
                      <span className="format-warning-mark" aria-hidden="true">
                        {warning.severity === "attention" ? "⚠" : "ℹ"}
                      </span>
                      {clickable ? (
                        <button
                          type="button"
                          className="link-button"
                          title={t("showInEditor", { primary })}
                          onClick={() => onShow(slide.id, warning.widgetId)}
                        >
                          {text}
                        </button>
                      ) : (
                        <span>{text}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

/** The device and page controls, the frame, the note and the warnings of one format. */
export function FormatPreview({
  context,
  view,
  status,
  slideId,
  warnings,
  panelId,
  onDevice,
  onPage,
  onShowWarning,
  actions = null,
}: {
  context: PreviewContext;
  view: FormatViewState;
  status: TargetStatus;
  slideId: string;
  warnings: ReadonlyMap<string, readonly FormatWarningItem[]>;
  panelId: string;
  onDevice: (device: PreviewDeviceId) => void;
  onPage: (page: number) => void;
  onShowWarning: (slideId: string, widgetId: string | null) => void;
  /** "Customize" and "Make primary" for a format laid out automatically. */
  actions?: ReactNode;
}) {
  const t = useT("studio.formats");
  const target = view.target;
  const nameOf = useTargetName();
  const { name, ratio } = nameOf(target);
  const device = deviceOf(view, target);
  const stage = useRef<HTMLDivElement>(null);
  const measured = useElementSize(stage);
  const available = availableFor(measured, useViewportSize());
  const pages =
    target === "scroll" ? [[]] : draftSlidePages(context, slideId, target);
  const page = Math.min(view.page, pages.length - 1);
  const pageTabs = useRef<Array<HTMLButtonElement | null>>([]);
  const primary = formatRatio(context.primaryFormat);
  const deviceName = t(`device.${device.id}`);

  function onPageKey(event: KeyboardEvent<HTMLDivElement>) {
    const next = tabKeyTarget(event.key, page, pages.length);
    if (next === null) return;
    event.preventDefault();
    onPage(next);
    pageTabs.current[next]?.focus();
  }

  return (
    <div
      className="format-preview"
      id={panelId}
      role="tabpanel"
      aria-labelledby={`${panelId}-tab-${target}`}
    >
      <div className="format-preview-bar">
        {TARGET_DEVICES[target].length > 1 ? (
          <div
            className="format-devices"
            role="group"
            aria-label={t("devices")}
          >
            {TARGET_DEVICES[target].map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={id === device.id}
                onClick={() => onDevice(id)}
              >
                {t(`device.${id}`)}
              </button>
            ))}
          </div>
        ) : null}
        {pages.length > 1 ? (
          <div
            className="format-pages"
            role="tablist"
            aria-label={t("pages")}
            onKeyDown={onPageKey}
          >
            {pages.map((_, index) => (
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
                {t("page", { page: index + 1, pages: pages.length })}
              </button>
            ))}
          </div>
        ) : null}
        {actions ? (
          <div className="format-layout-actions">{actions}</div>
        ) : null}
      </div>
      <div ref={stage} className="format-preview-stage">
        <DeviceFrame
          device={device}
          available={available}
          scroll={target === "scroll"}
          label={
            target === "scroll"
              ? t("scrollFrameLabel", { device: deviceName })
              : t("frameLabel", { name, ratio, device: deviceName })
          }
        >
          <PreviewScreen
            context={context}
            target={target}
            device={device}
            slideId={slideId}
            page={page}
          />
        </DeviceFrame>
      </div>
      <p className="help">
        {target === "scroll"
          ? t("scrollNote")
          : status.layout === "custom"
            ? t("customNote", { count: status.customSlides, primary })
            : t("autoNote", { primary })}
      </p>
      {target === "scroll" ? null : (
        <FormatWarningsList
          document={context.document}
          format={target}
          primaryFormat={context.primaryFormat}
          warnings={warnings}
          onShow={onShowWarning}
        />
      )}
    </div>
  );
}

/** The stage's room for a frame: its width, and a height a screen fits in. */
export function availableFor(
  measured: ScreenSize | null,
  viewport: ScreenSize | null,
): ScreenSize {
  return {
    width: measured?.width ?? FALLBACK_AVAILABLE.width,
    height: viewport
      ? Math.max(320, Math.min(viewport.height * 0.68, 820))
      : FALLBACK_AVAILABLE.height,
  };
}

/** Room for a thumbnail in "All formats". */
const THUMBNAIL: ScreenSize = { width: 300, height: 220 };

/**
 * "All formats" (section 10): every format's frame side by side as small
 * thumbnails of the selected slide (the scroll view shows the dashboard),
 * each with its state; choosing one opens it.
 */
export function FormatOverview({
  context,
  view,
  statuses,
  slideId,
  panelId,
  onOpen,
}: {
  context: PreviewContext;
  view: FormatViewState;
  statuses: readonly TargetStatus[];
  slideId: string;
  panelId: string;
  onOpen: (target: PreviewTarget) => void;
}) {
  const t = useT("studio.formats");
  const nameOf = useTargetName();
  return (
    <div className="format-overview" id={panelId}>
      <p className="help">{t("overviewHelp")}</p>
      <ul className="format-overview-grid">
        {statuses.map((status) => {
          const { name, ratio } = nameOf(status.target);
          const device = deviceOf(view, status.target);
          const deviceName = t(`device.${device.id}`);
          return (
            <li
              key={status.target}
              className="format-overview-item"
              data-target={status.target}
            >
              {/* The button below opens it from the keyboard. */}
              <div
                className="format-overview-thumb"
                onClick={() => onOpen(status.target)}
              >
                <div inert>
                  <DeviceFrame
                    device={device}
                    available={THUMBNAIL}
                    scroll={status.target === "scroll"}
                    label={
                      status.target === "scroll"
                        ? t("scrollFrameLabel", { device: deviceName })
                        : t("frameLabel", { name, ratio, device: deviceName })
                    }
                  >
                    <PreviewScreen
                      context={context}
                      target={status.target}
                      device={device}
                      slideId={slideId}
                      page={0}
                    />
                  </DeviceFrame>
                </div>
              </div>
              <button
                type="button"
                className="format-overview-open"
                onClick={() => onOpen(status.target)}
                aria-label={t("openFormat", { name, ratio })}
              >
                <span className="format-chip-ratio">{ratio}</span>{" "}
                <span>{name}</span>{" "}
                <span className="format-chip-layout">
                  {t(`layout.${status.layout}`)}
                </span>
                {status.attention > 0 ? (
                  <span className="format-chip-badge format-chip-badge--attention">
                    {" "}
                    ⚠ {status.attention}
                  </span>
                ) : null}
                {status.toReview > 0 ? (
                  <span className="format-chip-badge format-chip-badge--review">
                    {" "}
                    {t("toReview", { count: status.toReview })}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
