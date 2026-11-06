import { describe, expect, it } from "vitest";

import { authErrorMessage } from "./auth-errors";

describe("authErrorMessage", () => {
  it("words better-auth codes in English and German", () => {
    const wrong = { status: 401, code: "INVALID_EMAIL_OR_PASSWORD" };
    expect(authErrorMessage(wrong, "en", "signIn")).toBe(
      "That email and password do not match an account.",
    );
    expect(authErrorMessage(wrong, "de", "signIn")).toBe(
      "E-Mail und Passwort passen zu keinem Konto.",
    );
    expect(
      authErrorMessage(
        { status: 422, code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
        "de",
        "signUp",
      ),
    ).toBe(
      "Mit dieser E-Mail gibt es schon ein Konto. Melde dich stattdessen an.",
    );
    expect(
      authErrorMessage({ status: 400, code: "PASSWORD_TOO_SHORT" }, "en"),
    ).toBe("Use at least 8 characters.");
    expect(
      authErrorMessage({ status: 403, code: "SIGNUP_DISABLED" }, "de"),
    ).toBe("Die Registrierung ist auf dieser Installation deaktiviert.");
  });

  it("names a wrong current password when changing it", () => {
    const error = { status: 400, code: "INVALID_PASSWORD" };
    expect(authErrorMessage(error, "en", "changePassword")).toBe(
      "The current password is not correct.",
    );
    expect(authErrorMessage(error, "en", "signIn")).toBe(
      "That email and password do not match an account.",
    );
  });

  it("words rate limits before codes", () => {
    expect(authErrorMessage({ status: 429, code: "INVALID_TOKEN" }, "de")).toBe(
      "Zu viele Versuche. Warte ein paar Minuten und versuch es dann noch einmal.",
    );
  });

  it("never shows better-auth's own English message", () => {
    const error = { status: 500, code: "SOMETHING_NEW", message: "boom" };
    expect(authErrorMessage(error, "en", "signUp")).toBe(
      "Sign-up failed. Try again.",
    );
    expect(authErrorMessage(error, "de")).toBe(
      "Etwas ist schiefgelaufen. Versuch es noch einmal.",
    );
    expect(authErrorMessage({ message: "boom" }, "de", "setup")).toBe(
      "Die Einrichtung ist fehlgeschlagen. Versuch es noch einmal.",
    );
  });
});
