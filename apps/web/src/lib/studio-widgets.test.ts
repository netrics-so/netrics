import { describe, expect, it } from "vitest";

import type {
  DashboardSettings,
  DashboardSlide,
  DashboardWidget,
} from "@netrics/contracts";

import {
  imageContentUrl,
  logoImageId,
  referencedImageIds,
  slideBackground,
  slideTitle,
  studioImageUrl,
  toStudioImage,
  textWidgetLayout,
  type StudioWidget,
} from "./studio-widgets";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const settings: DashboardSettings = {
  showHeader: true,
  autoAdvance: true,
  defaultSlideSeconds: 20,
  transition: "fade",
  themeBuiltin: "netrics_dark",
  themeId: null,
  accentColor: null,
  logoImageId: null,
};

function slide(widgets: StudioWidget[], extra: object = {}): DashboardSlide {
  return {
    id: ID(100 + widgets.length),
    position: 0,
    name: null,
    durationSeconds: null,
    enabled: true,
    background: null,
    widgets: widgets as DashboardWidget[],
    layouts: [],
    formatWarnings: [],
    ...extra,
  };
}

const metric = {
  type: "metric",
  id: ID(1),
  x: 0,
  y: 0,
  w: 3,
  h: 2,
  title: null,
  connectionId: ID(9),
  metricKey: "downloads",
  aggregation: "sum",
  period: "last_7_days",
  dimensions: {},
  displayCurrency: null,
  resourceName: null,
  allResourcesName: null,
  options: { showSparkline: true, showChange: true },
} as const satisfies StudioWidget;

const image: StudioWidget = {
  type: "image",
  id: ID(2),
  x: 3,
  y: 0,
  w: 2,
  h: 2,
  title: "Wurfel",
  imageId: ID(50),
  options: { fit: "contain", align: "center" },
};

describe("image references", () => {
  it("reads the logo and slide backgrounds when the API sends them (#217)", () => {
    expect(logoImageId(settings)).toBeNull();
    expect(logoImageId({ ...settings, logoImageId: ID(51) } as never)).toBe(
      ID(51),
    );
    expect(slideBackground(slide([]))).toBeNull();
    expect(
      slideBackground(slide([], { background: { imageId: ID(52), dim: 95 } })),
    ).toEqual({ imageId: ID(52), dim: 80 });
  });

  it("collects every image a dashboard shows, once", () => {
    const dashboard = {
      settings: { ...settings, logoImageId: ID(50) } as DashboardSettings,
      slides: [
        slide([metric, image], { background: { imageId: ID(52), dim: 40 } }),
        slide([image]),
      ],
    };
    expect(referencedImageIds(dashboard)).toEqual([ID(50), ID(52)]);
    expect(referencedImageIds({ settings, slides: [slide([metric])] })).toEqual(
      [],
    );
  });

  it("loads images only from same-origin /v1/ paths", () => {
    const image = { id: "i1", sha256: "ab" };
    const built = "/v1/workspaces/w1/images/i1/content?v=ab";
    expect(studioImageUrl("w1", { ...image, url: built })).toBe(built);
    for (const url of [
      "https://evil.example/x.png",
      "//evil.example/x.png",
      "/\\evil.example/x.png",
      "javascript:alert(1)",
      "/api/other",
      "",
      null,
    ]) {
      expect(studioImageUrl("w1", { ...image, url })).toBe(built);
    }
    expect(
      toStudioImage("w1", { ...image, url: built, width: 4, height: 3 }),
    ).toEqual({ id: "i1", url: built, width: 4, height: 3 });
  });

  it("builds the content URL with the hash as cache key", () => {
    expect(imageContentUrl("w1", { id: "i1", sha256: "ab" })).toBe(
      "/v1/workspaces/w1/images/i1/content?v=ab",
    );
  });
});

describe("slideTitle", () => {
  it("names unnamed slides by position", () => {
    expect(slideTitle({ name: "Sales" }, 0, "en")).toBe("Sales");
    expect(slideTitle({ name: null }, 1, "en")).toBe("Slide 2");
  });
});

describe("textWidgetLayout", () => {
  const placement = { x: 0, y: 0, w: 4, h: 2 };

  it("keeps the size option when the text fits", () => {
    const layout = textWidgetLayout({
      text: "# Wurfel\nDaily numbers",
      size: "body",
      placement,
      fontScale: 1,
      showHeader: true,
    });
    expect(layout.size).toBe("body");
    expect(layout.overflow).toBe(false);
    expect(layout.sizes.paragraph).toBe(32);
  });

  it("steps down to a smaller option before overflowing", () => {
    const layout = textWidgetLayout({
      text: "Welcome to the team",
      size: "display",
      placement,
      fontScale: 1,
      showHeader: true,
    });
    expect(layout.size).not.toBe("display");
    expect(layout.overflow).toBe(false);
  });

  it("flags text that does not fit even at body size", () => {
    const layout = textWidgetLayout({
      text: "word ".repeat(100),
      size: "body",
      placement: { x: 0, y: 0, w: 2, h: 1 },
      fontScale: 1,
      showHeader: true,
    });
    expect(layout.size).toBe("body");
    expect(layout.overflow).toBe(true);
  });
});
