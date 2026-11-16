"use client";

// The viewer's time zone (ADR 0025 §8, #736): every clock a viewer reads
// is in the zone of the person in front of the screen, the browser's. The
// workspace's zone only counts data days.

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/** The browser's IANA zone (on the server: the server's). */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The zone rendered before the browser's is known: on the server and
 * through hydration, so the markup (and a clock's layout, such as its zone
 * line) matches on both sides. UTC unless a provider says otherwise.
 */
const InitialTimeZone = createContext("UTC");

/**
 * Sets the zone rendered before hydration. Static renders (tests, the
 * server) show it; in the browser the viewer's zone follows on mount.
 */
export function ViewerTimeZoneProvider({
  zone,
  children,
}: {
  zone: string;
  children: ReactNode;
}) {
  return <InitialTimeZone value={zone}>{children}</InitialTimeZone>;
}

// The zone does not change while a page runs; nothing to subscribe to.
const subscribe = () => () => {};

/**
 * The viewer's zone: the initial zone through hydration, then the
 * browser's.
 */
export function useViewerTimeZone(): string {
  const initial = useContext(InitialTimeZone);
  return useSyncExternalStore(subscribe, viewerTimeZone, () => initial);
}

/**
 * The zone a clock widget shows: its own, else the viewer's. A payload
 * clock marked `followsViewer` carries the workspace's zone only for older
 * screens, so it shows the viewer's too.
 */
export function useClockZone(
  timeZone: string | null | undefined,
  followsViewer = false,
): string {
  const viewer = useViewerTimeZone();
  return followsViewer ? viewer : (timeZone ?? viewer);
}
