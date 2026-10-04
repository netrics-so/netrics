import type { CSSProperties, ReactNode } from "react";

/** A device's rotation setting in degrees (ADR 0017, section 7). */
export type ScreenRotation = 0 | 90 | 180 | 270;

/** A rotation from a payload: one of the four, else none. */
export function screenRotationOf(value: unknown): ScreenRotation {
  return value === 90 || value === 180 || value === 270 ? value : 0;
}

/**
 * The style of the rotated root: the screen's sides swapped for a quarter
 * turn, turned about the centre. Fixed elements inside (the slide screen)
 * are then placed in the rotated box, since a transformed element is their
 * containing block.
 */
export function rotationStyle(rotation: ScreenRotation): CSSProperties {
  if (rotation === 0) {
    return {};
  }
  const quarter = rotation === 90 || rotation === 270;
  return {
    position: "fixed",
    top: "50%",
    left: "50%",
    width: quarter ? "100vh" : "100vw",
    height: quarter ? "100vw" : "100vh",
    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
    transformOrigin: "center",
    overflow: "hidden",
  };
}

/**
 * Rotates everything inside by the device's rotation setting, for players
 * that cannot rotate their own output (some smart-TV browsers and signage
 * sticks, ADR 0017 section 7). The renderer inside measures its rotated
 * box, so a 1920 × 1080 screen turned 90° lays out as 1080 × 1920 (`9x16`).
 */
export function RotatedScreen({
  rotation,
  children,
}: {
  rotation: ScreenRotation;
  children: ReactNode;
}) {
  return (
    <div
      className="screen-rotation"
      data-rotation={rotation}
      style={rotationStyle(rotation)}
    >
      {children}
    </div>
  );
}
