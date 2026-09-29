"use client";

import { useEffect, useState, type ReactNode } from "react";

import { tvGrid } from "@/lib/tv-grid";

const IDLE_MS = 3000;

function formatClock(timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

/** The time in the workspace's zone, updated every 15 seconds. */
export function useClock(timeZone: string): string {
  const [now, setNow] = useState(() => formatClock(timeZone));
  useEffect(() => {
    setNow(formatClock(timeZone));
    const timer = setInterval(() => setNow(formatClock(timeZone)), 15_000);
    return () => clearInterval(timer);
  }, [timeZone]);
  return now;
}

/** Hides the cursor and chrome after a few seconds without movement. */
export function useIdle(): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), IDLE_MS);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);
  return idle;
}

/**
 * The full-screen TV layout (#52): title and meta line on top, every tile
 * on one screen below. Used by the signed-in TV page and the kiosk (#59).
 */
export function TvFrame({
  title,
  meta,
  tileCount,
  emptyText = "This dashboard has no tiles yet.",
  children,
}: {
  title: string;
  meta: ReactNode;
  tileCount: number;
  emptyText?: string;
  children: ReactNode;
}) {
  const idle = useIdle();
  const { columns, rows } = tvGrid(tileCount);

  return (
    <div className={idle ? "tv tv--idle" : "tv"}>
      <header className="tv-header">
        <h1 className="tv-title">{title}</h1>
        <div className="tv-meta">{meta}</div>
      </header>
      {tileCount === 0 ? (
        <p className="tv-empty">{emptyText}</p>
      ) : (
        <div
          className="tv-grid"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
