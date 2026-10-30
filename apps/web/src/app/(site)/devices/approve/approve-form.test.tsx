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
});
