import { describe, expect, it } from "vitest";

import { renderI18n } from "@/lib/i18n/test-render";

import { studioUpdateNote, studioViewOnlyPath } from "@/lib/store-updates";

import { freeCells } from "./editor-canvas";
import {
  CanvasHead,
  LiveIndicator,
  StatusLine,
  StoreUpdateNote,
} from "./studio-status";

describe("studio status (design 3b)", () => {
  it("names the screens the dashboard is live on", () => {
    const html = renderI18n(
      <LiveIndicator screens={["Office wall", "Kitchen"]} />,
    );
    expect(html).toContain('class="studio-live-dot"');
    expect(html).toContain("Live on Office wall and Kitchen");
    expect(renderI18n(<LiveIndicator screens={[]} />)).toContain(
      '<span class="studio-live studio-live--off">Not on any screen</span>',
    );
    expect(renderI18n(<LiveIndicator screens={["Flur"]} />, "de")).toContain(
      "Live auf Flur",
    );
  });

  it("says what the canvas shows and whether it reads well", () => {
    const fine = renderI18n(
      <CanvasHead
        number={2}
        name="Sales"
        format="16x9"
        hasProblems={false}
        cutOff={0}
      />,
    );
    expect(fine).toContain("Slide 2 · Sales · 16:9 · 1920 × 1080 preview");
    expect(fine).toContain(">Grid ✓</span>");
    expect(fine).toContain(
      'Readable at distance: <span class="canvas-check--ok">all labels fit</span>',
    );
    const cut = renderI18n(
      <CanvasHead
        number={1}
        name={null}
        format="9x16"
        hasProblems
        cutOff={2}
      />,
    );
    expect(cut).toContain("Slide 1 · 9:16 · 1080 × 1920 preview");
    expect(cut).toContain(
      '<span class="canvas-check--warn">2 labels cut</span>',
    );
    expect(cut).toContain("Check the placement");
  });

  it("lists theme, accent, header and keyboard hints below the canvas", () => {
    const html = renderI18n(
      <StatusLine themeName="netrics Dark" accent="#e5572f" showHeader>
        <button type="button" id="clipboard" />
      </StatusLine>,
    );
    expect(html).toContain("Theme <b>netrics Dark</b>");
    expect(html).toContain("background:#e5572f");
    expect(html).toContain("Header · Clock on");
    expect(html).toContain('id="clipboard"');
    expect(html).toContain("arrows move · ⇧ resize · ⌫ delete");
    expect(
      renderI18n(
        <StatusLine themeName="Paper" accent="#000000" showHeader={false} />,
        "de",
      ),
    ).toContain("Kopfzeile · Uhr aus");
  });

  it("draws grid lines only where no widget covers the grid", () => {
    const cells = freeCells([{ x: 0, y: 0, w: 2, h: 2 }], 3, 2);
    expect(cells).toEqual([
      { x: 2, y: 0 },
      { x: 2, y: 1 },
    ]);
    expect(freeCells([], 12, 8)).toHaveLength(96);
  });
});

describe("store-template updates in the Studio (11E)", () => {
  const REQUEST = "00000000-0000-4000-8000-0000000000f1";
  const href = `/workspaces/w/dashboards/stores/updates/${REQUEST}`;
  it.each([
    [
      "en",
      "The template has an update for this dashboard.",
      "Review the update",
    ],
    ["de", "Die Vorlage hat ein Update für dieses Dashboard.", "Update prüfen"],
  ] as const)(
    "says an update is available and links to it (%s)",
    (locale, text, link) => {
      const html = renderI18n(
        <StoreUpdateNote kind="available" href={href} />,
        locale,
      );
      expect(html).toContain(text);
      expect(html).toContain(`href="${href}">${link}</a>`);
    },
  );

  it("tells an archived copy from an archived original", () => {
    const install = {
      requestId: REQUEST,
      name: "App portfolio",
      templateVersion: 2,
      latestVersion: 2,
      newerVersion: true,
      updateAvailable: true,
      summary: null,
      error: null,
      dashboardIds: ["original"],
      modelIds: [],
      preparationIds: [],
      openUpdate: null,
      lastUpdate: {
        id: "00000000-0000-4000-8000-0000000000e1",
        requestId: REQUEST,
        fromVersion: 1,
        toVersion: 2,
        createdAt: "2026-11-14T10:00:00.000Z",
        drafts: [],
        dashboards: [
          {
            key: "dashboard:portfolio",
            originalId: "original",
            copyId: "copy",
            swappedAt: "2026-11-14T11:00:00.000Z",
            swappedBackAt: "2026-11-14T12:00:00.000Z",
            ready: false,
          },
        ],
      },
    };
    const archivedAt = "2026-11-14T12:00:00.000Z";
    expect(studioUpdateNote([install], { id: "copy", archivedAt })).toEqual({
      kind: "archivedCopy",
      requestId: REQUEST,
    });
    expect(studioUpdateNote([install], { id: "original", archivedAt })).toEqual(
      { kind: "archived", requestId: REQUEST },
    );
    const copy = renderI18n(
      <StoreUpdateNote kind="archivedCopy" href={href} />,
    );
    expect(copy).toContain(
      "This updated copy is archived because you switched back. Swap it in again from the update page.",
    );
    expect(
      renderI18n(<StoreUpdateNote kind="archivedCopy" href={href} />, "de"),
    ).toContain("Diese aktualisierte Kopie ist archiviert");
  });

  it("keeps an archived original out of the Studio: it opens read-only", () => {
    const dashboard = { id: "d1", archivedAt: null };
    expect(studioViewOnlyPath("w", dashboard)).toBeNull();
    expect(
      studioViewOnlyPath("w", {
        ...dashboard,
        archivedAt: "2026-11-14T10:00:00.000Z",
      }),
    ).toBe("/workspaces/w/dashboards/d1");
  });

  it("marks the updated copy and an archived original", () => {
    expect(renderI18n(<StoreUpdateNote kind="copy" href={href} />)).toContain(
      "This is the updated copy.",
    );
    const archived = renderI18n(
      <StoreUpdateNote kind="archived" href={href} />,
    );
    expect(archived).toContain("Archived while its updated copy");
    expect(archived).toContain(">Open the update</a>");
  });
});
