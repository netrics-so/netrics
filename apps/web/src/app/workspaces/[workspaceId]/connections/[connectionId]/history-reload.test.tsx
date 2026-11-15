import { describe, expect, it, vi } from "vitest";

import type { ConnectionHistory } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { HistoryReload } from "./history-reload";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// "Reload history" (#617) on the connection page, in English and German.

function history(
  overrides: Partial<ConnectionHistory> = {},
): ConnectionHistory {
  return {
    supportsBackfill: true,
    backfillDays: 365,
    backfill: "idle",
    incompleteDatasets: [],
    reloadAvailableAt: null,
    ...overrides,
  };
}

function render(locale: Locale, value: ConnectionHistory) {
  return renderI18n(
    <HistoryReload
      workspaceId="w"
      connectionId="c"
      connectionName="Store"
      history={value}
    />,
    locale,
  );
}

const enabled = (html: string, label: string) =>
  new RegExp(`<button type="button">${label}</button>`).test(html);

describe("reload history (#617)", () => {
  it("offers the reload in each language", () => {
    expect(enabled(render("en", history()), "Reload history")).toBe(true);
    expect(enabled(render("de", history()), "Verlauf neu laden")).toBe(true);
  });

  it("is disabled while a backfill waits or runs", () => {
    for (const backfill of ["queued", "running"] as const) {
      const html = render("en", history({ backfill }));
      expect(enabled(html, "Reload history")).toBe(false);
      expect(html).toContain("disabled");
    }
  });

  it("is disabled until the rate limit allows the next one, and says when", () => {
    const later = new Date(Date.now() + 5 * 3_600_000).toISOString();
    const en = render("en", history({ reloadAvailableAt: later }));
    expect(enabled(en, "Reload history")).toBe(false);
    expect(en).toContain("History can be reloaded again in 5 hours.");
    const de = render("de", history({ reloadAvailableAt: later }));
    expect(de).toContain(
      "Der Verlauf kann in 5 Stunden wieder neu geladen werden.",
    );
  });
});
