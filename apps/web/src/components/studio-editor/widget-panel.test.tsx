import { describe, expect, it } from "vitest";

import type { DashboardWidget, WorkspaceMetric } from "@netrics/contracts";

import { ImageLibrary } from "./image-picker";
import {
  TextPreview,
  WidgetPanel,
  type WidgetPanelProps,
} from "./widget-panel";
import { renderI18n } from "@/lib/i18n/test-render";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noop = () => undefined;

const downloads = {
  connectionId: ID(9),
  connectionName: "App Store",
  key: "downloads",
  name: "Downloads",
  description: "First-time downloads.",
  kind: "counter",
  unit: "count",
  granularity: "day",
  dimensions: ["resource", "territory"],
  aggregations: ["sum", "avg"],
  better: "higher",
  role: "primary",
} as WorkspaceMetric;
const proceeds = {
  ...downloads,
  key: "proceeds",
  name: "Proceeds",
  unit: "currency_minor",
  dimensions: ["resource", "currency"],
  aggregations: ["sum"],
} as WorkspaceMetric;
const rating = {
  ...downloads,
  key: "rating",
  name: "Average rating",
  kind: "gauge",
  dimensions: [],
  aggregations: ["last"],
} as WorkspaceMetric;

const binding = {
  title: null,
  connectionId: ID(9),
  metricKey: "downloads",
  aggregation: "sum" as const,
  period: "last_30_days" as const,
  dimensions: {},
  displayCurrency: null,
  resourceName: null,
  allResourcesName: "All apps",
};

const place = { x: 0, y: 0, w: 4, h: 3 };

function render(
  widget: DashboardWidget,
  extra: Partial<WidgetPanelProps> = {},
) {
  return renderI18n(
    <WidgetPanel
      widget={widget}
      workspaceId={ID(3)}
      metrics={[downloads, proceeds, rating]}
      images={[
        {
          id: ID(50),
          name: "wurfel.png",
          url: "/v1/x",
          width: 512,
          height: 512,
        },
      ]}
      problems={[]}
      timeZone="Europe/Berlin"
      currency={{ displayCurrency: "EUR", convertible: ["EUR", "USD"] }}
      dispatch={noop}
      {...extra}
    />,
  );
}

