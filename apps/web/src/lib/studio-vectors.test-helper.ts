import { readFileSync } from "node:fs";

import type {
  StudioPlacement,
  StudioTextBlock,
  StudioTypeScale,
  StudioWidgetType,
} from "@netrics/domain";

/**
 * The shared studio layout vectors (packages/domain/test-vectors), which
 * the domain and tvOS tests run too. The web renderers are checked against
 * the same file.
 */
export interface StudioVectors {
  rects: Array<{
    canvas: { width: number; height: number };
    showHeader: boolean;
    placement: StudioPlacement;
    rect: { x: number; y: number; width: number; height: number };
  }>;
  typeScales: Array<{
    type: StudioWidgetType;
    w: number;
    h: number;
    fontScale: number;
    showHeader: boolean;
    sizes: StudioTypeScale;
  }>;
  labelFits: Array<{
    label: string;
    type: StudioWidgetType;
    w: number;
    h: number;
    fontScale: number;
    fits: boolean;
    titleLines: number;
    resourceLines: number;
  }>;
  markdown: Array<{ source: string; blocks: StudioTextBlock[] }>;
}

export const studioVectors: StudioVectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/domain/test-vectors/studio-layout.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as StudioVectors;
