import { describe, expect, it } from "vitest";

import { ApproveDeviceForm } from "./approve-form";
import { renderI18n } from "@/lib/i18n/test-render";

const WORKSPACES = [
  { id: "w", name: "Sales", dashboards: [{ id: "d", name: "Lobby" }] },
];

describe("approve form", () => {
  it("suggests Apple TV until the code's platform is known (#406)", () => {
    for (const locale of ["en", "de"] as const) {
      const html = renderI18n(
        <ApproveDeviceForm initialCode="ACDE-FGHJ" workspaces={WORKSPACES} />,
        locale,
      );
      expect(html).toContain('value="ACDE-FGHJ"');
      expect(html).toMatch(/id="pairing-name"[^>]*value="Apple TV"/);
    }
  });

  it("preselects the workspace and dashboard it was opened from (#835)", () => {
    const workspaces = [
      {
        id: "default",
        name: "Default",
        dashboards: [{ id: "d0", name: "Home" }],
      },
      {
        id: "gate",
        name: "M13 gate",
        dashboards: [
          { id: "d1", name: "Weather" },
          { id: "d2", name: "Images" },
        ],
      },
    ];
    const selected = (html: string) =>
      [...html.matchAll(/<option value="([^"]+)" selected="">/g)].map(
        (match) => match[1],
      );
    const from = (workspace?: string, dashboard?: string) =>
      selected(
        renderI18n(
          <ApproveDeviceForm
            initialCode=""
            workspaces={workspaces}
            initialWorkspaceId={workspace}
            initialDashboardId={dashboard}
          />,
        ),
      );
    expect(from("gate")).toEqual(["gate", "d1"]);
    expect(from("gate", "d2")).toEqual(["gate", "d2"]);
    // Without one (a TV's QR code), or one the person cannot pair into:
    // the first workspace, as before.
    expect(from()).toEqual(["default", "d0"]);
    expect(from("elsewhere", "d2")).toEqual(["default", "d0"]);
  });
});