describe("widget panel", () => {
  it("binds a metric widget to a connection, metric, aggregation and period", () => {
    const html = render({
      type: "metric",
      id: ID(11),
      ...place,
      ...binding,
      options: { showSparkline: true, showChange: false },
    });
    expect(html).toContain('<label for="widget-type">Type</label>');
    expect(html).toContain('<label for="widget-connection">Connection</label>');
    expect(html).toContain('<label for="widget-metric">Metric</label>');
    expect(html).toContain("Downloads (per territory)");
    expect(html).toContain('<option value="avg">Average</option>');
    expect(html).toContain(
      '<option value="last_90_days">Last 90 days</option>',
    );
    // Periods to date sit before the rolling period of their length.
    expect(html).toMatch(
      /value="this_week">This week<\/option><option value="last_7_days">/,
    );
    expect(html).toContain(
      '<option value="this_quarter">This quarter</option>',
    );
    expect(html).toContain('<option value="this_year">This year</option>');
    expect(html).toContain("Shown as <strong>Downloads · All apps</strong>");
    expect(html).toContain('placeholder="Downloads · All apps"');
    expect(html).toContain("Sparkline");
    expect(html).toMatch(/<input type="checkbox" checked=""\/>Sparkline/);
    expect(html).toMatch(
      /<input type="checkbox"\/>Change against the previous period/,
    );
    // The other dimension can be filtered; the description helps.
    expect(html).toContain(
      '<label for="widget-filter-territory">Territory</label>',
    );
    expect(html).toContain("First-time downloads.");
    // A gauge without dimensions cannot become a bar: the type says why.
    expect(html).not.toContain("cannot be broken down");
  });

  it("offers currencies for amounts: workspace, converted or exact", () => {
    const html = render({
      type: "metric",
      id: ID(11),
      ...place,
      ...binding,
      metricKey: "proceeds",
      dimensions: { currency: "JPY" },
      options: { showSparkline: true, showChange: true },
    });
    expect(html).toContain('<label for="widget-currency">Currency</label>');
    expect(html).toContain("Workspace: converted to EUR (≈)");
    expect(html).toContain(
      '<option value="convert:USD">Converted to USD</option>',
    );
    expect(html).toContain('<option value="only:JPY" selected="">JPY</option>');
  });

  it("groups a bar by the metric's dimensions with a bar count", () => {
    const html = render({
      type: "bar",
      id: ID(11),
      ...place,
      ...binding,
      options: { groupBy: "territory", limit: 7 },
    });
    expect(html).toContain('<label for="widget-group-by">Group by</label>');
    expect(html).toContain('<option value="resource">Resource</option>');
    expect(html).toContain(
      '<option value="territory" selected="">Territory</option>',
    );
    expect(html).toContain("Bars shown: 7");
    // It does not filter on what it groups by.
    expect(html).not.toContain("widget-filter-territory");
    // Only metrics that can be broken down are listed.
    expect(html).not.toContain("Average rating");
  });

  it("toggles the previous period and axis of a line", () => {
    const html = render({
      type: "line",
      id: ID(11),
      ...place,
      ...binding,
      options: { showPrevious: false, showAxis: true },
    });
    expect(html).toMatch(/<input type="checkbox"\/>Previous period \(dashed\)/);
    expect(html).toMatch(/<input type="checkbox" checked=""\/>Axis labels/);
  });

  it("warns when the title would be cut on a TV", () => {
    const html = render({
      type: "metric",
      id: ID(11),
      ...place,
      w: 3,
      ...binding,
      title:
        "Downloads of every app in every territory over the whole period, combined",
      options: { showSparkline: true, showChange: true },
    });
    expect(html).toContain("would be cut");
  });

  it("edits a clock's time zone, hours and date", () => {
    const html = render({
      type: "clock",
      id: ID(11),
      x: 0,
      y: 0,
      w: 2,
      h: 1,
      title: null,
      options: { showDate: false, hour12: true, timeZone: "America/New_York" },
    });
    expect(html).toContain(
      '<option value="">Workspace (Europe/Berlin)</option>',
    );
    expect(html).toContain(
      '<option value="America/New_York" selected="">America/New York</option>',
    );
    expect(html).toContain('<option value="12" selected="">');
    expect(html).toMatch(/<input type="checkbox"\/>Date/);
    expect(html).not.toContain("widget-connection");
  });

  it("counts a text's characters and previews it without HTML", () => {
    const html = render({
      type: "text",
      id: ID(11),
      x: 0,
      y: 0,
      w: 4,
      h: 2,
      title: null,
      text: "## Wurfel\n**Daily** <b>numbers</b>",
      options: { size: "heading", align: "center" },
    });
    expect(html).toContain("34/500 characters");
    expect(html).toContain(
      '<option value="heading" selected="">Heading</option>',
    );
    expect(html).toContain(
      '<option value="center" selected="">Centre</option>',
    );
    const preview = renderI18n(
      <TextPreview text={"## Wurfel\n**Daily** <b>numbers</b>"} />,
    );
    expect(preview).toContain("<h4><span>Wurfel</span></h4>");
    expect(preview).toContain("<strong>Daily</strong>");
    expect(preview).toContain("&lt;b&gt;numbers&lt;/b&gt;");
  });

  it("picks an image with fit and alignment and lists the library", () => {
    const html = render(
      {
        type: "image",
        id: ID(11),
        x: 0,
        y: 0,
        w: 2,
        h: 2,
        title: null,
        imageId: ID(50),
        options: { fit: "cover", align: "start" },
      },
      {
        onUploadImage: async () => null,
        onDeleteImage: async () => null,
      },
    );
    expect(html).toContain('<label for="widget-image">Image</label>');
    expect(html).toContain("drop one here");
    expect(html).toContain(
      '<option value="cover" selected="">Fill the widget, cropped (cover)</option>',
    );
    expect(html).toContain("Workspace images (1)");
  });

  it("heads the panel with the type and the place on the grid (design 3b)", () => {
    const html = render({
      type: "metric",
      id: ID(11),
      ...place,
      ...binding,
      options: { showSparkline: true, showChange: false },
    });
    expect(html).toContain(
      '<h2 id="inspector-widget">Metric</h2><span class="inspector-head-meta">col 1, row 1 · 4×3</span>',
    );
    // The source with its colour square; period and aggregation side by side.
    expect(html).toMatch(
      /<span class="field-swatch-row"><span class="field-swatch" aria-hidden="true"><\/span><select id="widget-connection"/,
    );
    expect(html).toMatch(
      /<div class="field-pair"><div class="field"><label for="widget-period">/,
    );
  });

  it("shows filters as removable chips with + add", () => {
    const html = render({
      type: "metric",
      id: ID(11),
      ...place,
      ...binding,
      dimensions: { territory: "DE" },
      options: { showSparkline: true, showChange: false },
    });
    expect(html).toContain('<span class="filter-chip">Territory = DE');
    expect(html).toContain('aria-label="Remove the filter on Territory"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">+ add</button>");
    // The pickers wait for + add while a filter is set.
    expect(html).not.toContain("widget-filter-territory");
  });

  it("says at its foot whether the label fits at 1080p", () => {
    const metric = {
      type: "metric" as const,
      id: ID(11),
      ...place,
      ...binding,
      options: { showSparkline: true, showChange: false },
    };
    expect(render(metric)).toMatch(
      /<p class="fit-check fit-check--fits"><span aria-hidden="true">✓<\/span> Label fits at 1080p · value \d+ px<\/p>/,
    );
    const cut = render(metric, {
      unreadable: {
        kind: "label",
        slideId: ID(2),
        widgetId: ID(11),
        label: "Downloads",
        fit: { fits: false, titleLines: 3, resourceLines: 1 },
        fitsAtWidth: 6,
        hint: "Make it 6 cells wide.",
      },
    });
    expect(cut).toContain(
      'class="fit-check fit-check--cut" role="status"><span aria-hidden="true">⚠</span> Make it 6 cells wide.',
    );
    expect(
      render({
        type: "clock",
        id: ID(12),
        ...place,
        title: null,
        options: { timeZone: null, hour12: false, showDate: false },
      } as DashboardWidget),
    ).not.toContain("fit-check");
  });

  it("never offers to delete an image the draft uses", () => {
    const html = renderI18n(
      <ImageLibrary
        images={[
          { id: ID(50), name: "logo.png", url: "/v1/a", width: 1, height: 1 },
          { id: ID(51), name: "old.png", url: "/v1/b", width: 1, height: 1 },
        ]}
        inUse={new Set([ID(50)])}
        onDelete={async () => null}
      />,
    );
    expect(html).toMatch(
      /disabled="" title="Used by this dashboard" aria-label="Delete image logo.png"/,
    );
    expect(html).toMatch(
      /<button type="button" class="danger" aria-label="Delete image old.png"/,
    );
  });
});
