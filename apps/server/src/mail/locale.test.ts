import { describe, expect, it } from "vitest";

import { invitationEmailLocale, recipientEmailLocale } from "./locale.js";

// #255 (ADR 0016 section 3): which language an email is written in.

describe("recipientEmailLocale", () => {
  it("prefers the recipient's setting, then the instance default, then English", () => {
    expect(
      recipientEmailLocale({ recipientLocale: "de", defaultLocale: "en" }),
    ).toBe("de");
    expect(
      recipientEmailLocale({ recipientLocale: "en", defaultLocale: "de" }),
    ).toBe("en");
    expect(
      recipientEmailLocale({ recipientLocale: null, defaultLocale: "de" }),
    ).toBe("de");
    expect(
      recipientEmailLocale({ recipientLocale: null, defaultLocale: null }),
    ).toBe("en");
  });

  it("skips a stored language netrics no longer speaks", () => {
    expect(
      recipientEmailLocale({ recipientLocale: "fr", defaultLocale: "de" }),
    ).toBe("de");
    expect(
      recipientEmailLocale({ recipientLocale: "fr", defaultLocale: null }),
    ).toBe("en");
  });
});

describe("invitationEmailLocale", () => {
  const none = {
    recipientLocale: null,
    inviterLocale: null,
    defaultLocale: null,
    inviterAcceptLanguage: null,
  };

  it("uses the existing account's language first", () => {
    expect(
      invitationEmailLocale({
        recipientLocale: "de",
        inviterLocale: "en",
        defaultLocale: "en",
        inviterAcceptLanguage: "en-US",
      }),
    ).toBe("de");
    expect(
      invitationEmailLocale({
        ...none,
        recipientLocale: "en",
        inviterLocale: "de",
      }),
    ).toBe("en");
  });

  it("falls back to the inviter's language: setting, instance default, browser", () => {
    expect(
      invitationEmailLocale({
        ...none,
        inviterLocale: "de",
        defaultLocale: "en",
      }),
    ).toBe("de");
    expect(
      invitationEmailLocale({
        ...none,
        defaultLocale: "de",
        inviterAcceptLanguage: "en",
      }),
    ).toBe("de");
    expect(
      invitationEmailLocale({
        ...none,
        inviterAcceptLanguage: "fr-FR, de-AT;q=0.8, en;q=0.5",
      }),
    ).toBe("de");
  });

  it("ends with English", () => {
    expect(invitationEmailLocale(none)).toBe("en");
    expect(
      invitationEmailLocale({
        ...none,
        recipientLocale: "fr",
        inviterAcceptLanguage: "fr",
      }),
    ).toBe("en");
  });
});
