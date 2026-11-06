import { describe, expect, it } from "vitest";
import { renderI18n } from "@/lib/i18n/test-render";
import { DataWorkspace } from "./data-workspace";
import { DataTable } from "./data-table";
describe("data workspace", () => {
  it.each(["en", "de"] as const)(
    "renders an actionable empty state in %s",
    (locale) => {
      const html = renderI18n(
        <DataWorkspace
          workspaceId="workspace"
          initial={{ sources: [], preparations: [], models: [] }}
        />,
        locale,
      );
      expect(html).toContain("/workspaces/workspace/connections/new");
      expect(html).toContain(
        locale === "en" ? "Start with your data" : "Beginne mit deinen Daten",
      );
      expect(html).not.toContain("undefined");
    },
  );
  it("escapes source values and keeps exact decimals readable", () => {
    const html = renderI18n(
      <DataTable
        fields={[
          { id: "text", name: "Name", type: "string", nullable: false },
          { id: "amount", name: "Amount", type: "decimal", nullable: false },
        ]}
        rows={[
          {
            text: "<script>private</script>",
            amount: "12345678901234567890.12",
          },
        ]}
      />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("12345678901234567890.12");
  });
});
