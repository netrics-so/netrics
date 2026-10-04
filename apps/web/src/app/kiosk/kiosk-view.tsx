"use client";

import { useEffect, useState, type ReactNode } from "react";

import type {
  DeviceDashboardResponse,
  DeviceDashboardV2Response,
} from "@netrics/contracts";
import { conversionNote } from "@netrics/domain";

import { DeviceWidgetView } from "@/components/studio/device-widget";
import { SlidePlayer } from "@/components/studio/slide-player";
import { TileNotice, TileView } from "@/components/tile-view";
import { TvFrame, useClock, useIdle } from "@/components/tv-frame";
import {
  createKioskClient,
  isSlidesDashboard,
  type KioskState,
} from "@/lib/kiosk-client";
import { browserImageCache } from "@/lib/kiosk-image-cache";
import { themeStyle } from "@/lib/studio-theme";
import { pairingAddress } from "@/lib/pairing-address";
import { deviceTileNotice } from "@/lib/tile-status";

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

export function KioskView({ appVersion }: { appVersion: string }) {
  const [state, setState] = useState<KioskState>(INITIAL);

  useEffect(() => {
    const client = createKioskClient({
      fetch: window.fetch.bind(window),
      storage: browserStorage() ?? memoryStorage,
      appVersion,
      onChange: setState,
      imageCache: browserImageCache(),
    });
    client.start();
    return () => client.stop();
  }, [appVersion]);

  if (state.phase === "pairing") {
    return <PairingScreen state={state} />;
  }
  if (state.phase === "paired" && state.dashboard) {
    const payload = state.dashboard;
    if (payload.dashboard && isSlidesDashboard(payload)) {
      return (
        <KioskSlides
          state={state}
          payload={payload}
          dashboard={payload.dashboard}
        />
      );
    }
    return payload.dashboard && !isSlidesDashboard(payload) ? (
      <KioskDashboard state={state} dashboard={payload} />
    ) : (
      <Message title="No dashboard assigned yet">
        Choose one under TVs in netrics; this screen picks it up on its own.
        <OfflineMarker state={state} timeZone={state.dashboard.timeZone} />
      </Message>
    );
  }
  return (
    <Message title="netrics">
      {state.offline ? "Connecting to netrics…" : "Loading…"}
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
  return (
    <div className="tv kiosk-message">
      <p className="kiosk-text">Show a netrics dashboard on this screen</p>
      {pairing ? (
        <>
          <p className="kiosk-code" aria-label="Pairing code">
            {pairing.code}
          </p>
          <p className="kiosk-text">
            Go to{" "}
            <strong className="kiosk-url">
              {pairingAddress(pairing.pairingUrl)}
            </strong>{" "}
            and enter the code.
          </p>
        </>
      ) : (
        <p className="kiosk-code kiosk-code--pending" aria-hidden="true">
          ····-····
        </p>
      )}
      {state.offline ? (
        <p className="kiosk-offline">Cannot reach netrics — retrying</p>
      ) : null}
    </div>
  );
}

function formatTime(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
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
  if (!state.offline) {
    return null;
  }
  return (
    <span className="kiosk-offline" role="status" title={state.lastError ?? ""}>
      Offline
      {state.updatedAt
        ? ` — last update ${formatTime(state.updatedAt, timeZone)}`
        : ""}
    </span>
  );
}

/**
 * A schema 2 payload (#221): the dashboard's slides on the studio canvas,
 * rotating by each slide's duration, drawn from the payload alone.
 */
function KioskSlides({
  state,
  payload,
  dashboard,
}: {
  state: KioskState;
  payload: DeviceDashboardV2Response;
  dashboard: NonNullable<DeviceDashboardV2Response["dashboard"]>;
}) {
  const idle = useIdle();
  const { theme, timeZone } = payload;
  const env = {
    timeZone,
    fontScale: theme.tokens.fontScale,
    showHeader: dashboard.showHeader,
    images: state.images,
  };
  return (
    <div
      className={idle ? "slide-screen slide-screen--idle" : "slide-screen"}
      style={themeStyle(theme.tokens)}
    >
      <SlidePlayer
        slides={payload.slides}
        autoAdvance={payload.rotation.autoAdvance}
        transition={payload.rotation.transition}
        tokens={theme.tokens}
        showHeader={dashboard.showHeader}
        header={{
          name: dashboard.name,
          logoImageId: dashboard.logo?.imageId ?? null,
          timeZone,
          offline: dashboard.showHeader && state.offline,
        }}
        images={state.images}
        renderWidget={(widget) => (
          <DeviceWidgetView widget={widget} env={env} />
        )}
        empty={
          <p className="kiosk-text slide-screen-empty">
            This dashboard has no slides to show.
          </p>
        }
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

function KioskDashboard({
  state,
  dashboard,
}: {
  state: KioskState;
  dashboard: DeviceDashboardResponse;
}) {
  const clock = useClock(dashboard.timeZone);
  return (
    <TvFrame
      title={dashboard.dashboard?.name ?? "netrics"}
      tileCount={dashboard.tiles.length}
      meta={
        <>
          <OfflineMarker state={state} timeZone={dashboard.timeZone} />
          <span>{clock}</span>
        </>
      }
    >
      {dashboard.tiles.map((tile) => {
        const notice = deviceTileNotice(tile.status, tile.updatedAt);
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
                <p>This tile could not load.</p>
              </div>
            }
            // Converted amounts cite the ECB and name what was left out
            // (#191), as on tvOS.
            note={
              tile.conversion ? (
                <p className="tile-conversion">
                  {conversionNote(
                    tile.conversion.unconverted.map((entry) => entry.currency),
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
