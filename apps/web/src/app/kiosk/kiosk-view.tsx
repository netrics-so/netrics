"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  DEVICE_REFRESH_AFTER_SECONDS,
  type DeviceDashboardResponse,
  type DeviceDashboardV2Response,
  type DeviceDashboardV3Response,
} from "@netrics/contracts";
import { conversionNote, matchLocale, type Locale } from "@netrics/domain";

import {
  RotatedScreen,
  screenRotationOf,
  type ScreenRotation,
} from "@/components/screen-rotation";
import { DeviceScrollWidget } from "@/components/scroll/device-scroll-widget";
import { ScrollView } from "@/components/scroll/scroll-view";
import { DeviceWidgetView } from "@/components/studio/device-widget";
import { SlidePlayer } from "@/components/studio/slide-player";
import { TileNotice, TileView } from "@/components/tile-view";
import { TvFrame, clockLocale, useClock, useIdle } from "@/components/tv-frame";
import { WEB_CATALOGS } from "@/lib/i18n/catalogs";
import { I18nProvider, useLocale, useT } from "@/lib/i18n/client";
import {
  createKioskClient,
  isFormatsDashboard,
  isSlidesDashboard,
  isTilesDashboard,
  kioskScreen,
  type KioskDashboard as KioskPayload,
  type KioskState,
} from "@/lib/kiosk-client";
import { browserImageCache } from "@/lib/kiosk-image-cache";
import { themeStyle } from "@/lib/studio-theme";
import { pairingAddress } from "@/lib/pairing-address";
import type { RefreshCycle } from "@/lib/refresh-countdown";
import { deviceTileNotice } from "@/lib/tile-status";
import { useWakeLock } from "@/lib/use-screen";

/** The product name, the same in every language. */
const BRAND = "netrics";

const INITIAL: KioskState = {
  phase: "starting",
  pairing: null,
  dashboard: null,
  images: new Map(),
  updatedAt: null,
  offline: false,
  lastError: null,
};

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const memory = new Map<string, string>();
const memoryStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
};

/**
 * The screen's language (ADR 0016 section 3): once paired, the payload's
 * (the workspace's screen language, else the instance default; a payload
 * without one is English); before, the page's (the instance default, else
 * the browser's).
 */
export function kioskLocale(state: KioskState, pageLocale: Locale): Locale {
  if (state.phase === "paired" && state.dashboard) {
    return matchLocale(state.dashboard.locale) ?? "en";
  }
  return pageLocale;
}

