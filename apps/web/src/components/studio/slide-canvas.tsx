"use client";

import {
  Component,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type { DashboardSlide } from "@netrics/contracts";
import {
  STUDIO_HEADER_BAND,
  STUDIO_TEXT_MINIMUMS,
  type ThemeTokens,
} from "@netrics/domain";

import { clockText } from "@/lib/studio-clock";
import { u, widgetBoxStyle } from "@/lib/studio-render";
import { themeStyle } from "@/lib/studio-theme";
import {
  slideBackground,
  type StudioEnv,
  type StudioImages,
  type StudioWidget,
} from "@/lib/studio-widgets";

import { LiveBarWidget } from "./bar-widget";
import { LiveClockWidget, useNow } from "./clock-widget";
import { ImageWidgetView } from "./image-widget";
import { LiveLineWidget } from "./line-widget";
import { LiveMetricWidget } from "./metric-widget";
import { TextWidgetView } from "./text-widget";
import { WidgetNotice } from "./widget-parts";

/** Header text sizes in units: the name, and the slide name and clock. */
const HEADER_NAME = 36;
const HEADER_META = 30;

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
  return (
    <div className="sw sw-failed">
      <WidgetNotice size={STUDIO_TEXT_MINIMUMS.any}>
        This widget could not be shown
      </WidgetNotice>
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
  logoImageId: string | null;
  timeZone: string;
  /** Shown when the screen has lost its connection. */
  offline?: boolean;
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
  return (
    <time className="studio-header-clock" suppressHydrationWarning>
      {clockText(now, { timeZone }).time}
    </time>
  );
}

function SlideHeader({
  header,
  images,
}: {
  header: SlideHeaderInfo;
  images: StudioImages;
}) {
  const logo = header.logoImageId ? images.get(header.logoImageId) : null;
  return (
    <header
      className="studio-header"
      style={{
        height: `${STUDIO_HEADER_BAND * 100}%`,
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
        className="studio-header-name"
        style={{ fontSize: u(HEADER_NAME) }}
        title={header.name}
      >
        {header.name}
      </span>
      {header.slideName ? (
        <span
          className="studio-header-slide"
          style={{ fontSize: u(HEADER_META) }}
          title={header.slideName}
        >
          {header.slideName}
        </span>
      ) : null}
      <span
        className="studio-header-meta"
        style={{ fontSize: u(HEADER_META), gap: u(24) }}
      >
        {header.offline ? (
          <span className="studio-offline">
            <span aria-hidden="true">⚠</span> Offline
          </span>
        ) : null}
        <HeaderClock timeZone={header.timeZone} />
      </span>
    </header>
  );
}

/**
 * One slide on a 16:9 canvas (ADR 0015): the optional header band, the
 * slide's background image under a dim of the theme background, and its
 * widgets on the 12 × 8 grid. Positions and text sizes come from
 * studioLayout; colours from the theme's tokens as CSS variables. The
 * canvas fills its container's width; `renderWidget` supplies the content
 * (live queries on signed-in pages, the device payload on screens).
 */
export function SlideCanvas({
  slide,
  tokens,
  showHeader,
  header,
  images,
  renderWidget,
  className,
  style,
}: {
  slide: DashboardSlide;
  tokens: ThemeTokens;
  showHeader: boolean;
  header: SlideHeaderInfo;
  images: StudioImages;
  renderWidget: (widget: StudioWidget) => ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const background = slideBackground(slide);
  const backgroundImage = background ? images.get(background.imageId) : null;
  const widgets: StudioWidget[] = slide.widgets;
  return (
    <div
      className={className ? `studio-canvas ${className}` : "studio-canvas"}
      style={{ ...themeStyle(tokens), ...style }}
    >
      {background && backgroundImage ? (
        <>
          <img
            className="studio-background"
            src={backgroundImage.url}
            alt=""
            width={backgroundImage.width}
            height={backgroundImage.height}
          />
          <div
            className="studio-background-dim"
            style={{ opacity: background.dim / 100 }}
          />
        </>
      ) : null}
      {showHeader ? <SlideHeader header={header} images={images} /> : null}
      {widgets.map((widget) => (
        <div
          key={widget.id}
          className={`studio-widget studio-widget--${widget.type}`}
          style={widgetBoxStyle(widget, showHeader)}
          data-widget-id={widget.id}
        >
          <WidgetBoundary>{renderWidget(widget)}</WidgetBoundary>
        </div>
      ))}
    </div>
  );
}
