import { describe, expect, it } from "vitest";

import {
  createDashboardRequestSchema,
  dashboardWidgetInputSchema,
} from "@netrics/contracts";
import {
  appStoreConnectManifest,
  demoManifest,
  searchConsoleManifest,
  vercelManifest,
} from "@netrics/connectors";
import {
  RESOURCE_DIMENSION,
  STUDIO_LIMITS,
  SUPPORTED_LOCALES,
  allResourcesName,
  compareCatalogs,
  labelFits,
  localizedMetric,
  localizedResourceNoun,
  slideLayoutProblem,
  tileLabel,
  type Locale,
  type WidgetType,
} from "@netrics/domain";

import { templateDe } from "./template-messages/de.js";
import { templateEn } from "./template-messages/en.js";
import {
  buildBrandTemplate,
  buildOverviewTemplate,
  splitWidths,
  type TemplateDashboard,
  type TemplateSource,
} from "./templates.js";

// The template builders (#226): every result must be a dashboard the API
// accepts (contract schema, grid bounds, minimum sizes, no overlap) whose
// labels fit at 1080p without truncation, for every mix of connections.

const asc = (name = "Wurfel team", hasReviews = false): TemplateSource => ({
  connectionId: crypto.randomUUID(),
  connectionName: name,
  connectorId: "app-store-connect",
  hasReviews,
});
const gsc: TemplateSource = {
  connectionId: crypto.randomUUID(),
  connectionName: "wurfel.app",
  connectorId: "google-search-console",
};
const vercel: TemplateSource = {
  connectionId: crypto.randomUUID(),
  connectionName: "Website",
  connectorId: "vercel",
};
const demo: TemplateSource = {
  connectionId: crypto.randomUUID(),
  connectionName: "Demo data",
  connectorId: "demo",
};
const unknown: TemplateSource = {
  connectionId: crypto.randomUUID(),
  connectionName: "Elsewhere",
  connectorId: "acme-analytics",
};

const MANIFESTS = [
  appStoreConnectManifest,
  searchConsoleManifest,
  vercelManifest,
  demoManifest,
];

/**
 * The automatic label of an untitled widget as screens show it (#256,
 * #257): the metric's name and, for a widget of all resources, "All apps"
 * (assuming several), both in the reader's language.
 */
function autoLabel(
  widget: { metricKey: string; dimensions?: Record<string, string> },
  locale: Locale,
  resourceName = "Wurfel – Cube Solver",
): string {
  const manifest = MANIFESTS.find((candidate) =>
    candidate.metrics.some((metric) => metric.key === widget.metricKey),
  )!;
  const metric = manifest.metrics.find(
    (candidate) => candidate.key === widget.metricKey,
  )!;
  const dimensions = widget.dimensions ?? {};
  return tileLabel({
    title: null,
    metricName: localizedMetric(manifest, metric, locale).name,
    dimensions,
    resourceName:
      dimensions[RESOURCE_DIMENSION] === undefined ? null : resourceName,
    allResourcesName: allResourcesName(
      localizedResourceNoun(manifest, locale),
      2,
      locale,
    ),
  });
}

/**
 * Parses like POST /dashboards and checks every slide's layout and labels:
 * the title, else the automatic label in `locale`, fits at font scale 1
 * and 1.3 (the largest a theme may set).
 */
function expectValid(
  template: TemplateDashboard | null,
  locale: Locale = "en",
) {
  expect(template).not.toBeNull();
  const parsed = createDashboardRequestSchema.parse(template);
  expect(parsed.slides!.length).toBeGreaterThan(0);
  expect(parsed.slides!.length).toBeLessThanOrEqual(STUDIO_LIMITS.slides);
  for (const slide of parsed.slides!) {
    expect(slide.name).toBeTruthy();
    expect(slide.widgets.length).toBeGreaterThan(0);
    expect(slideLayoutProblem(slide.widgets)).toBeNull();
    for (const widget of slide.widgets) {
      dashboardWidgetInputSchema.parse(widget);
      if (
        widget.type === "metric" ||
        widget.type === "line" ||
        widget.type === "bar"
      ) {
        // Charts have no period line: their title names the period.
        if (widget.type !== "metric") {
          expect(widget.title, "charts carry a short title").toBeTruthy();
        }
        const label = widget.title ?? autoLabel(widget, locale);
        for (const fontScale of [1, 1.3]) {
          expect(
            labelFits(
              label,
              widget as { type: WidgetType; w: number; h: number },
              { fontScale },
            ),
            `"${label}" fits ${widget.w} × ${widget.h} at ${fontScale}`,
          ).toBe(true);
        }
      }
    }
  }
  return parsed;
}

