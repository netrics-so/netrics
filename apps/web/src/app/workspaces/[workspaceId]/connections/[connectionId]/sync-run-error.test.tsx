import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { sharedEn, type Locale } from "@netrics/domain";

import { SyncRunError } from "./sync-run-error";
import { WEB_CATALOGS } from "@/lib/i18n/catalogs";
import { I18nProvider } from "@/lib/i18n/client";

// A failed run's error on the connection page (#378): a refused Apple Ads
// key reads in the viewer's language; other provider words stay English.

const REFUSED = sharedEn.providerMessages.appleAds.invalidClient;

function render(locale: Locale, errorMessage: string) {
  return renderToStaticMarkup(
    <I18nProvider locale={locale} messages={WEB_CATALOGS[locale]}>
      <SyncRunError run={{ errorClass: "auth", errorMessage }} />
    </I18nProvider>,
  );
}

describe("sync run error", () => {
  it("shows a refused Apple Ads key in German", () => {
    const html = render("de", REFUSED);
    expect(html).toContain("Anmeldung abgelehnt: Apple Ads hat den Schlüssel");
    expect(html).not.toContain("refused the key");
    expect(html).not.toContain('lang="en"');
  });

  it("keeps other provider words in English, marked as such", () => {
    const html = render("de", "Apple Ads answered 500");
    expect(html).toContain('<span lang="en">Apple Ads answered 500</span>');
  });

  it("shows the refusal as it is in English", () => {
    expect(render("en", REFUSED)).toContain(REFUSED);
  });
});
