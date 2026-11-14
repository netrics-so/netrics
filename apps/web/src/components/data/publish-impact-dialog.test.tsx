import { describe, expect, it, vi } from "vitest";
import type { DataImpact } from "@netrics/contracts";
import { renderI18n } from "@/lib/i18n/test-render";
import {
  PublishImpactDialog,
  publishAfterConfirmation,
} from "./publish-impact-dialog";

const P = "00000000-0000-4000-8000-000000000001";
const M = "00000000-0000-4000-8000-000000000011";
const D = "00000000-0000-4000-8000-000000000021";
const W = "00000000-0000-4000-8000-000000000031";
const LOBBY = "00000000-0000-4000-8000-000000000041";
const noop = () => undefined;

const nothingHidden = { preparations: 0, models: 0, dashboards: 0, screens: 0 };
const impactWithHidden: DataImpact = {
  target: { kind: "preparation", id: P },
  preparations: [],
  models: [{ id: M, name: "Revenue", publishedVersion: 4, pinnedVersion: 3 }],
  measures: [],
  dashboards: [
    {
      id: D,
      name: "Sales",
      widgets: [{ id: W, type: "measure", title: "Weekly revenue" }],
      viaFilter: false,
    },
  ],
  screens: [{ id: LOBBY, name: "Lobby", dashboardId: D }],
  hidden: { ...nothingHidden, screens: 2 },
  changedMeasureIds: null,
};
const render = (
  impact: DataImpact | "loading" | "failed",
  locale: "en" | "de" = "en",
  changedWidgetIds?: ReadonlySet<string>,
) =>
  renderI18n(
    <PublishImpactDialog
      name="Clean sales"
      impact={impact}
      {...(changedWidgetIds ? { changedWidgetIds } : {})}
      onConfirm={noop}
      onCancel={noop}
    />,
    locale,
  );

describe("PublishImpactDialog", () => {
  it("lists dependents with counts and hidden items", () => {
    const html = render(impactWithHidden);
    expect(html).toContain("Publish Clean sales?");
    expect(html).toContain("1 model");
    expect(html).toContain("1 dashboard");
    expect(html).toContain("Weekly revenue");
    expect(html).toContain("3 paired screens");
    expect(html).toContain("Lobby");
    expect(html).toContain("2 more you can&#x27;t open");
    expect(html).toContain("Includes every project");
    expect(html).not.toContain("preparations");
  });

  it("explains pinned models for a preparation", () => {
    expect(render(impactWithHidden)).toContain(
      "Uses version 3 until the model is published again.",
    );
    // A model target pins nothing.
    expect(
      render({
        ...impactWithHidden,
        target: { kind: "model", id: M },
        models: [],
      }),
    ).not.toContain("Uses version");
  });

  it("marks widgets reading changed measures and filter-only dashboards", () => {
    const html = render(
      {
        ...impactWithHidden,
        target: { kind: "model", id: M },
        models: [],
        dashboards: [
          ...impactWithHidden.dashboards,
          {
            id: "00000000-0000-4000-8000-000000000022",
            name: "Filters",
            widgets: [],
            viaFilter: true,
          },
        ],
      },
      "en",
      new Set([W]),
    );
    expect(html).toContain("Weekly revenue<span");
    expect(html).toContain("Changed");
    expect(html).toContain("Through a shared filter");
  });

  it("says when nothing depends on it", () => {
    const html = render({
      ...impactWithHidden,
      models: [],
      dashboards: [],
      screens: [],
      hidden: nothingHidden,
    });
    expect(html).toContain("Nothing uses this yet.");
  });

  it("keeps Publish enabled while loading and when the impact read failed", () => {
    for (const state of ["loading", "failed"] as const) {
      const html = render(state);
      expect(html).toContain(
        state === "loading"
          ? "Checking what uses this…"
          : "Could not check what uses this. You can still publish.",
      );
      expect(html).toMatch(/<button type="button" class="primary">Publish</);
      expect(html).not.toContain("disabled");
    }
  });

  it("renders in German", () => {
    const html = render(impactWithHidden, "de");
    expect(html).toContain("Clean sales veröffentlichen?");
    expect(html).toContain("1 Modell");
    expect(html).toContain("3 gekoppelte Bildschirme");
    expect(html).toContain("2 weitere, die du nicht öffnen kannst");
    expect(html).toContain(
      "Nutzt Version 3, bis das Modell erneut veröffentlicht wird.",
    );
    expect(html).toContain("Abbrechen");
    expect(
      render({ ...impactWithHidden, screens: [], hidden: nothingHidden }, "de"),
    ).not.toContain("Bildschirm");
    expect(
      render(
        {
          ...impactWithHidden,
          screens: [{ id: LOBBY, name: "Lobby", dashboardId: D }],
          hidden: nothingHidden,
        },
        "de",
      ),
    ).toContain("1 gekoppelter Bildschirm");
  });
});

describe("publishAfterConfirmation", () => {
  const steps = (confirmed: boolean, existed = true) => {
    const order: string[] = [];
    return {
      order,
      existed,
      save: vi.fn(async () => {
        order.push("save");
        return { id: "saved", version: 2 };
      }),
      confirm: vi.fn(async () => {
        order.push("confirm");
        return confirmed;
      }),
      publish: vi.fn(async () => {
        order.push("publish");
      }),
    };
  };

  it("publishes an existing record only after Confirm", async () => {
    const s = steps(true);
    expect(await publishAfterConfirmation(s)).toBe("published");
    expect(s.order).toEqual(["save", "confirm", "publish"]);
    expect(s.confirm).toHaveBeenCalledWith({ id: "saved", version: 2 });
    expect(s.publish).toHaveBeenCalledWith({ id: "saved", version: 2 });
  });

  it("keeps the saved draft and never publishes on Cancel", async () => {
    const s = steps(false);
    expect(await publishAfterConfirmation(s)).toBe("cancelled");
    expect(s.order).toEqual(["save", "confirm"]);
    expect(s.publish).not.toHaveBeenCalled();
  });

  it("publishes a record that was never saved directly", async () => {
    const s = steps(false, false);
    expect(await publishAfterConfirmation(s)).toBe("published");
    expect(s.order).toEqual(["save", "publish"]);
    expect(s.confirm).not.toHaveBeenCalled();
  });
});
