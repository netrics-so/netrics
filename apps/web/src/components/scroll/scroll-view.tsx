"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type { DashboardSlide } from "@netrics/contracts";
import type { LayoutWidget, ThemeTokens } from "@netrics/domain";

import { WidgetBoundary, useOffline } from "@/components/studio/slide-canvas";
import { useLocale, useT } from "@/lib/i18n/client";
import { scrollItemWidth, scrollSections } from "@/lib/scroll-view";
import { themeStyle, themeSurface } from "@/lib/studio-theme";
import {
  slideBackground,
  slideTitle,
  type StudioImages,
} from "@/lib/studio-widgets";

import type { ScrollCardSize } from "./scroll-widgets";

/** What the scroll view needs of a slide (a document's or, later, a payload's). */
export interface ScrollSlide<W extends LayoutWidget> {
  id: string;
  name: string | null;
  enabled: boolean;
  background: DashboardSlide["background"];
  widgets: readonly W[];
}

/** Width before the first measurement (and in static markup): a phone. */
const INITIAL_WIDTH = 360;

/** The view's width and the root font size, kept current on resize. */
function useScrollSize(initialWidth: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: initialWidth, rootPx: 16 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rootPx =
        Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        ) || 16;
      // The layout width: a preview scaled into a device frame (#283)
      // lays out as the real screen does.
      const width = Math.round(element.offsetWidth);
      setSize((previous) =>
        previous.width === width && previous.rootPx === rootPx
          ? previous
          : { width, rootPx },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}

/**
 * The scroll view of a dashboard (ADR 0017, section 5): the header (logo,
 * name, live or offline), then every enabled slide as a section with its
 * name as heading and all its widgets, clocks included, in the primary
 * layout's reading order over 1–3 columns (`scrollLayout`). A slide's
 * background is its section's backdrop under the slide's dim; cards and
 * the heading band keep the theme's surface, so text never sits on the
 * image. `renderWidget` supplies the cards: live queries on the signed-in
 * page; a kiosk set to scroll view (#276) can pass payload cards instead.
 */
export function ScrollView<W extends LayoutWidget>({
  name,
  logoImageId,
  slides,
  tokens,
  images,
  renderWidget,
  toolbar,
  initialWidth = INITIAL_WIDTH,
}: {
  name: string;
  logoImageId: string | null;
  slides: ReadonlyArray<ScrollSlide<W>>;
  tokens: ThemeTokens;
  images: StudioImages;
  renderWidget: (widget: W, size: ScrollCardSize) => ReactNode;
  /** Page controls shown in the header (mode switch, actions). */
  toolbar?: ReactNode;
  initialWidth?: number;
}) {
  const locale = useLocale();
  const t = useT("dashboard");
  const offline = useOffline();
  const baseId = useId();
  const { ref, width, rootPx } = useScrollSize(initialWidth);
  const sections = scrollSections(slides, width);
  const logo = logoImageId ? images.get(logoImageId) : null;
  const headingId = `${baseId}-name`;

  return (
    <div
      ref={ref}
      className="scroll-view"
      data-surface={themeSurface(tokens)}
      style={themeStyle(tokens) as CSSProperties}
      data-columns={sections[0]?.layout.columns ?? 1}
    >
      <header className="scroll-header">
        <div className="scroll-header-main">
          {logo ? (
            <img
              className="scroll-logo"
              src={logo.url}
              alt=""
              width={logo.width}
              height={logo.height}
            />
          ) : null}
          <h1 id={headingId} className="scroll-name">
            {name}
          </h1>
          <p
            className={offline ? "scroll-state offline" : "scroll-state live"}
            role="status"
          >
            <span className="scroll-state-dot" aria-hidden="true" />
            {offline ? t("offline") : t("live")}
          </p>
        </div>
        {toolbar ? <div className="scroll-toolbar">{toolbar}</div> : null}
      </header>
      <div
        className="scroll-sections"
        role="region"
        aria-label={t("scrollSlides", { name })}
      >
        {sections.map(({ slide, index, layout }) => {
          const background = slideBackground(slide);
          const image = background ? images.get(background.imageId) : null;
          const sectionId = `${baseId}-slide-${index}`;
          const byId = new Map(slide.widgets.map((w) => [w.id, w]));
          return (
            <section
              key={slide.id}
              className={
                image ? "scroll-section has-background" : "scroll-section"
              }
              aria-labelledby={sectionId}
            >
              {background && image ? (
                <>
                  <img
                    className="scroll-section-bg"
                    src={image.url}
                    alt=""
                    width={image.width}
                    height={image.height}
                    loading="lazy"
                    decoding="async"
                  />
                  <div
                    className="scroll-section-dim"
                    style={{ opacity: background.dim / 100 }}
                  />
                </>
              ) : null}
              <h2 id={sectionId} className="scroll-section-heading">
                {slideTitle(slide, index, locale)}
              </h2>
              {layout.items.length === 0 ? (
                <p className="scroll-card scroll-empty">{t("slideEmpty")}</p>
              ) : (
                <div
                  className="scroll-grid"
                  style={{
                    gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
                  }}
                >
                  {layout.items.map((item) => {
                    const widget = byId.get(item.id)!;
                    return (
                      <div
                        key={item.id}
                        className={`scroll-item scroll-item--${item.height}`}
                        data-widget-id={item.id}
                        data-span={item.span}
                        style={{
                          gridColumn: `${item.column + 1} / span ${item.span}`,
                          gridRow: item.row + 1,
                        }}
                      >
                        <WidgetBoundary>
                          {renderWidget(widget, {
                            width: scrollItemWidth(layout, item.span),
                            rootPx,
                          })}
                        </WidgetBoundary>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
