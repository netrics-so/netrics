"use client";

import {
  Component,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type { DashboardSlide } from "@netrics/contracts";
import {
  STUDIO_HEADER_METRICS,
  STUDIO_TEXT_MINIMUMS,
  estimateTextWidth,
  headerFit,
  type LayoutPlacement,
  type ScreenFormat,
  type StudioPlacement,
  type ThemeTokens,
} from "@netrics/domain";

import { useLocale, useT } from "@/lib/i18n/client";
import {
  canvasGeometry,
  screenFormatOf,
  slidePages,
  type CanvasGeometry,
  type ScreenSize,
  type SlideLayouts,
} from "@/lib/screen-view";
import { refreshCountdown, type RefreshCycle } from "@/lib/refresh-countdown";
import { clockText } from "@/lib/studio-clock";
import { u, type ScreenPlacement } from "@/lib/studio-render";
import { useElementSize } from "@/lib/use-screen";
import { themeStyle, themeSurface } from "@/lib/studio-theme";
import {
  slideBackground,
  type StudioEnv,
  type StudioImages,
  type StudioWidget,
} from "@/lib/studio-widgets";

import { LiveBarWidget } from "./bar-widget";
import { LiveTableWidget } from "./table-widget";
import { LiveClockWidget, useNow } from "./clock-widget";
import { ImageWidgetView } from "./image-widget";
import { LiveLineWidget } from "./line-widget";
import { LiveMetricWidget } from "./metric-widget";
import { TextWidgetView } from "./text-widget";
import { WidgetNotice } from "./widget-parts";

/** Header text sizes in units: the name, and the slide name and clock. */
const HEADER_NAME = 36;
const HEADER_META = 30;
/** The refresh countdown: its text, and its progress bar (ADR 0018 §5). */
const COUNTDOWN_TEXT = STUDIO_TEXT_MINIMUMS.any;
const COUNTDOWN_BAR = { width: 210, height: 4.5 };
const COUNTDOWN_GAP = 12;
/** Between the items on the header's right (countdown, offline, clock). */
const HEADER_META_GAP = 24;

/**
 * Keeps one widget's failure inside its box: the rest of the slide stays
 * on screen (ADR 0015, section 7: a failing widget never fails the
 * dashboard).
 */
export class WidgetBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return <WidgetFailed />;
    }
    return this.props.children;
  }
}

export function WidgetFailed() {
  const t = useT("screen.widget");
  return (
    <div className="sw sw-failed">
      <WidgetNotice size={STUDIO_TEXT_MINIMUMS.any}>{t("failed")}</WidgetNotice>
    </div>
  );
}

/** A widget with its own data, for signed-in pages. */
export function LiveWidget({
  widget,
  env,
}: {
  widget: StudioWidget;
  env: StudioEnv;
}) {
  switch (widget.type) {
    case "metric":
      return <LiveMetricWidget widget={widget} env={env} />;
    case "line":
      return <LiveLineWidget widget={widget} env={env} />;
    case "bar":
      return <LiveBarWidget widget={widget} env={env} />;
    case "table":
      return <LiveTableWidget widget={widget} env={env} />;
    case "image":
      return (
        <ImageWidgetView
          widget={widget}
          image={env.images.get(widget.imageId) ?? null}
        />
      );
    case "text":
      return (
        <TextWidgetView
          text={widget.text}
          options={widget.options}
          placement={widget}
          showHeader={env.showHeader}
          fontScale={env.fontScale}
        />
      );
    case "clock":
      return (
        <LiveClockWidget
          options={widget.options}
          timeZone={widget.options.timeZone}
          workspaceTimeZone={env.timeZone}
          placement={widget}
          showHeader={env.showHeader}
          fontScale={env.fontScale}
        />
      );
    default:
      // A type this build does not know yet (a newer server): its box
      // stays, with a notice, instead of breaking the slide.
      return <WidgetFailed />;
  }
}

