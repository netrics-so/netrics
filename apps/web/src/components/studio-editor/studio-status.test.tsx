import { describe, expect, it } from "vitest";

import { renderI18n } from "@/lib/i18n/test-render";

import { freeCells } from "./editor-canvas";
import { CanvasHead, LiveIndicator, StatusLine } from "./studio-status";

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
