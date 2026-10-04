import type { ReactNode } from "react";

import type { NavKey } from "@/lib/app-nav";

/** Simple 1.5 px line icons in currentColor, one per sidebar area. */
const PATHS: Record<NavKey, ReactNode> = {
  home: (
    <>
      <path d="M3.5 9 10 3.5 16.5 9" />
      <path d="M5 8v8h10V8" />
      <path d="M8.5 16v-4.5h3V16" />
    </>
  ),
  dashboards: (
    <>
      <rect x="3" y="3.5" width="14" height="13" rx="2" />
      <path d="M10 3.5v13M3 9.5h7" />
    </>
  ),
  themes: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 3.5a6.5 6.5 0 0 0 0 13z" fill="currentColor" />
    </>
  ),
  sources: (
    <>
      <ellipse cx="10" cy="5" rx="5.5" ry="2" />
      <path d="M4.5 5v10c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V5" />
      <path d="M4.5 10c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
    </>
  ),
  addSource: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 7v6M7 10h6" />
    </>
  ),
  screens: (
    <>
      <rect x="2.5" y="4" width="15" height="9.5" rx="1.5" />
      <path d="M7 16.5h6M10 13.5v3" />
    </>
  ),
  team: (
    <>
      <circle cx="7.5" cy="7.5" r="2.5" />
      <path d="M3 16c0-2.5 2-4.5 4.5-4.5S12 13.5 12 16" />
      <path d="M12.5 5.2a2.5 2.5 0 0 1 0 4.6M14 11.7c1.7.5 3 2.2 3 4.3" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </>
  ),
};

export function NavIcon({ name }: { name: NavKey }) {
  return (
    <svg
      className="nav-icon"
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The chevron of a menu button. */
export function Chevron() {
  return (
    <svg
      className="chevron"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  );
}

/** Three lines: the phone menu button. */
export function MenuIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />
    </svg>
  );
}
