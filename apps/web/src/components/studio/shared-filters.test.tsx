import { describe, expect, it } from "vitest";
import type { DashboardDataFilter } from "@netrics/domain";
import { renderI18n } from "@/lib/i18n/test-render";
import { DashboardFilters, filterValueText } from "./shared-filters";

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
