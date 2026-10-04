import { describe, expect, it } from "vitest";

import {
  PASSWORD_MIN_LENGTH,
  isInvalidTokenError,
  newPasswordProblem,
  readResetLink,
  resetPasswordRedirect,
} from "./password-reset";

describe("resetPasswordRedirect", () => {
  it("builds the page URL on the given origin", () => {
    expect(resetPasswordRedirect("https://app.example.com")).toBe(
      "https://app.example.com/reset-password",
    );
    expect(resetPasswordRedirect("http://localhost:3000")).toBe(
      "http://localhost:3000/reset-password",
    );
  });
});

describe("readResetLink", () => {
  it("reads the token of a valid link", () => {
    expect(readResetLink({ token: "abc123" })).toEqual({
      kind: "ready",
      token: "abc123",
    });
    expect(readResetLink({ token: ["abc123", "other"] })).toEqual({
      kind: "ready",
      token: "abc123",
    });
  });

  it("treats better-auth's error marker as an invalid link", () => {
    expect(readResetLink({ error: "INVALID_TOKEN" })).toEqual({
      kind: "invalid",
    });
    expect(readResetLink({ error: "INVALID_TOKEN", token: "abc" })).toEqual({
      kind: "invalid",
    });
  });

  it("reports a missing token", () => {
    expect(readResetLink({})).toEqual({ kind: "missing" });
    expect(readResetLink({ token: "  " })).toEqual({ kind: "missing" });
  });
});

describe("newPasswordProblem", () => {
  const ok = "x".repeat(PASSWORD_MIN_LENGTH);

  it("accepts a long enough, confirmed password", () => {
    expect(newPasswordProblem(ok, ok, "en")).toBeNull();
  });

  it("rejects a short one", () => {
    const short = "x".repeat(PASSWORD_MIN_LENGTH - 1);
    expect(newPasswordProblem(short, short, "en")).toMatch(/at least 8/);
  });

  it("rejects a too long one", () => {
    const long = "x".repeat(129);
    expect(newPasswordProblem(long, long, "en")).toMatch(/at most 128/);
  });

  it("words problems in German", () => {
    expect(newPasswordProblem("kurz", "kurz", "de")).toBe(
      "Verwende mindestens 8 Zeichen.",
    );
    expect(newPasswordProblem(ok, `${ok}y`, "de")).toBe(
      "Die Passwörter stimmen nicht überein.",
    );
  });

  it("rejects a mismatch", () => {
    expect(newPasswordProblem(ok, `${ok}y`, "en")).toMatch(/do not match/);
  });
});

describe("reset errors", () => {
  it("recognizes an unusable link", () => {
    expect(isInvalidTokenError({ status: 400, code: "INVALID_TOKEN" })).toBe(
      true,
    );
    expect(
      isInvalidTokenError({ status: 400, code: "PASSWORD_TOO_SHORT" }),
    ).toBe(false);
  });
});