function titles(template: { slides?: TemplateDashboard["slides"] }) {
  return (template.slides ?? []).flatMap((slide) =>
    slide.widgets.map((widget) => [
      widget.type,
      "title" in widget ? (widget.title ?? null) : null,
    ]),
  );
}

function metricKeys(template: TemplateDashboard | null): string[] {
  return (template?.slides ?? []).flatMap((slide) =>
    slide.widgets.flatMap((widget) =>
      "metricKey" in widget ? [`${widget.type}:${widget.metricKey}`] : [],
    ),
  );
}

describe("Overview template", () => {
  it("is null without any connection the templates know", () => {
    expect(buildOverviewTemplate([])).toBeNull();
    expect(buildOverviewTemplate([unknown])).toBeNull();
  });

  it("shows App Store downloads, proceeds and the trend; reviews only with a reviews key", () => {
    const without = expectValid(buildOverviewTemplate([asc()]));
    expect(without.slides!.map((slide) => slide.name)).toEqual(["App Store"]);
    expect(metricKeys(without as TemplateDashboard)).toEqual([
      "metric:app_store_connect.downloads",
      "metric:app_store_connect.proceeds",
      "line:app_store_connect.downloads",
      "bar:app_store_connect.downloads",
    ]);
    const withReviews = expectValid(buildOverviewTemplate([asc("Team", true)]));
    expect(metricKeys(withReviews as TemplateDashboard)).toContain(
      "metric:app_store_connect.reviews",
    );
    // Proceeds follow the workspace's display currency (no fixed one).
    const proceeds = without.slides![0]!.widgets.find(
      (widget) =>
        "metricKey" in widget &&
        widget.metricKey === "app_store_connect.proceeds",
    )!;
    expect(
      "displayCurrency" in proceeds && proceeds.displayCurrency,
    ).toBeFalsy();
  });

  it("puts Search Console and Vercel on a second slide, only when connected", () => {
    const all = expectValid(buildOverviewTemplate([vercel, asc(), gsc]));
    expect(all.slides!.map((slide) => slide.name)).toEqual([
      "App Store",
      "Web",
    ]);
    expect(
      metricKeys(all as TemplateDashboard).filter(
        (key) => !key.includes("app_store"),
      ),
    ).toEqual([
      "metric:google-search-console.clicks",
      "metric:google-search-console.impressions",
      "metric:vercel.visitors",
      "line:google-search-console.clicks",
      "line:vercel.visitors",
    ]);
    const noVercel = expectValid(buildOverviewTemplate([gsc]));
    expect(JSON.stringify(noVercel)).not.toContain("vercel");
    expect(noVercel.slides!.map((slide) => slide.name)).toEqual(["Web"]);
    const onlyVercel = expectValid(buildOverviewTemplate([vercel]));
    expect(JSON.stringify(onlyVercel)).not.toContain("google-search-console");
  });

  it("names the connection when several of one kind are connected, and overflows to more slides", () => {
    const template = expectValid(
      buildOverviewTemplate([asc("Studio A", true), asc("Studio B", true)]),
    );
    const titles = template.slides!.flatMap((slide) =>
      slide.widgets.map((widget) => widget.title),
    );
    expect(titles).toContain("Downloads, 7 days · Studio A");
    expect(titles).toContain("Reviews, 30 days · Studio B");
    // Six metrics: four with the charts, two on a slide of their own.
    expect(template.slides!.map((slide) => slide.widgets.length)).toEqual([
      6, 2,
    ]);
  });

  it("works with the demo connection of a new workspace", () => {
    const template = expectValid(buildOverviewTemplate([demo]));
    expect(metricKeys(template as TemplateDashboard)).toEqual([
      "metric:demo.signups",
      "metric:demo.visitors",
      "line:demo.signups",
    ]);
  });
});

