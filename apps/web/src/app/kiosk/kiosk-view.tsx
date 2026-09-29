"use client";

import { useEffect, useState, type ReactNode } from "react";

import type { DeviceDashboardResponse } from "@netrics/contracts";

import { TileNotice, TileView } from "@/components/tile-view";
import { TvFrame, useClock } from "@/components/tv-frame";
import { createKioskClient, type KioskState } from "@/lib/kiosk-client";
import { deviceTileNotice } from "@/lib/tile-status";

const INITIAL: KioskState = {
  phase: "starting",
  pairing: null,
  dashboard: null,
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
    });
    client.start();
    return () => client.stop();
  }, [appVersion]);

  if (state.phase === "pairing") {
    return <PairingScreen state={state} />;
  }
  if (state.phase === "paired" && state.dashboard) {
    return state.dashboard.dashboard ? (
      <KioskDashboard state={state} dashboard={state.dashboard} />
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
            Open <strong className="kiosk-url">{pairing.pairingUrl}</strong> and
            enter the code.
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
                  }
            }
            fallback={
              <div className="tile-error">
                <p>This tile could not load.</p>
              </div>
            }
            footer={notice ? <TileNotice>{notice}</TileNotice> : null}
          />
        );
      })}
    </TvFrame>
  );
}
