import { afterEach, describe, expect, it, vi } from "vitest";

import type { Locale } from "@netrics/domain";

import {
  AppShellFrame,
  ProjectSwitchError,
  switchProject,
  type AppShellProps,
} from "./app-shell";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const W = "w1";
const BASE = `/workspaces/${W}`;

function render(
  pathname: string,
  overrides: Partial<AppShellProps> = {},
  locale: Locale = "en",
): string {
  return renderI18n(
    <AppShellFrame
      pathname={pathname}
      workspaceId={W}
      workspaces={[
        { id: W, name: "Acme" },
        { id: "w2", name: "Wurfel" },
      ]}
      userName="Florian"
      permissions={{ viewDevices: true, createConnections: true }}
      sourceCount={3}
      attention={0}
      projects={[]}
      activeProjectId={null}
      {...overrides}
    >
      <p id="page">page</p>
    </AppShellFrame>,
    locale,
  );
}

/** The sidebar's area links (href and aria-current) in order. */
function sidebarLinks(html: string): [string, string | null][] {
  const nav = html.slice(
    html.indexOf('<nav class="shell-nav"'),
    html.indexOf("</nav>"),
  );
  return [...nav.matchAll(/<a ([^>]*)>/g)].map(([, attributes = ""]) => [
    /href="([^"]*)"/.exec(attributes)?.[1] ?? "",
    /aria-current="([^"]*)"/.exec(attributes)?.[1] ?? null,
  ]);
}

const A = "00000000-0000-4000-8000-0000000000aa";
const B = "00000000-0000-4000-8000-0000000000bb";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("project switcher (#573)", () => {
  it("switches the active project and refreshes", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ activeProjectId: A }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const refresh = vi.fn();
    await expect(switchProject(W, A, refresh)).resolves.toBe("switched");
    expect(fetch).toHaveBeenCalledWith(
      `/v1/workspaces/${W}/active-project`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ projectId: A }),
      }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    [409, "project_archived", "archived"],
    [503, "unavailable", "failed"],
  ] as const)(
    "refreshes after a failed switch (%i %s) so the page shows what is stored",
    async (status, error, outcome) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error }), {
              status,
              headers: { "content-type": "application/json" },
            }),
        ),
      );
      const refresh = vi.fn();
      await expect(switchProject(W, A, refresh)).resolves.toBe(outcome);
      expect(refresh).toHaveBeenCalledOnce();
    },
  );

  it("marks the switcher busy, not disabled, while switching", () => {
    const html = render(BASE, {
      projects: [{ id: A, name: "Alpha" }],
      activeProjectId: null,
    });
    expect(html).toContain('aria-busy="false"');
    expect(html).not.toMatch(/<select[^>]*disabled/);
  });

  it("has a message for a project archived meanwhile", () => {
    expect(
      renderI18n(<ProjectSwitchError outcome="archived" />, "en"),
    ).toContain("This project has been archived and can’t be chosen.");
    expect(
      renderI18n(<ProjectSwitchError outcome="archived" />, "de"),
    ).toContain("Dieses Projekt ist archiviert und kann nicht gewählt werden.");
    expect(renderI18n(<ProjectSwitchError outcome="failed" />, "en")).toContain(
      "Could not switch the project. Try again.",
    );
  });

  it("offers All projects and the projects, the active one selected", () => {
    const html = render(BASE, {
      projects: [
        { id: A, name: "Alpha" },
        { id: B, name: "Beta" },
      ],
      activeProjectId: B,
    });
    expect(html).toContain(">Project</label>");
    expect(html).toContain('<option value="">All projects</option>');
    expect(html).toContain(`<option value="${A}">Alpha</option>`);
    expect(html).toContain(`<option value="${B}" selected="">Beta</option>`);
    const all = render(BASE, {
      projects: [{ id: A, name: "Alpha" }],
      activeProjectId: null,
    });
    expect(all).toContain('<option value="" selected="">All projects</option>');
  });

  it("hides the switcher without projects", () => {
    const html = render(BASE);
    expect(html).not.toContain(">Project</label>");
    expect(html).not.toContain("All projects");
  });

  it("speaks German", () => {
    const html = render(
      BASE,
      { projects: [{ id: A, name: "Alpha" }], activeProjectId: null },
      "de",
    );
    expect(html).toContain(">Projekt</label>");
    expect(html).toContain(">Alle Projekte</option>");
  });
});

