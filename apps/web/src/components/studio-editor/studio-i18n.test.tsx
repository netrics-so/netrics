import { describe, expect, it, vi } from "vitest";

import type {
  Dashboard,
  DashboardWidget,
  WorkspaceMetric,
} from "@netrics/contracts";
import { BUILTIN_THEMES, type Locale } from "@netrics/domain";

import { MetricWidgetView } from "@/components/studio/metric-widget";
import { TileView } from "@/components/tile-view";
import { renderI18n } from "@/lib/i18n/test-render";
import {
  createStudioReducer,
  documentProblems,
  initialStudioState,
} from "@/lib/studio-document";

import { SlideRail } from "./slide-rail";
import { WidgetPanel } from "./widget-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

// Dashboards and the Studio in English and German (#253, ADR 0016).

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noop = () => undefined;
const dark = BUILTIN_THEMES.netrics_dark.tokens;

const series = [10, 14, 12, 18, 22, 21, 25].map((value, index) => ({
  bucket: `2026-09-${String(index + 20)}T00:00:00.000Z`,
  value,
}));

function metricWidget(locale: Locale) {
  return renderI18n(
    <MetricWidgetView
      label="Downloads · Wurfel"
      period="last_7_days"
      aggregation="sum"
      metric={{ kind: "counter", granularity: "day", better: "higher" }}
      reading={{
        value: 12_900,
        unit: "count",
        delta: 1_234.5,
        ratio: 0.034,
        series,
        timeZone: "UTC",
      }}
      notice={null}
      source={null}
      placement={{ x: 0, y: 0, w: 6, h: 4 }}
      showHeader
      fontScale={1}
      options={{ showSparkline: true, showChange: true }}
    />,
    locale,
  );
}

describe("widgets in German", () => {
  it("label periods and comparisons and format numbers in the language", () => {
    const en = metricWidget("en");
    expect(en).toContain("Last 7 days · Total");
    expect(en).toContain(">12.9K</p>");
    expect(en).toContain("vs previous 7 days");

    const de = metricWidget("de");
    expect(de).toContain("Letzte 7 Tage · Summe");
    expect(de).toContain(">12,9 Tsd.</p>");
    expect(de).toContain("+3,4%");
    expect(de).toContain("vs. vorherige 7 Tage");
    expect(de).toContain('aria-label="Verlauf von 10 bis 25, zuletzt 25');
    expect(de).not.toContain("Last 7 days");
  });

  it("word a tile without data", () => {
    const tile = (locale: Locale) =>
      renderI18n(
        <TileView
          label="Clicks"
          period="today"
          aggregation="sum"
          reading={{
            value: 1234.5,
            unit: "seconds",
            delta: null,
            ratio: null,
            series: [],
            timeZone: "UTC",
          }}
          fallback={null}
          footer={null}
        />,
        locale,
      );
    expect(tile("en")).toContain("No data to compare vs yesterday");
    expect(tile("de")).toContain("Keine Daten zum Vergleich (vs. gestern)");
    expect(tile("de")).toContain("1.235");
  });
});

const downloads = {
  connectionId: ID(9),
  connectionName: "App Store",
  key: "downloads",
  name: "Downloads",
  description: "Erstmalige Downloads.",
  kind: "counter",
  unit: "count",
  granularity: "day",
  dimensions: ["resource", "territory"],
  dimensionNames: { territory: "Land" },
  aggregations: ["sum", "avg"],
  better: "higher",
  role: "primary",
} as WorkspaceMetric;

const widget: DashboardWidget = {
  type: "metric",
  id: ID(11),
  x: 0,
  y: 0,
  w: 4,
  h: 3,
  title: null,
  connectionId: ID(9),
  metricKey: "downloads",
  aggregation: "sum",
  period: "last_30_days",
  dimensions: {},
  displayCurrency: null,
  resourceName: null,
  allResourcesName: "Alle Apps",
  options: { showSparkline: true, showChange: false },
};

describe("the Studio in German", () => {
  it("labels the widget panel", () => {
    const html = renderI18n(
      <WidgetPanel
        widget={widget}
        workspaceId={ID(3)}
        metrics={[downloads]}
        images={[]}
        problems={[]}
        timeZone="Europe/Berlin"
        dispatch={noop}
      />,
      "de",
    );
    expect(html).toContain(">Metrik</h2>");
    expect(html).toContain("Sp. 1, Z. 1 · 4×3");
    expect(html).toContain('<label for="widget-connection">Verbindung</label>');
    expect(html).toContain('<option value="avg">Mittelwert</option>');
    expect(html).toContain(
      '<option value="last_90_days">Letzte 90 Tage</option>',
    );
    expect(html).toContain(
      "Angezeigt als <strong>Downloads · Alle Apps</strong>",
    );
    expect(html).toContain("Downloads (pro Land)");
    expect(html).toContain('<label for="widget-filter-territory">Land</label>');
    expect(html).toContain(">Widget löschen</button>");
    expect(html).not.toMatch(/>(Connection|Period|Delete widget)</);
  });

  it("labels the slide rail", () => {
    const rail = (locale: Locale) =>
      renderI18n(
        <SlideRail
          slides={[
            {
              id: ID(2),
              name: null,
              durationSeconds: null,
              enabled: false,
              background: null,
              widgets: [widget],
            },
          ]}
          selectedSlideId={ID(2)}
          tokens={dark}
          defaultSeconds={20}
          slidesWithProblems={new Set([ID(2)])}
          unreadableCounts={new Map([[ID(2), 2]])}
          dispatch={noop}
        />,
        locale,
      );
    const en = rail("en");
    expect(en).toContain(
      'aria-label="1 of 1: Slide 1, 20 seconds, hidden on screens, has problems, 2 widgets cut off on TVs"',
    );
    const de = rail("de");
    expect(de).toContain(">Folien</h2>");
    expect(de).toContain('aria-label="Folie hinzufügen"');
    expect(de).toContain(
      'aria-label="1 von 1: Folie 1, 20 Sekunden, auf Bildschirmen ausgeblendet, hat Probleme, 2 Widgets auf TVs abgeschnitten"',
    );
    expect(de).toContain("2 Widgets abgeschnitten");
  });

  it("announces edits and finds problems in the editor's language", () => {
    const dashboard = {
      id: ID(1),
      workspaceId: ID(3),
      projectId: null,
      name: "",
      version: 1,
      settings: {
        showHeader: true,
        autoAdvance: true,
        defaultSlideSeconds: 20,
        transition: "fade",
        themeBuiltin: "netrics_dark",
        themeId: null,
        accentColor: null,
        logoImageId: null,
      },
      slides: [
        {
          id: ID(2),
          position: 0,
          name: null,
          durationSeconds: null,
          enabled: true,
          background: null,
          widgets: [widget],
        },
      ],
    } as unknown as Dashboard;
    let n = 100;
    const reducer = createStudioReducer(() => ID(n++));
    const de = reducer(initialStudioState(dashboard, "de"), {
      type: "addSlide",
    });
    expect(de.announcement?.text).toBe("Folie 2 hinzugefügt.");
    const moved = reducer(de, {
      type: "nudgeWidget",
      widgetId: ID(11),
      dx: -1,
      dy: 0,
    });
    expect(moved.announcement?.text).toBe(
      "Metrik kann nicht weiter in diese Richtung.",
    );
    expect(documentProblems(de.draft, "de")[0]?.message).toBe(
      "Das Dashboard braucht einen Namen.",
    );
    const en = reducer(initialStudioState(dashboard, "en"), {
      type: "addSlide",
    });
    expect(en.announcement?.text).toBe("Slide 2 added.");
  });
});
