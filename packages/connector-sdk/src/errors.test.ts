import { describe, expect, it } from "vitest";

import { ConnectorError, isErrorCode } from "./errors.js";
import { checkResultSchema, errorCodeSchema } from "./transport.js";

// Reason codes (SDK 0.2.18, #795): a fixed word next to a message, never
// text. Optional everywhere: connectors that set none keep working.

const CODES = ["acme.key_revoked", "acme", "acme.v2.quota_used_up", "a1_b2"];
const NOT_CODES = [
  "",
  "The key was revoked",
  "KEY_REVOKED",
  "acme.",
  ".acme",
  "acme..key",
  "acme-key",
  "acme.key revoked",
  `a${"_a".repeat(32)}`,
];

describe("reason codes", () => {
  it("accepts lowercase words joined by _ or ., up to 64 characters", () => {
    for (const code of CODES) {
      expect(isErrorCode(code), code).toBe(true);
      expect(errorCodeSchema.safeParse(code).success, code).toBe(true);
    }
    expect(isErrorCode("a".repeat(64))).toBe(true);
  });

  it("refuses text, upper case and empty parts", () => {
    for (const code of [...NOT_CODES, 42, null, undefined]) {
      expect(isErrorCode(code), String(code)).toBe(false);
      expect(errorCodeSchema.safeParse(code).success, String(code)).toBe(false);
    }
  });
});

describe("ConnectorError", () => {
  it("carries its code next to the message", () => {
    const error = new ConnectorError(
      "The key was revoked.",
      "acme.key_revoked",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConnectorError");
    expect(error.message).toBe("The key was revoked.");
    expect(error.code).toBe("acme.key_revoked");
  });

  it("refuses a code that is not a fixed word", () => {
    for (const code of NOT_CODES) {
      expect(() => new ConnectorError("failed", code), code).toThrow(TypeError);
    }
  });
});

describe("a check result", () => {
  it("may name the reason of a failure", () => {
    expect(
      checkResultSchema.parse({
        ok: false,
        message: "The key was revoked.",
        code: "acme.key_revoked",
      }),
    ).toEqual({
      ok: false,
      message: "The key was revoked.",
      code: "acme.key_revoked",
    });
  });

  it("needs none: results of connectors before 0.2.18 stay valid", () => {
    expect(checkResultSchema.parse({ ok: false, message: "No." })).toEqual({
      ok: false,
      message: "No.",
    });
    expect(checkResultSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it("refuses text in place of a code", () => {
    expect(
      checkResultSchema.safeParse({ ok: false, code: "The key was revoked" })
        .success,
    ).toBe(false);
  });
});
