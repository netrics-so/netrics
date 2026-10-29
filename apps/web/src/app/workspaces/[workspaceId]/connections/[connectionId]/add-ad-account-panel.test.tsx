import { describe, expect, it, vi } from "vitest";

import type { Locale } from "@netrics/domain";

import { AdAccountOption } from "../new/apple-ads-setup";
import { AddAdAccountPanel } from "./add-ad-account-panel";
import { appleAdsAccountConfig } from "@/lib/apple-ads";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// "Add another ad account" on an Apple Ads connection page (#395), in
// English and German: the panel before the list, and an ad account the
// workspace has connected already, which cannot be ticked.

const EU = {
  id: "4100000002",
  name: "Example Apps EU",
  currency: "EUR",
  timeZone: "Europe/Berlin",
  selectable: true,
  unselectable: null,
};

function render(locale: Locale) {
  return renderI18n(
    <>
      <AddAdAccountPanel workspaceId="w" connectionId="c" />
      <ul>
        <AdAccountOption
          account={EU}
          checked
          disabled={false}
          onToggle={() => {}}
          connected="Connected already as Apple Ads · EU"
        />
      </ul>
    </>,
    locale,
  );
}

describe("Add another ad account (#395)", () => {
  it("offers to add another ad account with the stored key, in English", () => {
    const html = render("en");
    expect(html).toContain("More ad accounts with this key");
    expect(html).toContain("Add another ad account");
    expect(html).toContain("which stays on the server");
    // A connected ad account is shown, but cannot be ticked.
    expect(html).toContain("Connected already as Apple Ads · EU");
    expect(html).toMatch(/<input type="checkbox" disabled=""/);
    expect(html).not.toMatch(/checked=""/);
  });

  it("is German throughout", () => {
    const html = render("de");
    expect(html).toContain("Weitere Werbekonten mit diesem Schlüssel");
    expect(html).toContain("Weiteres Werbekonto hinzufügen");
    expect(html).not.toContain("Add another ad account");
    expect(html).not.toContain("More ad accounts");
  });

  it("builds the new connection's config from the listed ad account", () => {
    expect(appleAdsAccountConfig(EU)).toEqual({
      adAccountId: "4100000002",
      adAccountName: "Example Apps EU",
      currency: "EUR",
      timeZone: "Europe/Berlin",
    });
    expect(
      appleAdsAccountConfig({ ...EU, currency: null, timeZone: null }),
    ).toEqual({ adAccountId: "4100000002", adAccountName: "Example Apps EU" });
  });
});
