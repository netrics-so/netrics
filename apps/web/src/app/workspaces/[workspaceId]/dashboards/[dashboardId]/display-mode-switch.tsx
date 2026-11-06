"use client";

import { useEffect, useState } from "react";

import type { DisplayMode } from "@netrics/domain";

import {
  browserStorage,
  initialDisplayMode,
  readDisplayMode,
  writeDisplayMode,
} from "@/lib/display-mode";
import { useT } from "@/lib/i18n/client";

/**
 * The page's display mode: null until mounted (the server cannot know the
 * screen), then the remembered choice or the default for this screen.
 * Choosing a mode remembers it in this browser.
 */
export function useDisplayMode(
  initial: DisplayMode | null = null,
): [DisplayMode | null, (mode: DisplayMode) => void] {
  const [mode, setMode] = useState<DisplayMode | null>(initial);
  useEffect(() => {
    if (initial !== null) return;
    let coarsePointer = false;
    try {
      coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    } catch {
      // No media queries: a fine pointer, i.e. screen view.
    }
    setMode(
      initialDisplayMode({
        stored: readDisplayMode(browserStorage()),
        width: window.innerWidth,
        height: window.innerHeight,
        coarsePointer,
      }),
    );
  }, [initial]);
  const choose = (next: DisplayMode) => {
    setMode(next);
    writeDisplayMode(browserStorage(), next);
  };
  return [mode, choose];
}

/** "Scroll view / Screen view": two toggle buttons, one pressed. */
export function DisplayModeSwitch({
  mode,
  onChange,
}: {
  mode: DisplayMode | null;
  onChange: (mode: DisplayMode) => void;
}) {
  const t = useT("dashboard");
  const options: Array<{ value: DisplayMode; label: string }> = [
    { value: "scroll", label: t("scrollView") },
    { value: "screen", label: t("screenView") },
  ];
  return (
    <div
      className="display-mode-switch"
      role="group"
      aria-label={t("displayMode")}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={mode === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