describe("Brand template", () => {
  const logo = crypto.randomUUID();

  it("shows one app with its icon, accent and its own numbers on two slides", () => {
    const source = asc("Team", true);
    const template = expectValid(
      buildBrandTemplate({
        source,
        resourceId: "6767935139",
        resourceName: "Wurfel – Cube Solver",
        logoImageId: logo,
        accentColor: "#4f8cff",
      }),
    );
    expect(template.name).toBe("Wurfel – Cube Solver");
    expect(template.settings).toMatchObject({
      logoImageId: logo,
      accentColor: "#4f8cff",
      showHeader: true,
    });
    expect(template.slides!.map((slide) => slide.name)).toEqual([
      "Today",
      "Trend",
    ]);
    const first = template.slides![0]!.widgets;
    expect(first[0]).toMatchObject({
      type: "image",
      imageId: logo,
      x: 0,
      y: 0,
    });
    expect(first.map((widget) => widget.type)).toEqual([
      "image",
      "metric",
      "metric",
      "metric",
      "line",
      "bar",
    ]);
    expect(first.find((widget) => widget.type === "bar")).toMatchObject({
      metricKey: "app_store_connect.downloads_by_territory",
      options: { groupBy: "territory" },
    });
    for (const widget of template.slides!.flatMap((slide) => slide.widgets)) {
      if ("metricKey" in widget) {
        expect(widget.dimensions).toEqual({ resource: "6767935139" });
        expect(widget.connectionId).toBe(source.connectionId);
      }
    }
  });

  it("leaves reviews out without a reviews key and spreads the band", () => {
    const template = expectValid(
      buildBrandTemplate({
        source: asc(),
        resourceId: "1",
        resourceName: "Paperstand",
        logoImageId: logo,
        accentColor: null,
      }),
    );
    expect(JSON.stringify(template)).not.toContain("reviews");
    const metrics = template.slides![0]!.widgets.filter(
      (widget) => widget.type === "metric",
    );
    expect(metrics.map((widget) => widget.w)).toEqual([5, 4]);
    expect(template.settings?.accentColor).toBeNull();
  });

  it("starts without a logo when there is no icon", () => {
    const template = expectValid(
      buildBrandTemplate({
        source: asc(),
        resourceId: "1",
        resourceName: "Paperstand",
        logoImageId: null,
        accentColor: null,
      }),
    );
    expect(JSON.stringify(template)).not.toContain('"image"');
    expect(template.settings?.logoImageId).toBeNull();
  });

  it("builds a Brand for a website and a Search Console property too", () => {
    for (const source of [vercel, gsc, demo]) {
      expectValid(
        buildBrandTemplate({
          source,
          resourceId: "site-1",
          resourceName: "wurfel.app",
          logoImageId: null,
          accentColor: null,
        }),
      );
    }
    expect(
      buildBrandTemplate({
        source: unknown,
        resourceId: "x",
        resourceName: "x",
        logoImageId: null,
        accentColor: null,
      }),
    ).toBeNull();
  });

  it("keeps a long app name within the dashboard name limit", () => {
    const template = expectValid(
      buildBrandTemplate({
        source: asc(),
        resourceId: "1",
        resourceName: "A".repeat(140),
        logoImageId: null,
        accentColor: null,
      }),
    );
    expect(template.name.length).toBe(100);
  });
});