export interface SlideHeaderInfo {
  /** The dashboard's name. */
  name: string;
  slideName: string | null;
  /** The page of a slide on several pages ("1/2"), never cut off. */
  pageLabel?: string | null;
  logoImageId: string | null;
  timeZone: string;
  /** Shown when the screen has lost its connection. */
  offline?: boolean;
  /**
   * The data's refresh cadence: the header counts down to the next
   * refresh where there is room (TV mode, kiosk, Play; not the Studio).
   */
  refresh?: RefreshCycle | null;
}

/** True while the browser reports no network (the header's marker). */
export function useOffline(): boolean {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return offline;
}

function HeaderClock({ timeZone }: { timeZone: string }) {
  const now = useNow();
  const locale = useLocale();
  return (
    <time className="studio-header-clock" suppressHydrationWarning>
      {clockText(now, { timeZone, locale }).time}
    </time>
  );
}

/**
 * "next refresh in 42 s" over a thin bar that fills towards the refresh,
 * ticking every second (the bar moves linearly between ticks, and jumps
 * back without a transition when a new cycle starts).
 */
function RefreshCountdownView({ cycle }: { cycle: RefreshCycle }) {
  const t = useT("screen.player");
  const { since, everyMs } = cycle;
  const [tick, setTick] = useState(() => ({ now: since, reset: false }));
  useEffect(() => {
    const at = (now: number) => refreshCountdown(now, { since, everyMs });
    const update = () =>
      setTick((previous) => {
        const now = Date.now();
        return { now, reset: at(now).fraction < at(previous.now).fraction };
      });
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [since, everyMs]);
  const { seconds, fraction } = refreshCountdown(tick.now, cycle);
  return (
    <span
      className="studio-refresh"
      style={{ fontSize: u(COUNTDOWN_TEXT), gap: u(COUNTDOWN_GAP) }}
    >
      <span suppressHydrationWarning>{t("nextRefresh", { seconds })}</span>
      <span
        className="studio-refresh-bar"
        style={{
          width: u(COUNTDOWN_BAR.width),
          height: u(COUNTDOWN_BAR.height),
        }}
        aria-hidden="true"
      >
        <span
          className={
            tick.reset
              ? "studio-refresh-fill studio-refresh-fill--reset"
              : "studio-refresh-fill"
          }
          style={{ width: `${(fraction * 100).toFixed(2)}%` }}
        />
      </span>
    </span>
  );
}

/**
 * Whether the countdown fits beside the names the header shows, by the
 * same conservative estimates as `headerFit`: it is left out before the
 * dashboard or slide name would be cut, and in narrow formats.
 */
function countdownFits(
  fit: ReturnType<typeof headerFit>,
  shown: { name: string; slideName: string | null; pageLabel: string | null },
  sample: string,
): boolean {
  if (fit.maxNameLines > 1) return false;
  const m = STUDIO_HEADER_METRICS;
  const used =
    estimateTextWidth(shown.name.trim(), m.name, "semibold") +
    (shown.slideName
      ? m.gap + estimateTextWidth(shown.slideName.trim(), m.meta)
      : 0) +
    (shown.pageLabel ? m.gap + estimateTextWidth(shown.pageLabel, m.meta) : 0);
  const countdown =
    HEADER_META_GAP +
    estimateTextWidth(sample, COUNTDOWN_TEXT) +
    COUNTDOWN_GAP +
    COUNTDOWN_BAR.width;
  return fit.width - used >= countdown;
}

/**
 * The header band: logo, dashboard name, slide name (and page), clock. The
 * format's header rule (`headerFit`, ADR 0017 section 6) decides: in narrow
 * formats (3:4, 9:16) the dashboard name wraps to two lines before it is
 * cut, and the slide name is shown only when it fits beside a one-line
 * name, so it is dropped before the dashboard name is cut.
 */
function SlideHeader({
  header,
  box,
  images,
  format,
}: {
  header: SlideHeaderInfo;
  box: NonNullable<CanvasGeometry["header"]>;
  images: StudioImages;
  format: ScreenFormat;
}) {
  const logo = header.logoImageId ? images.get(header.logoImageId) : null;
  const t = useT("screen.widget");
  const tPlayer = useT("screen.player");
  const fit = headerFit({
    name: header.name,
    slideName: header.slideName,
    format,
    logoAspect: logo && logo.height > 0 ? logo.width / logo.height : null,
  });
  const wrap = fit.maxNameLines > 1;
  const slideName =
    header.slideName && fit.showSlideName ? header.slideName : null;
  const showCountdown =
    header.refresh != null &&
    !header.offline &&
    countdownFits(
      fit,
      { name: header.name, slideName, pageLabel: header.pageLabel ?? null },
      tPlayer("nextRefresh", { seconds: 88 }),
    );
  return (
    <header
      className="studio-header"
      style={{
        ...("left" in box ? { ...box, right: "auto" } : box),
        padding: `0 ${u(32)}`,
        gap: u(20),
      }}
    >
      {logo ? (
        <img
          className="studio-logo"
          src={logo.url}
          alt=""
          width={logo.width}
          height={logo.height}
          style={{ height: u(48) }}
        />
      ) : null}
      <span
        className={
          wrap
            ? "studio-header-name studio-header-name--wrap"
            : "studio-header-name"
        }
        style={{ fontSize: u(HEADER_NAME) }}
        title={header.name}
      >
        {header.name}
      </span>
      {slideName ? (
        <span
          className="studio-header-slide"
          style={{ fontSize: u(HEADER_META) }}
          title={slideName}
        >
          {slideName}
        </span>
      ) : null}
      {header.pageLabel ? (
        <span
          className="studio-header-page"
          style={{ fontSize: u(HEADER_META) }}
        >
          {header.pageLabel}
        </span>
      ) : null}
      <span
        className="studio-header-meta"
        style={{ fontSize: u(HEADER_META), gap: u(HEADER_META_GAP) }}
      >
        {showCountdown && header.refresh ? (
          <RefreshCountdownView cycle={header.refresh} />
        ) : null}
        {header.offline ? (
          <span className="studio-offline">
            <span aria-hidden="true">⚠</span> {t("offline")}
          </span>
        ) : null}
        <HeaderClock timeZone={header.timeZone} />
      </span>
    </header>
  );
}

/** A layer over the whole screen, bars included (no reliance on `inset`). */
const BACKGROUND_LAYER: CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

/**
 * The slide background covers the whole canvas whatever its aspect ratio:
 * scaled to fill, centred, the overflow cropped (as tvOS and the kiosk).
 * Inline, so no page style (an image reset, a missing class) can leave a
 * strip of canvas showing.
 */
const BACKGROUND_COVER: CSSProperties = {
  ...BACKGROUND_LAYER,
  display: "block",
  width: "100%",
  height: "100%",
  maxWidth: "none",
  maxHeight: "none",
  objectFit: "cover",
  objectPosition: "center",
};

/** What the canvas needs of a widget: its id, type and grid placement. */
export interface CanvasWidget extends StudioPlacement {
  id: string;
  type: string;
}

/**
 * What the canvas needs of a slide: a dashboard document's slide or a
 * device payload's (schema 2), whose widgets carry their data.
 */
export interface CanvasSlide<W extends CanvasWidget> {
  background: DashboardSlide["background"];
  widgets: readonly W[];
  /** Custom layouts per format (ADR 0017); none: every format is auto. */
  layouts?: SlideLayouts | null;
}

/**
 * What `renderWidget` gets: the widget at its placement in the screen's
 * format, with its box in units off the classic 16:9 canvas.
 */
export type PlacedWidget<W extends CanvasWidget> = W & ScreenPlacement;

/**
 * One slide in screen view (ADR 0015, ADR 0017 sections 2 and 11): the
 * optional header band, the slide's background image under a dim of the
 * theme background (both over the whole screen, bars included), and its
 * widgets on the grid of the screen's format. The format comes from the
 * canvas's measured size (`ResizeObserver`), or `format`; the layout is
 * the primary, the slide's custom layout or the auto reflow, one page of
 * it. A 16:9 screen in a `16x9` dashboard renders exactly as before.
 * Positions and text sizes come from studioLayout; colours from the theme
 * tokens as CSS variables; `renderWidget` supplies the content (live
 * queries on signed-in pages, the device payload on screens).
 */
export function SlideCanvas<W extends CanvasWidget = StudioWidget>({
  slide,
  tokens,
  showHeader,
  header,
  images,
  renderWidget,
  className,
  style,
  primaryFormat = "16x9",
  format: forcedFormat,
  page = 0,
  placements,
  screen: assumedScreen = null,
  fill = false,
  footer = null,
}: {
  slide: CanvasSlide<W>;
  tokens: ThemeTokens;
  showHeader: boolean;
  header: SlideHeaderInfo;
  images: StudioImages;
  renderWidget: (widget: PlacedWidget<W>) => ReactNode;
  className?: string;
  style?: CSSProperties;
  /** The format the slide's widgets are placed in. */
  primaryFormat?: ScreenFormat;
  /** The format to show; default: the measured size's. */
  format?: ScreenFormat;
  /** The page to show (0-based) when the layout has several. */
  page?: number;
  /** The page's placements, when the caller has them (the player). */
  placements?: readonly LayoutPlacement[];
  /** The screen size assumed until measured (server render, tests). */
  screen?: ScreenSize | null;
  /** Fill the container instead of a 16:9 box of its width. */
  fill?: boolean;
  /** Drawn in the canvas's bottom padding (the player's slide footer). */
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const measured = useElementSize(ref);
  const screen = measured ?? assumedScreen;
  const format = forcedFormat ?? screenFormatOf(screen);
  const background = slideBackground(slide);
  const backgroundImage = background ? images.get(background.imageId) : null;
  const shown =
    placements ??
    slidePages(slide.widgets, {
      primaryFormat,
      format,
      layouts: slide.layouts,
    })[page] ??
    [];
  const byId = new Map(shown.map((placement) => [placement.id, placement]));
  const geometry = canvasGeometry(screen, format, showHeader);
  const classes = [
    "studio-canvas",
    fill ? "studio-canvas--fill" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      ref={ref}
      className={classes}
      data-format={format}
      data-surface={themeSurface(tokens)}
      style={{
        ...themeStyle(tokens),
        ...(geometry.unit === null
          ? {}
          : ({ "--u": `${geometry.unit}px` } as CSSProperties)),
        ...style,
      }}
    >
      {background && backgroundImage ? (
        <>
          <img
            className="studio-background"
            src={backgroundImage.url}
            alt=""
            width={backgroundImage.width}
            height={backgroundImage.height}
            style={BACKGROUND_COVER}
          />
          <div
            className="studio-background-dim"
            style={{ ...BACKGROUND_LAYER, opacity: background.dim / 100 }}
          />
        </>
      ) : null}
      {geometry.header ? (
        <SlideHeader
          header={header}
          box={geometry.header}
          images={images}
          format={format}
        />
      ) : null}
      {slide.widgets.map((widget) => {
        const placement = byId.get(widget.id);
        if (!placement) return null;
        const { box, unitBox } = geometry.widget(placement);
        // The classic canvas in the primary format passes the widget
        // itself, so it renders exactly as before.
        const placed: PlacedWidget<W> =
          geometry.classic && format === primaryFormat
            ? widget
            : {
                ...widget,
                x: placement.x,
                y: placement.y,
                w: placement.w,
                h: placement.h,
                unitBox,
                format,
              };
        return (
          <div
            key={widget.id}
            className={`studio-widget studio-widget--${widget.type}`}
            style={box}
            data-widget-id={widget.id}
          >
            <WidgetBoundary>{renderWidget(placed)}</WidgetBoundary>
          </div>
        );
      })}
      {footer}
    </div>
  );
}
