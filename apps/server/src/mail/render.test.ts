import { describe, expect, it } from "vitest";

import { compareCatalogs } from "@netrics/domain";

import { de } from "./messages/de.js";
import { en } from "./messages/en.js";
import {
  escapeHtml,
  renderInvitationEmail,
  renderPasswordResetEmail,
  renderVerificationEmail,
} from "./render.js";

// #255 (ADR 0016 section 5): every email in English and German.

const URL_ = "https://app.example.com/reset?token=abc&x=1";

describe("mail catalogs", () => {
  it("German has exactly the English keys and arguments", () => {
    expect(compareCatalogs(en, de)).toEqual([]);
  });
});

describe("verification email", () => {
  it("renders in English", () => {
    const email = renderVerificationEmail({ url: URL_, locale: "en" });
    expect(email.subject).toBe("Verify your email address");
    expect(email.text).toBe(
      "Confirm your email address for netrics:\n\n" +
        `${URL_}\n\n` +
        "If you did not create an account, you can ignore this email.\n",
    );
    expect(email.html).toContain('<html lang="en">');
    expect(email.html).toContain(">Verify email address</a>");
  });

  it("renders in German", () => {
    const email = renderVerificationEmail({ url: URL_, locale: "de" });
    expect(email.subject).toBe("Bestätige deine E-Mail-Adresse");
    expect(email.text).toBe(
      "Bestätige deine E-Mail-Adresse für netrics:\n\n" +
        `${URL_}\n\n` +
        "Wenn du kein Konto erstellt hast, kannst du diese E-Mail ignorieren.\n",
    );
    expect(email.html).toContain('<html lang="de">');
    expect(email.html).toContain(">E-Mail-Adresse bestätigen</a>");
  });
});

describe("password reset email", () => {
  it("renders in English", () => {
    const email = renderPasswordResetEmail({ url: URL_, locale: "en" });
    expect(email.subject).toBe("Reset your password");
    expect(email.text).toBe(
      "Reset your netrics password:\n\n" +
        `${URL_}\n\n` +
        "The link expires in 1 hour and works once.\n\n" +
        "If you did not request a reset, you can ignore this email; " +
        "your password stays the same.\n",
    );
    expect(email.html).toContain(">Reset password</a>");
  });

  it("renders in German", () => {
    const email = renderPasswordResetEmail({ url: URL_, locale: "de" });
    expect(email.subject).toBe("Setze dein Passwort zurück");
    expect(email.text).toBe(
      "Setze dein netrics-Passwort zurück:\n\n" +
        `${URL_}\n\n` +
        "Der Link ist 1 Stunde gültig und funktioniert nur einmal.\n\n" +
        "Wenn du das Zurücksetzen nicht angefordert hast, kannst du diese " +
        "E-Mail ignorieren; dein Passwort bleibt unverändert.\n",
    );
    expect(email.html).toContain(">Passwort zurücksetzen</a>");
  });
});

describe("invitation email", () => {
  const base = { url: URL_, workspaceName: "Acme", inviterName: "Ada" };

  it("renders in English", () => {
    const email = renderInvitationEmail({ ...base, locale: "en" });
    expect(email.subject).toBe("Ada invited you to Acme on netrics");
    expect(email.text).toBe(
      "Ada invited you to join the workspace “Acme” on netrics.\n\n" +
        `${URL_}\n\n` +
        "The link expires in 7 days.\n\n" +
        "If you did not expect this invitation, you can ignore this email.\n",
    );
    expect(email.html).toContain("“<strong>Acme</strong>”");
    expect(email.html).toContain(">Accept the invitation</a>");
  });

  it("renders in German", () => {
    const email = renderInvitationEmail({ ...base, locale: "de" });
    expect(email.subject).toBe("Ada hat dich zu Acme auf netrics eingeladen");
    expect(email.text).toBe(
      "Ada hat dich eingeladen, dem Workspace „Acme“ auf netrics " +
        "beizutreten.\n\n" +
        `${URL_}\n\n` +
        "Der Link ist 7 Tage gültig.\n\n" +
        "Wenn du diese Einladung nicht erwartet hast, kannst du diese " +
        "E-Mail ignorieren.\n",
    );
    expect(email.html).toContain("„<strong>Acme</strong>“");
    expect(email.html).toContain(">Einladung annehmen</a>");
  });

  it("names a workspace admin when the inviter is unknown", () => {
    expect(
      renderInvitationEmail({ ...base, inviterName: null, locale: "en" })
        .subject,
    ).toBe("A workspace admin invited you to Acme on netrics");
    expect(
      renderInvitationEmail({ ...base, inviterName: "  ", locale: "de" })
        .subject,
    ).toBe("Ein Workspace-Admin hat dich zu Acme auf netrics eingeladen");
  });

  it("escapes user-controlled names in the HTML part", () => {
    const email = renderInvitationEmail({
      url: URL_,
      locale: "en",
      workspaceName: `<img src=x onerror="alert(1)">&co`,
      inviterName: "<script>alert('x')</script>",
    });
    expect(email.html).not.toContain("<script");
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
    );
    expect(email.html).toContain(
      "<strong>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;co</strong>",
    );
    // The subject is in the <title> as well.
    expect(email.html).toMatch(/<title>&lt;script&gt;[^<]*<\/title>/);
    // Plain text keeps the names as written.
    expect(email.text).toContain("<script>alert('x')</script> invited you");
  });

  it("does not let names inject ICU syntax", () => {
    const email = renderInvitationEmail({
      ...base,
      locale: "en",
      workspaceName: "{days} {count, plural, other {#}}",
    });
    expect(email.subject).toBe(
      "Ada invited you to {days} {count, plural, other {#}} on netrics",
    );
  });
});

describe("links in HTML", () => {
  it("escape the URL in attributes and text", () => {
    const email = renderPasswordResetEmail({ url: URL_, locale: "en" });
    const escaped = escapeHtml(URL_);
    expect(escaped).toBe("https://app.example.com/reset?token=abc&amp;x=1");
    expect(email.html).toContain(`href="${escaped}"`);
    expect(email.html).not.toContain(`href="${URL_}"`);
  });
});
