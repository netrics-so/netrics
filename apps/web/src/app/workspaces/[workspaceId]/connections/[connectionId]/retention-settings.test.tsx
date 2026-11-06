import { describe, expect, it, vi } from "vitest";

import type { ConnectionRetention } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import {
  presetRetentionValues,
  RetentionFields,
  shortensRetention,
} from "../retention-fields";
import { RetentionSettings } from "./retention-settings";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// Per-connection dataset retention (#492): the setup step and the settings
// section, in English and German.

const earnings = {
  key: "earning_rows",
  name: "Google Play earnings report rows",
  personal: true,
  connectorDefaultDays: null,
  presetDays: 90,
};
const installs = {
  key: "install_rows",
  name: "Google Play install report rows",
  personal: false,
  connectorDefaultDays: null,
  presetDays: null,
};

function retention(
  overrides: Partial<ConnectionRetention> = {},
): ConnectionRetention {
  return {
    datasets: [
      {
        ...earnings,
        days: 90,
        source: "preset",
        effectiveDays: 90,
        cappedByWorkspace: false,
      },
      {
        ...installs,
        days: null,
        source: "preset",
        effectiveDays: null,
        cappedByWorkspace: false,
      },
    ],
    workspaceMaxDays: null,
    basis: "preset",
    chosenAt: null,
    chosenBy: null,
    ...overrides,
  };
}

function settings(
  locale: Locale,
  value: ConnectionRetention,
  canUpdate = true,
) {
  return renderI18n(
    <RetentionSettings
      workspaceId="w"
      connectionId="c"
      retention={value}
      canUpdate={canUpdate}
    />,
    locale,
  );
}

describe("connection retention settings (#492)", () => {
  it("presets personal data to 90 days and keeps other data per connector", () => {
    expect(presetRetentionValues([earnings, installs])).toEqual({
      earning_rows: 90,
      install_rows: null,
    });
    const html = settings("en", retention());
    expect(html).toContain("Google Play earnings report rows");
    expect(html).toContain("Contains personal data");
    expect(html).toContain(
      "Preset to 90 days because it contains personal data",
    );
    expect(html).toContain('value="90"');
    expect(html).toContain("Connector default: until deleted.");
    expect(html).toContain("Keep data");
    expect(html).toContain("Until deleted");
    expect(html).toContain("Not reviewed yet.");
    expect(html).toContain("Save retention");
  });

  it("shows who chose the retention and when", () => {
    const html = settings(
      "en",
      retention({
        basis: "chosen",
        chosenAt: "2026-11-06T10:00:00.000Z",
        chosenBy: { id: "u", name: "Ada" },
      }),
    );
    expect(html).toContain("Chosen by Ada on Nov 6, 2026.");
    const migrated = settings(
      "en",
      retention({ basis: "migrated", chosenAt: "2026-11-06T10:00:00.000Z" }),
    );
    expect(migrated).toContain(
      "Recorded on Nov 6, 2026 from the retention this connection already had. Nothing was shortened.",
    );
  });

  it("says when the workspace maximum caps a choice", () => {
    const html = settings("en", retention({ workspaceMaxDays: 30 }));
    expect(html).toContain(
      "Your workspace keeps data for at most 30 days, so that limit applies.",
    );
    expect(html).toContain(
      "Your workspace’s retention policy also applies: at most 30 days.",
    );
  });

  it("is read-only for members who cannot edit connections", () => {
    const html = settings("en", retention(), false);
    expect(html).not.toContain("Save retention");
    expect(html).toContain("Only members who can edit connections");
    expect(html).toMatch(/<select[^>]*disabled=""/);
  });

  it("is German throughout", () => {
    const html = settings(
      "de",
      retention({
        basis: "chosen",
        chosenAt: "2026-11-06T10:00:00.000Z",
        chosenBy: { id: "u", name: "Ada" },
        workspaceMaxDays: 30,
      }),
    );
    expect(html).toContain("Daten behalten");
    expect(html).toContain("Bis zur Löschung");
    expect(html).toContain("Enthält personenbezogene Daten");
    expect(html).toContain("Voreingestellt auf 90 Tage");
    expect(html).toContain("Gewählt von Ada am 06.11.2026.");
    expect(html).toContain("höchstens 30 Tage");
    expect(html).toContain("Aufbewahrung speichern");
    expect(html).not.toContain("Keep data");
    expect(html).not.toContain("Save retention");
  });

  it("warns only when a period becomes shorter", () => {
    const before = { earning_rows: 90, install_rows: null };
    expect(shortensRetention(before, { ...before, earning_rows: 30 })).toBe(
      true,
    );
    expect(shortensRetention(before, { ...before, install_rows: 365 })).toBe(
      true,
    );
    expect(shortensRetention(before, { ...before, earning_rows: 365 })).toBe(
      false,
    );
    expect(shortensRetention(before, { ...before, earning_rows: null })).toBe(
      false,
    );
  });

  it("renders the setup step's fields from the connector catalogue", () => {
    const html = renderI18n(
      <RetentionFields
        idPrefix="setup"
        datasets={[earnings, installs]}
        values={{ earning_rows: 400, install_rows: null }}
        onChange={() => {}}
      />,
      "en",
    );
    expect(html).toContain('id="setup-earning_rows-days"');
    expect(html).toContain('value="400"');
    // Until deleted hides the days input.
    expect(html).not.toContain('id="setup-install_rows-days"');
  });
});
