import { describe, expect, it, vi } from "vitest";

import type { Goal, WorkspaceMetric } from "@netrics/contracts";

import { GoalForm } from "@/components/goals/goal-form";
import { renderI18n } from "@/lib/i18n/test-render";

import { GoalCard, GoalsView } from "./goals-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const CONNECTION = "00000000-0000-4000-8000-000000000002";

const signups = {
  connectionId: CONNECTION,
  connectionName: "Demo",
  connectorId: "demo",
  key: "demo.signups",
  name: "Signups",
  description: "New signups per day.",
  kind: "delta",
  unit: "signups",
  granularity: "day",
  dimensions: ["resource"],
  aggregations: ["sum", "avg"],
  better: "higher",
  role: "primary",
} as unknown as WorkspaceMetric;

const position = {
  ...signups,
  key: "gsc.position",
  name: "Average position",
  kind: "gauge",
  unit: "position",
  aggregations: ["last"],
  better: "lower",
} as unknown as WorkspaceMetric;

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    name: "Monthly downloads · Wurfel",
    connectionId: CONNECTION,
    metricKey: "demo.signups",
    aggregation: "sum",
    period: "this_month",
    dimensions: { resource: "wurfel" },
    displayCurrency: null,
    target: 15_000,
    version: 1,
    resourceName: "Wurfel",
    allResourcesName: null,
    current: {
      value: 12_480,
      target: 15_000,
      progress: 0.832,
      reachedAt: null,
      periodEnd: "2026-11-01T00:00:00+01:00",
      currency: null,
      approximate: false,
    },
    dashboards: [],
    createdAt: "2026-10-04T10:00:00.000Z",
    updatedAt: "2026-10-04T10:00:00.000Z",
    ...overrides,
  };
}

function render(
  props: Partial<Parameters<typeof GoalsView>[0]> = {},
  locale: "en" | "de" = "en",
) {
  return renderI18n(
    <GoalsView
      workspaceId={WORKSPACE}
      goals={[goal()]}
      metrics={[signups, position]}
      timeZone="Europe/Berlin"
      currency={{ displayCurrency: null, convertible: [] }}
      canCreate
      canEdit
      canDelete
      {...props}
    />,
    locale,
  );
}

describe("goals page (#335)", () => {
  it("lists a goal with its metric, period and progress", () => {
    const html = render();
    expect(html).toContain(">Goals<");
    expect(html).toContain(">1 goal<");
    expect(html).toContain("Monthly downloads · Wurfel");
    expect(html).toContain("Signups · Wurfel · Demo");
    expect(html).toContain(">This month<");
    expect(html).toContain("<strong>12,480</strong> of 15,000");
    expect(html).toContain(">83%<");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="83"');
    expect(html).toContain("width:83.20%");
    expect(html).toContain("2,520 to go");
    expect(html).toContain("</span> New goal</button>");
    expect(html).toContain('aria-label="Edit Monthly downloads · Wurfel"');
    expect(html).toContain('aria-label="Delete Monthly downloads · Wurfel"');
  });

  it("speaks German", () => {
    const html = render({}, "de");
    expect(html).toContain(">Ziele<");
    expect(html).toContain("<strong>12.480</strong> von 15.000");
    expect(html).toContain(">83\u00a0%<");
    expect(html).toContain("noch 2.520");
    expect(html).toContain(">Dieser Monat<");
  });

  it("shows a reached goal with the day it was reached, the bar full", () => {
    const html = render({
      goals: [
        goal({
          current: {
            value: 18_300,
            target: 15_000,
            progress: 1.22,
            reachedAt: "2026-10-09T00:00:00.000Z",
            periodEnd: "2026-11-01T00:00:00+01:00",
            currency: null,
            approximate: false,
          },
        }),
      ],
    });
    expect(html).toContain("goal-card goal-card--reached");
    expect(html).toContain(">122%<");
    expect(html).toContain("width:100.00%");
    expect(html).toContain("Reached on Oct 9");
    expect(html).toContain("1 goal · 1 reached");
  });

  it("says when there is no data or the metric cannot be read", () => {
    expect(
      render({
        goals: [
          goal({
            current: { ...goal().current!, value: null, progress: null },
          }),
        ],
      }),
    ).toContain("No data in this period yet");
    expect(render({ goals: [goal({ current: null })] })).toContain(
      "Progress cannot be read right now",
    );
  });

  it("is read-only for viewers, and editors cannot delete", () => {
    const viewer = render({
      canCreate: false,
      canEdit: false,
      canDelete: false,
    });
    expect(viewer).not.toContain("New goal");
    expect(viewer).not.toContain("goal-card-actions");
    const editor = render({ canDelete: false });
    expect(editor).toContain(">Edit<");
    expect(editor).not.toContain(">Delete<");
    expect(
      render({ goals: [], canCreate: false, canEdit: false, canDelete: false }),
    ).toContain("Editors, admins and owners can add goals.");
  });

  it("explains goals when there are none", () => {
    const html = render({ goals: [] });
    expect(html).toContain("No goals yet");
    expect(html).toContain("15,000 downloads this month");
    expect(render({ goals: [], metrics: [position] })).not.toContain(
      "New goal",
    );
  });
});

describe("goal form", () => {
  it("offers the Studio's picker with goal periods and a target", () => {
    const html = renderI18n(
      <GoalForm
        workspaceId={WORKSPACE}
        metrics={[signups, position]}
        goal={goal()}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('value="Monthly downloads · Wurfel"');
    expect(html).toContain('id="widget-metric"');
    // Lower-is-better metrics are not offered.
    expect(html).not.toContain("Average position");
    // Periods to date only, and only sum or last.
    expect(html).toContain(">This quarter<");
    expect(html).not.toContain(">Last 30 days<");
    expect(html).toContain(">Total<");
    expect(html).not.toContain(">Average per day<");
    expect(html).toContain('value="15000"');
    expect(html).toContain(">Save goal<");
  });
});

describe("goal card", () => {
  it("is plain text a screen reader can follow", () => {
    const html = renderI18n(
      <ul>
        <GoalCard
          workspaceId={WORKSPACE}
          goal={goal()}
          metric={signups}
          timeZone="UTC"
          canEdit={false}
          canDelete={false}
          onEdit={() => {}}
          onDeleted={() => {}}
        />
      </ul>,
    );
    expect(html).toContain(
      'aria-label="Monthly downloads · Wurfel: 83% of the target"',
    );
  });
});
