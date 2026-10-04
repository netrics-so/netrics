import { describe, expect, it, vi } from "vitest";

import { renderI18n } from "@/lib/i18n/test-render";

import { CreateDashboardForm } from "../create-dashboard-form";
import { thumbnailFrame } from "./dashboard-thumbnail";
import {
  DashboardsBrowser,
  filterByProject,
  type DashboardCardData,
} from "./dashboards-browser";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-0000000000aa";

function card(overrides: Partial<DashboardCardData> = {}): DashboardCardData {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    name: "Office wall",
    projectId: null,
    version: 1,
    tileCount: 2,
    slideCount: 3,
    widgetCount: 2,
    updatedAt: "2026-10-04T10:00:00.000Z",
    theme: { builtin: "netrics_dark", id: null, name: "netrics Dark" },
    accent: "#e5572f",
    primaryFormat: "16x9",
    screenCount: 2,
    preview: {
      background: "#07090c",
      surface: "#11141a",
      border: "#23272e",
      widgets: [
        { type: "metric", x: 0, y: 0, w: 3, h: 2 },
        { type: "line", x: 6, y: 4, w: 6, h: 4 },
      ],
    },
    updatedLabel: "updated 2 minutes ago",
    themeLabel: "netrics Dark",
    ...overrides,
  };
}

function render(
  props: Partial<Parameters<typeof DashboardsBrowser>[0]> = {},
  locale: "en" | "de" = "en",
) {
  return renderI18n(
    <DashboardsBrowser
      workspaceId={WORKSPACE}
      dashboards={[card()]}
      projects={[]}
      canCreate
      canEdit
      title="Dashboards"
      meta="1 dashboard"
      {...props}
    />,
    locale,
  );
}

describe("dashboards page (#304)", () => {
  it("shows a card with thumbnail, slides pill, accent, chips and links", () => {
    const html = render();
    expect(html).toContain('class="dash-thumb"');
    expect(html).toContain("--thumb-bg:#07090c");
    // Widget stubs at their grid places on the 12 × 8 grid.
    expect(html).toContain(
      'class="dash-thumb-stub dash-thumb-stub--metric" style="left:0%;top:0%;width:25%;height:25%"',
    );
    expect(html).toContain("left:50%;top:50%;width:50%;height:50%");
    expect(html).toContain(">3 slides<");
    expect(html).toContain("background:#e5572f");
    expect(html).toContain("updated 2 minutes ago");
    expect(html).toContain('class="dash-chip dash-chip--shown">On 2 screens<');
    expect(html).toContain('dash-chip--theme" title="Theme: netrics Dark"');
    expect(html).toContain(
      `href="/workspaces/${WORKSPACE}/dashboards/00000000-0000-4000-8000-000000000010"`,
    );
    expect(html).toContain('aria-label="Open Office wall in Studio"');
  });

  it("says when a dashboard is not shown, and hides the Studio for viewers", () => {
    const html = render({
      dashboards: [card({ screenCount: 0, slideCount: 1 })],
      canEdit: false,
      canCreate: false,
    });
    expect(html).toContain('class="dash-chip dash-chip--hidden">Not shown<');
    expect(html).toContain(">1 slide<");
    expect(html).not.toContain("dash-card-studio");
    // Viewers get neither templates nor "New dashboard".
    expect(html).not.toContain("dashboards-templates");
    expect(html).not.toContain("dashboards-new");
  });

  it("offers the existing templates and a dashed Blank", () => {
    const html = render();
    expect(html).toContain("Start from a template");
    const order = [
      "dashboards-template--overview",
      "dashboards-template--brand",
      "dashboards-template--blank",
    ].map((name) => html.indexOf(name));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('aria-label="Start with Overview"');
    expect(html).not.toContain("SEO");
    expect(html).toContain("+</span> New dashboard");
  });

  it("filters by project only when there are projects", () => {
    expect(render()).not.toContain("All projects");
    const html = render({ projects: [{ id: PROJECT, name: "Wurfel" }] });
    expect(html).toContain(
      '<option value="" selected="">All projects</option>',
    );
    expect(html).toContain(`<option value="${PROJECT}">Wurfel</option>`);
    // The one dashboard has no project, so that choice is offered too.
    expect(html).toContain('<option value="none">No project</option>');
  });

  it("filters dashboards by project", () => {
    const list = [
      { id: "a", projectId: PROJECT },
      { id: "b", projectId: null },
    ];
    expect(filterByProject(list, "").map((d) => d.id)).toEqual(["a", "b"]);
    expect(filterByProject(list, PROJECT).map((d) => d.id)).toEqual(["a"]);
    expect(filterByProject(list, "none").map((d) => d.id)).toEqual(["b"]);
  });

  it("has a friendly empty state", () => {
    const html = render({ dashboards: [] });
    expect(html).toContain("No dashboards yet");
    expect(html).toContain("Start from a template above.");
    expect(html).toContain("dashboards-template--overview");
    expect(render({ dashboards: [], canCreate: false })).toContain(
      "Nobody has made a dashboard",
    );
  });

  it("speaks German", () => {
    const html = render(
      { dashboards: [card({ screenCount: 1 })], projects: [] },
      "de",
    );
    expect(html).toContain("Mit einer Vorlage starten");
    expect(html).toContain(">3 Folien<");
    expect(html).toContain(">Auf 1 Bildschirm<");
    expect(html).toContain(">Im Studio öffnen<");
  });

  it("fits other formats into the 16:9 thumbnail", () => {
    expect(thumbnailFrame("16x9")).toEqual({ width: 100, height: 100 });
    expect(thumbnailFrame("9x16").height).toBe(100);
    expect(thumbnailFrame("9x16").width).toBeCloseTo(31.64, 1);
    expect(thumbnailFrame("21x9").width).toBe(100);
    expect(thumbnailFrame("21x9").height).toBeCloseTo(76.19, 1);
    const html = render({
      dashboards: [card({ primaryFormat: "9x16" })],
    });
    expect(html).toContain('data-format="9x16"');
    // 6 columns × 14 rows: a 3 × 2 widget at the origin.
    expect(html).toContain("left:0%;top:0%;width:50%;height:14.28");
  });
});

describe("create form preselection (#304)", () => {
  it("starts with the template chosen on the page", () => {
    const html = renderI18n(
      <CreateDashboardForm workspaceId={WORKSPACE} initialChoice="overview" />,
    );
    expect(html).toMatch(/checked="" value="overview"/);
    expect(html).not.toMatch(/checked="" value="blank"/);
    // Templates are 16:9; the format choice is for blank dashboards.
    expect(html).not.toContain('name="primary-format"');
    const blank = renderI18n(<CreateDashboardForm workspaceId={WORKSPACE} />);
    expect(blank).toMatch(/checked="" value="blank"/);
    expect(blank).toContain('name="primary-format"');
  });
});
