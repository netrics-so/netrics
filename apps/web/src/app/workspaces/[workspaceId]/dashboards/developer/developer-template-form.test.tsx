import { describe, expect, it, vi } from "vitest";
import type { DeveloperTemplateOptions } from "@netrics/contracts";

import { renderI18n } from "@/lib/i18n/test-render";

import { DeveloperTemplateForm } from "./developer-template-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const W = "00000000-0000-4000-8000-000000000001";
const SHOP = "00000000-0000-4000-8000-0000000000b1";
const options: DeveloperTemplateOptions = {
  connections: [
    {
      id: "00000000-0000-4000-8000-0000000000a1",
      name: "Railway team",
      connectorId: "railway",
      setupPending: false,
      projectId: SHOP,
      resources: [{ id: "rw-1", name: "shop-prod" }],
    },
    {
      id: "00000000-0000-4000-8000-0000000000a2",
      name: "PostHog EU",
      connectorId: "posthog",
      setupPending: true,
      projectId: null,
      resources: [],
    },
  ],
  projects: [{ id: SHOP, name: "Shop" }],
};
const checked = (html: string) =>
  [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) =>
    match[0].includes('checked=""'),
  );

describe("Developer Portfolio form (#876)", () => {
  it("starts with every set-up source chosen and names each source's project", () => {
    const html = renderI18n(
      <DeveloperTemplateForm
        workspaceId={W}
        projectId={null}
        options={options}
      />,
    );
    expect(checked(html)).toEqual([true, false]);
    expect(html).toContain("Railway · 1 resource · Project: Shop");
    expect(html).toContain("PostHog · 0 resources · No project");
    expect(html).toContain("Finish setup");
    expect(html).toContain("Create dashboard");
  });

  it("speaks German", () => {
    const html = renderI18n(
      <DeveloperTemplateForm
        workspaceId={W}
        projectId={null}
        options={options}
      />,
      "de",
    );
    expect(html).toContain("Railway · 1 Ressource · Projekt: Shop");
    expect(html).toContain("Dashboard erstellen");
    expect(html).toContain('value="Developer-Portfolio"');
  });

  it("asks for a source when there is none, and says when there are no projects", () => {
    expect(
      renderI18n(
        <DeveloperTemplateForm
          workspaceId={W}
          projectId={null}
          options={{ connections: [], projects: [] }}
        />,
      ),
    ).toContain("Connect sources");
    expect(
      renderI18n(
        <DeveloperTemplateForm
          workspaceId={W}
          projectId={null}
          options={{ ...options, projects: [] }}
        />,
      ),
    ).toContain("This workspace has no projects yet");
  });
});
