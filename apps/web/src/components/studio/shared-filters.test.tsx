/**
 * Dashboard filter controls. Chips and range labels show locale dates
 * (#619). "Browse values" only expands the value list (#624): once the list shows, there is no control left that would close it
 * under the same label. The popover behaviour (one open at a time, Escape,
 * outside press, focus) runs in a browser: e2e/dashboard-filters.spec.ts.
 */
import { describe, expect, it } from "vitest";

import type { DashboardDataFilter } from "@netrics/domain";
import { renderI18n } from "@/lib/i18n/test-render";

import {
  DashboardFilterInput,
  DashboardFilters,
  filterValueText,
} from "./shared-filters";

const W = "00000000-0000-4000-8000-000000000001";
const filter = (id: string, name: string): DashboardDataFilter => ({
  id,
  name,
  type: "string",
  mode: "values",
  mappings: [{ modelId: "model", dimensionId: id }],
  defaultValue: null,
});

describe("dashboard filter input (#624)", () => {
  it.each([
    ["en", "Browse values", "Search available values"],
    ["de", "Werte durchsuchen", "Verfügbare Werte suchen"],
  ] as const)(
    "offers %s browsing that only expands the list",
    (locale, browse, search) => {
      const closed = renderI18n(
        <DashboardFilterInput
          filter={filter("app", "App")}
          workspaceId={W}
          value={null}
          onChange={() => {}}
        />,
        locale,
      );
      expect(closed).toContain(browse);
      expect(closed).toContain('aria-expanded="false"');
      expect(closed).not.toContain(search);

      const open = renderI18n(
        <DashboardFilterInput
          filter={filter("app", "App")}
          workspaceId={W}
          initialBrowse
          value={null}
          onChange={() => {}}
        />,
        locale,
      );
      expect(open).toContain(search);
      expect(open).toContain('type="search"');
      // No toggle that would close the list again.
      expect(open).not.toContain(browse);
      expect(open).not.toContain('aria-expanded="true"');
    },
  );

  it("renders every filter popover closed at first", () => {
    const html = renderI18n(
      <DashboardFilters
        workspaceId={W}
        filters={[filter("app", "App"), filter("currency", "Currency")]}
        values={{}}
        onChange={() => {}}
      />,
    );
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html).not.toContain("dashboard-filter-popover");
  });
});

const day: DashboardDataFilter = {
  id: "day",
  name: "Day",
  type: "date",
  mode: "range",
  mappings: [],
  defaultValue: null,
};

describe("filter chips show locale dates (#619)", () => {
  it("formats day and timestamp values, other values as they are", () => {
    expect(filterValueText(day, "2026-01-01", "de")).toBe("01.01.2026");
    expect(filterValueText(day, "2026-01-01", "en")).toBe("Jan 1, 2026");
    expect(filterValueText({ type: "string" }, "2026-01-01", "de")).toBe(
      "2026-01-01",
    );
  });
  it("shows a day range in the locale's format in en and de", () => {
    const view = (locale: "en" | "de") =>
      renderI18n(
        <DashboardFilters
          filters={[day]}
          values={{
            day: { kind: "range", from: "2026-01-01", to: "2026-01-07" },
          }}
          onChange={() => {}}
        />,
        locale,
      );
    const de = view("de");
    expect(de).toContain("01.01.2026 – 07.01.2026");
    expect(de).not.toContain("2026-01-01");
    expect(view("en")).toContain("Jan 1, 2026 – Jan 7, 2026");
  });
  it("keeps an open end as an ellipsis", () => {
    const html = renderI18n(
      <DashboardFilters
        filters={[day]}
        values={{ day: { kind: "range", from: "2026-01-01", to: null } }}
        onChange={() => {}}
      />,
      "de",
    );
    expect(html).toContain("01.01.2026 – …");
  });
});