export function KioskView({ appVersion }: { appVersion: string }) {
  const [state, setState] = useState<KioskState>(INITIAL);
  const locale = kioskLocale(state, useLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  // A wall screen: kept awake where the browser allows (ADR 0017).
  useWakeLock(true);
  // What the heartbeat reports: the screen as rendered (rotated) and mode.
  const shown = useRef(kioskShown(state.dashboard));
  shown.current = kioskShown(state.dashboard);

  useEffect(() => {
    const client = createKioskClient({
      fetch: window.fetch.bind(window),
      storage: browserStorage() ?? memoryStorage,
      appVersion,
      onChange: setState,
      imageCache: browserImageCache(),
      // Schema 3: formats, custom layouts and device settings (#277).
      schemas: [1, 2, 3],
      screen: () =>
        kioskScreen(
          window.innerWidth,
          window.innerHeight,
          window.devicePixelRatio,
          shown.current,
        ),
    });
    client.start();
    return () => client.stop();
  }, [appVersion]);

  return (
    <I18nProvider locale={locale} messages={WEB_CATALOGS[locale]}>
      <KioskScreen state={state} />
    </I18nProvider>
  );
}

/** What the kiosk shows for its state, in the screen's language. */
export function KioskScreen({ state }: { state: KioskState }) {
  const t = useT("screen.kiosk");
  if (state.phase === "pairing") {
    return <PairingScreen state={state} />;
  }
  if (state.phase === "paired" && state.dashboard) {
    const payload = state.dashboard;
    // Every screen after pairing follows the device's rotation (ADR 0017
    // section 7); only schema 3 carries it.
    return (
      <RotatedScreen rotation={payloadRotation(payload)}>
        {payload.dashboard &&
        isFormatsDashboard(payload) &&
        payload.device.displayMode === "scroll" ? (
          <KioskScroll
            state={state}
            payload={payload}
            dashboard={payload.dashboard}
          />
        ) : payload.dashboard &&
          (isFormatsDashboard(payload) || isSlidesDashboard(payload)) ? (
          <KioskSlides
            state={state}
            payload={payload}
            dashboard={payload.dashboard}
          />
        ) : payload.dashboard && isTilesDashboard(payload) ? (
          <KioskDashboard state={state} dashboard={payload} />
        ) : (
          <Message title={t("noDashboardTitle")}>
            {t("noDashboardText")}
            <OfflineMarker state={state} timeZone={state.dashboard.timeZone} />
          </Message>
        )}
      </RotatedScreen>
    );
  }
  return (
    <Message title={BRAND}>
      {state.offline ? t("connecting") : t("loading")}
    </Message>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="tv kiosk-message">
      <h1 className="kiosk-title">{title}</h1>
      <p className="kiosk-text">{children}</p>
    </div>
  );
}

function PairingScreen({ state }: { state: KioskState }) {
  const { pairing } = state;
  const t = useT("screen.kiosk");
  return (
    <div className="tv kiosk-message">
      <p className="kiosk-text">{t("pairingPrompt")}</p>
      {pairing ? (
        <>
          <p className="kiosk-code" aria-label={t("pairingCode")}>
            {pairing.code}
          </p>
          <p className="kiosk-text">
            {t.rich("pairingGoTo", {
              url: (
                <strong key="url" className="kiosk-url">
                  {pairingAddress(pairing.pairingUrl)}
                </strong>
              ),
            })}
          </p>
        </>
      ) : (
        <p className="kiosk-code kiosk-code--pending" aria-hidden="true">
          ····-····
        </p>
      )}
      {state.offline ? (
        <p className="kiosk-offline">{t("unreachable")}</p>
      ) : null}
    </div>
  );
}

function formatTime(epochMs: number, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(clockLocale(locale), {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epochMs));
}

function OfflineMarker({
  state,
  timeZone,
}: {
  state: KioskState;
  timeZone: string;
}) {
  const t = useT("screen.kiosk");
  const locale = useLocale();
  if (!state.offline) {
    return null;
  }
  return (
    <span className="kiosk-offline" role="status" title={state.lastError ?? ""}>
      {state.updatedAt
        ? t("offlineSince", {
            time: formatTime(state.updatedAt, timeZone, locale),
          })
        : t("offline")}
    </span>
  );
}

/**
 * The device's rotation setting (ADR 0017 section 7): payload schema 3
 * carries it as `device.rotation`; earlier schemas are upright.
 */
export function payloadRotation(payload: object): ScreenRotation {
  const device = (payload as { device?: { rotation?: unknown } }).device;
  return screenRotationOf(device?.rotation);
}

/** The rotation and mode the kiosk renders a payload with. */
export function kioskShown(payload: KioskPayload | null): {
  rotation: ScreenRotation;
  mode: "screen" | "scroll";
} {
  if (!payload) return { rotation: 0, mode: "screen" };
  return {
    rotation: payloadRotation(payload),
    mode:
      isFormatsDashboard(payload) && payload.device.displayMode === "scroll"
        ? "scroll"
        : "screen",
  };
}

type SlidesPayload = DeviceDashboardV2Response | DeviceDashboardV3Response;

/**
 * The kiosk's refresh cadence for the header countdown: the payload's
 * `refreshAfterSec` after the API last answered; none before the first
 * answer or while offline (the header shows the offline marker then).
 */
export function kioskRefreshCycle(
  state: Pick<KioskState, "updatedAt" | "offline">,
  payload: { refreshAfterSec: number },
): RefreshCycle | null {
  if (state.updatedAt === null || state.offline) return null;
  const seconds =
    payload.refreshAfterSec > 0
      ? payload.refreshAfterSec
      : DEVICE_REFRESH_AFTER_SECONDS;
  return { since: state.updatedAt, everyMs: seconds * 1000 };
}

/**
 * A slides payload (#221) in screen view: the dashboard's slides rotating
 * by each slide's duration, drawn from the payload alone, in the format of
 * the real (rotated) viewport, live (ADR 0017 sections 2, 7 and 9). Schema
 * 3 brings the primary format and each slide's custom layouts; other
 * formats are reflowed here with the domain's functions (`slideLayoutFor`,
 * whose format table is the payload's `formats`: one source, the same
 * commit). Schema 2 always carries the `16x9` layout, reflowed from it.
 */
function KioskSlides({
  state,
  payload,
  dashboard,
}: {
  state: KioskState;
  payload: SlidesPayload;
  dashboard: NonNullable<SlidesPayload["dashboard"]>;
}) {
  const idle = useIdle();
  const t = useT("screen.kiosk");
  const { theme, timeZone } = payload;
  const env = {
    timeZone,
    fontScale: theme.tokens.fontScale,
    showHeader: dashboard.showHeader,
    images: state.images,
  };
  const formats = isFormatsDashboard(payload) ? payload : null;
  return (
    <div
      className={idle ? "slide-screen slide-screen--idle" : "slide-screen"}
      style={themeStyle(theme.tokens)}
    >
      <SlidePlayer
        slides={formats ? formats.slides : payload.slides}
        primaryFormat={formats ? formats.primaryFormat : "16x9"}
        autoAdvance={payload.rotation.autoAdvance}
        transition={payload.rotation.transition}
        tokens={theme.tokens}
        showHeader={dashboard.showHeader}
        header={{
          name: dashboard.name,
          logoImageId: dashboard.logo?.imageId ?? null,
          timeZone,
          offline: dashboard.showHeader && state.offline,
          refresh: kioskRefreshCycle(state, payload),
        }}
        images={state.images}
        renderWidget={(widget) => (
          <DeviceWidgetView widget={widget} env={env} />
        )}
        empty={<p className="kiosk-text slide-screen-empty">{t("noSlides")}</p>}
      />
      {/* With the header the marker is in it; without, in the corner. */}
      {state.offline && !dashboard.showHeader ? (
        <div className="slide-screen-status">
          <OfflineMarker state={state} timeZone={timeZone} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A kiosk set to scroll view (ADR 0017 sections 5 and 7): the scroll view
 * of the signed-in page, fed by the payload: every slide a section, its
 * widgets in the primary layout's reading order.
 */
function KioskScroll({
  state,
  payload,
  dashboard,
}: {
  state: KioskState;
  payload: DeviceDashboardV3Response;
  dashboard: NonNullable<DeviceDashboardV3Response["dashboard"]>;
}) {
  const { theme, timeZone } = payload;
  const env = {
    timeZone,
    fontScale: theme.tokens.fontScale,
    showHeader: dashboard.showHeader,
    images: state.images,
  };
  return (
    <div className="kiosk-scroll" style={themeStyle(theme.tokens)}>
      <ScrollView
        name={dashboard.name}
        logoImageId={dashboard.logo?.imageId ?? null}
        slides={payload.slides.map((slide) => ({ ...slide, enabled: true }))}
        tokens={theme.tokens}
        images={state.images}
        toolbar={<OfflineMarker state={state} timeZone={timeZone} />}
        renderWidget={(widget, size) => (
          <DeviceScrollWidget widget={widget} env={env} size={size} />
        )}
      />
    </div>
  );
}

function KioskDashboard({
  state,
  dashboard,
}: {
  state: KioskState;
  dashboard: DeviceDashboardResponse;
}) {
  const clock = useClock(dashboard.timeZone);
  const t = useT("screen.kiosk");
  const locale = useLocale();
  return (
    <TvFrame
      title={dashboard.dashboard?.name ?? BRAND}
      tileCount={dashboard.tiles.length}
      meta={
        <>
          <OfflineMarker state={state} timeZone={dashboard.timeZone} />
          <span>{clock}</span>
        </>
      }
    >
      {dashboard.tiles.map((tile) => {
        const notice = deviceTileNotice(tile.status, tile.updatedAt, locale);
        return (
          <TileView
            key={tile.id}
            variant="tv"
            label={tile.label}
            period={tile.period}
            aggregation={tile.aggregation}
            metric={
              tile.kind && tile.granularity
                ? {
                    kind: tile.kind,
                    granularity: tile.granularity,
                    better: tile.better,
                  }
                : null
            }
            reading={
              tile.unit === null
                ? null
                : {
                    value: tile.value,
                    unit: tile.unit,
                    delta: tile.change.delta,
                    ratio: tile.change.ratio,
                    series: tile.spark.map((value) => ({ value })),
                    timeZone: dashboard.timeZone,
                    approximate: tile.conversion !== null,
                  }
            }
            fallback={
              <div className="tile-error">
                <p>{t("tileFailed")}</p>
              </div>
            }
            // Converted amounts cite the ECB and name what was left out
            // (#191), as on tvOS.
            note={
              tile.conversion ? (
                <p className="tile-conversion">
                  {conversionNote(
                    tile.conversion.unconverted.map((entry) => entry.currency),
                    locale,
                  )}
                </p>
              ) : null
            }
            footer={notice ? <TileNotice>{notice}</TileNotice> : null}
          />
        );
      })}
    </TvFrame>
  );
}
