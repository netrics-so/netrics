import { describe, expect, it, vi } from "vitest";

import type { CustomApiDefinitionSummary } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { CustomApiDefinitionList } from "./definition-list";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// The list of custom APIs (#807), in English and German.

const NOW = Date.parse("2026-11-21T12:00:00Z");
const SHOP: CustomApiDefinitionSummary = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Shop API",
  projectId: null,
  currentVersion: 3,
  archivedAt: null,
  connectionCount: 2,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-21T09:00:00.000Z",
};

const render = (
  locale: Locale,
  props: Partial<Parameters<typeof CustomApiDefinitionList>[0]> = {},
) =>
  renderI18n(
    <CustomApiDefinitionList
      workspaceId="w"
      definitions={[SHOP]}
      canCreate
      canEdit
      now={NOW}
      {...props}
    />,
    locale,
  );

describe("custom API list", () => {
  it("lists custom APIs with their connections", () => {
    const html = render("en");
    expect(html).toContain(`href="/workspaces/w/custom-apis/${SHOP.id}"`);
    expect(html).toContain("Shop API");
    expect(html).toContain("v3");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("3 hours ago");
    expect(html).toContain(
      `href="/workspaces/w/custom-apis/${SHOP.id}/connect"`,
    );
    expect(html).toContain(">Edit<");
    const de = render("de");
    expect(de).toContain("Verbindungen");
    expect(de).toContain(">Verbinden<");
    expect(de).toContain(">Bearbeiten<");
  });

  it("says when there are none, and offers viewers no actions", () => {
    expect(render("en", { definitions: [] })).toContain("No custom APIs yet.");
    expect(render("de", { definitions: [] })).toContain(
      "Noch keine eigenen APIs.",
    );
    const viewer = render("en", { canCreate: false, canEdit: false });
    expect(viewer).not.toContain("/connect");
    expect(viewer).toContain(">View<");
  });
});