describe("app shell (#302)", () => {
  it("lists only existing destinations with their routes", () => {
    const html = render(`${BASE}/screens`);
    expect(sidebarLinks(html).map(([href]) => href)).toEqual([
      BASE,
      `${BASE}/dashboards`,
      `${BASE}/goals`,
      `${BASE}/settings/themes`,
      `${BASE}/sources`,
      `${BASE}/connections/new`,
      `${BASE}/screens`,
      `${BASE}/team`,
      `${BASE}/settings`,
    ]);
    for (const missing of [
      "Playlists",
      "Schedules",
      "Alerts",
      "Templates",
      "Images",
      "Marketplace",
      "Custom API",
    ]) {
      expect(html).not.toContain(missing);
    }
    for (const label of [
      "Home",
      "Dashboards",
      "All dashboards",
      "Goals",
      "Themes",
      "Sources",
      "Connected",
      "Add source",
      "Screens",
      "All screens",
      "Team",
      "Settings",
    ]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('<nav class="shell-nav" aria-label="Workspace">');
    expect(html).toContain('<p id="page">page</p>');
  });

  it("marks the current page and the area of pages below it", () => {
    expect(sidebarLinks(render(`${BASE}/screens`))).toContainEqual([
      `${BASE}/screens`,
      "page",
    ]);
    const studio = sidebarLinks(render(`${BASE}/dashboards/d1`));
    expect(studio).toContainEqual([`${BASE}/dashboards`, "true"]);
    expect(studio.filter(([, current]) => current !== null)).toHaveLength(1);
    expect(sidebarLinks(render(`${BASE}/connections/c1`))).toContainEqual([
      `${BASE}/sources`,
      "true",
    ]);
    expect(sidebarLinks(render(`${BASE}/settings/themes`))).toContainEqual([
      `${BASE}/settings/themes`,
      "page",
    ]);
    expect(sidebarLinks(render(`${BASE}/goals`))).toContainEqual([
      `${BASE}/goals`,
      "page",
    ]);
    expect(sidebarLinks(render(BASE))).toContainEqual([BASE, "page"]);
  });

  it("hides areas the role cannot open", () => {
    const hrefs = sidebarLinks(
      render(BASE, {
        permissions: { viewDevices: false, createConnections: false },
      }),
    ).map(([href]) => href);
    expect(hrefs).not.toContain(`${BASE}/screens`);
    expect(hrefs).not.toContain(`${BASE}/connections/new`);
  });

  it("lists the user's workspaces in the switcher", () => {
    const html = render(BASE);
    expect(html).toContain('aria-label="Switch workspace (current: Acme)"');
    expect(html).toContain(
      `class="shell-menu-item" aria-current="true" href="${BASE}"`,
    );
    expect(html).toContain(`class="shell-menu-item" href="/workspaces/w2"`);
    expect(html).toContain(">Wurfel<");
    expect(html).toContain('href="/?new=1"');
    expect(html).toContain("New workspace");
  });

  it("summarises source health in the top bar", () => {
    const fresh = render(BASE);
    expect(fresh).toContain("All sources fresh");
    expect(fresh).toContain("source-health--fresh");
    expect(fresh).not.toContain("shell-attention-dot");

    const one = render(BASE, { attention: 1 });
    expect(one).toContain("1 source needs attention");
    const two = render(BASE, { attention: 2 });
    expect(two).toContain("2 sources need attention");
    expect(two).toContain("source-health--attention");
    expect(two).toContain(
      `class="source-health source-health--attention" href="${BASE}/sources"`,
    );
    // The warning dot on Connected.
    expect(two).toContain('aria-label="needs attention"');

    expect(render(BASE, { sourceCount: 0 })).toContain("No sources yet");
  });

  it("has the account menu", () => {
    const html = render(BASE);
    expect(html).toContain('aria-label="Account menu for Florian"');
    expect(html).toContain('href="/settings/account"');
    expect(html).toContain('href="/status"');
    expect(html).toContain("Sign out");
    expect(html).toContain('aria-controls="shell-sidebar"');
  });

  it("collapses to the icon rail in the Studio", () => {
    const html = render(`${BASE}/dashboards/d1/studio`, { attention: 1 });
    expect(html).toContain("app-shell--rail");
    expect(html).not.toContain("shell-sidebar");
    expect(html).not.toContain("shell-topbar");
    expect(html).toContain('<nav aria-label="Workspace areas">');
    expect(html).toMatch(
      new RegExp(
        `class="shell-rail-button" aria-label="Dashboards" title="Dashboards" aria-current="true" href="${BASE}/dashboards"`,
      ),
    );
    for (const label of ["Home", "Sources", "Screens", "Team", "Settings"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('<p id="page">page</p>');
  });

  it("shows no chrome in TV mode", () => {
    const html = render(`${BASE}/dashboards/d1/tv`);
    expect(html).toBe('<p id="page">page</p>');
  });

  it("speaks German", () => {
    const html = render(BASE, { attention: 2 }, "de");
    for (const text of [
      "Alle Dashboards",
      "Designs",
      "Quellen",
      "Verbunden",
      "Quelle hinzufügen",
      "Alle Bildschirme",
      "Einstellungen",
      "2 Quellen brauchen Aufmerksamkeit",
      "Neuer Workspace",
      "Kontoeinstellungen",
      "Abmelden",
    ]) {
      expect(html).toContain(text);
    }
    for (const english of ["All dashboards", "Add source", "Sign out"]) {
      expect(html).not.toContain(english);
    }
    expect(render(BASE, {}, "de")).toContain("Alle Quellen aktuell");
  });
});
