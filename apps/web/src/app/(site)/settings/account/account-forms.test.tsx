import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Locale } from "@netrics/domain";

import {
  ChangePasswordForm,
  LanguageForm,
  SignOutButton,
} from "./account-forms";
import { WEB_CATALOGS } from "@/lib/i18n/catalogs";
import { I18nProvider } from "@/lib/i18n/client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

function render(locale: Locale) {
  return renderToStaticMarkup(
    <I18nProvider locale={locale} messages={WEB_CATALOGS[locale]}>
      <LanguageForm current={null} automaticName="Deutsch" />
      <ChangePasswordForm />
      <SignOutButton />
    </I18nProvider>,
  );
}

describe("account forms", () => {
  it("render in German", () => {
    const html = render("de");
    expect(html).toContain("Automatisch (Deutsch)");
    expect(html).toContain("Aktuelles Passwort");
    expect(html).toContain("Passwort ändern");
    expect(html).toContain("Abmelden");
    expect(html).not.toContain("Sign out");
  });

  it("render in English", () => {
    const html = render("en");
    expect(html).toContain("Automatic (Deutsch)");
    expect(html).toContain("Current password");
    expect(html).toContain("Sign out");
  });

  it("offer every language in its own name", () => {
    const html = render("en");
    expect(html).toContain('<option value="en" lang="en">English</option>');
    expect(html).toContain('<option value="de" lang="de">Deutsch</option>');
  });
});