describe("templates in the creator's language (#268)", () => {
  it("German has exactly the English keys and arguments", () => {
    expect(compareCatalogs(templateEn, templateDe)).toEqual([]);
  });

  it("Overview: names, slide names and chart titles in English and German; single-source metrics untitled", () => {
    const sources = [asc(), gsc, vercel];
    const en = expectValid(buildOverviewTemplate(sources), "en");
    const de = expectValid(
      buildOverviewTemplate(sources, { locale: "de" }),
      "de",
    );
    expect(en.name).toBe("Overview");
    expect(de.name).toBe("Übersicht");
    expect(en.slides!.map((slide) => slide.name)).toEqual(["App Store", "Web"]);
    expect(de.slides!.map((slide) => slide.name)).toEqual(["App Store", "Web"]);
    // Metric widgets show "Downloads · All apps" and "Last 7 days · Total"
    // in the screen language; charts name their period.
    expect(titles(en)).toEqual([
      ["metric", null],
      ["metric", null],
      ["line", "Downloads, 30 days"],
      ["bar", "Downloads by app"],
      ["metric", null],
      ["metric", null],
      ["metric", null],
      ["line", "Search clicks, 30 days"],
      ["line", "Visitors, 30 days"],
    ]);
    expect(titles(de)).toEqual([
      ["metric", null],
      ["metric", null],
      ["line", "Downloads, 30 Tage"],
      ["bar", "Downloads nach App"],
      ["metric", null],
      ["metric", null],
      ["metric", null],
      ["line", "Suchklicks, 30 Tage"],
      ["line", "Besucher, 30 Tage"],
    ]);
  });

  it("Overview keeps a name the creator gives", () => {
    expect(
      buildOverviewTemplate([asc()], { name: "Studio", locale: "de" })!.name,
    ).toBe("Studio");
  });

  it("Overview titles metrics with the connection when several of one kind are connected", () => {
    const sources = [asc("Studio A", true), asc("Studio B", true)];
    const de = expectValid(
      buildOverviewTemplate(sources, { locale: "de" }),
      "de",
    );
    const deTitles = titles(de).map(([, title]) => title);
    expect(deTitles).toContain("Downloads, 7 Tage · Studio A");
    expect(deTitles).toContain("Erlöse, 30 Tage · Studio A");
    expect(deTitles).toContain("Rezensionen, 30 Tage · Studio B");
    expect(deTitles).not.toContain(null);
  });

  it("Brand: every widget titled, slides Today/Trend in English and Heute/Verlauf in German", () => {
    const input = {
      source: asc("Team", true),
      resourceId: "6767935139",
      resourceName: "Wurfel – Cube Solver",
      logoImageId: crypto.randomUUID(),
      accentColor: null,
    };
    const en = expectValid(buildBrandTemplate(input), "en");
    const de = expectValid(
      buildBrandTemplate({ ...input, locale: "de" }),
      "de",
    );
    expect(de.name).toBe("Wurfel – Cube Solver");
    expect(en.slides!.map((slide) => slide.name)).toEqual(["Today", "Trend"]);
    expect(de.slides!.map((slide) => slide.name)).toEqual(["Heute", "Verlauf"]);
    expect(titles(en)).toEqual([
      ["image", null],
      ["metric", "Downloads, 7 days"],
      ["metric", "Proceeds, 30 days"],
      ["metric", "Reviews, 30 days"],
      ["line", "Downloads, 30 days"],
      ["bar", "Top territories"],
      ["line", "Downloads, 90 days"],
      ["line", "Proceeds, 90 days"],
    ]);
    expect(titles(de)).toEqual([
      ["image", null],
      ["metric", "Downloads, 7 Tage"],
      ["metric", "Erlöse, 30 Tage"],
      ["metric", "Rezensionen, 30 Tage"],
      ["line", "Downloads, 30 Tage"],
      ["bar", "Top-Länder"],
      ["line", "Downloads, 90 Tage"],
      ["line", "Erlöse, 90 Tage"],
    ]);
  });

  it("every template fits in every language", () => {
    const mixes: TemplateSource[][] = [
      [asc()],
      [asc("Team", true)],
      [asc("Studio A", true), asc("Studio B", true)],
      [asc("A"), asc("B"), asc("C")],
      [gsc],
      [vercel],
      [demo],
      [asc("Team", true), gsc, vercel, demo],
    ];
    for (const locale of SUPPORTED_LOCALES) {
      for (const sources of mixes) {
        expectValid(buildOverviewTemplate(sources, { locale }), locale);
      }
      for (const source of [asc("Team", true), asc(), gsc, vercel, demo]) {
        for (const logoImageId of [crypto.randomUUID(), null]) {
          expectValid(
            buildBrandTemplate({
              source,
              resourceId: "r-1",
              resourceName: "Wurfel – Cube Solver",
              logoImageId,
              accentColor: null,
              locale,
            }),
            locale,
          );
        }
      }
    }
  });
});

describe("splitWidths", () => {
  it("splits cells into whole widths, larger ones first", () => {
    expect(splitWidths(12, 4)).toEqual([3, 3, 3, 3]);
    expect(splitWidths(9, 2)).toEqual([5, 4]);
    expect(splitWidths(9, 3)).toEqual([3, 3, 3]);
    expect(splitWidths(12, 1)).toEqual([12]);
  });
});
