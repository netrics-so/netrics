import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The template-update routes' 413s as the contract documents them (#913):
 * each template names its own, so the App Portfolio's routes never name a
 * Developer Portfolio error. Read from the checked-in contract, which
 * `pnpm openapi:check` keeps generated from the routes.
 */
const contract = JSON.parse(
  readFileSync(
    new URL("../../../../packages/contracts/openapi.json", import.meta.url),
    "utf8",
  ),
) as {
  paths: Record<
    string,
    Record<string, { responses?: Record<string, { description?: string }> }>
  >;
};
const tooLarge = (path: string, method: "get" | "post") =>
  contract.paths[`/v1/workspaces/{workspaceId}/dashboard-templates/${path}`]?.[
    method
  ]?.responses?.["413"]?.description ?? "";

describe("template update routes' 413", () => {
  it("names each template's own limits", () => {
    for (const method of ["get", "post"] as const) {
      const store = tooLarge("stores/installs/{requestId}/update", method);
      expect(store).toContain("data_source_row_limit");
      expect(store).not.toContain("developer_");
      const developer = tooLarge(
        "developer/installs/{requestId}/update",
        method,
      );
      expect(developer).toContain("data_source_row_limit");
      expect(developer).toContain("developer_default_links_limit");
      expect(developer).toContain("developer_project_names_limit");
    }
  });
});
