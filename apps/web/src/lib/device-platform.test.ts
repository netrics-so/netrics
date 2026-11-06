import { describe, expect, it } from "vitest";

import {
  completePairingCode,
  hasRotationSetting,
  isHandheld,
} from "./device-platform";

describe("completePairingCode", () => {
  it("normalizes a complete code as the server compares it", () => {
    expect(completePairingCode("ACDE-FGHJ")).toBe("ACDEFGHJ");
    expect(completePairingCode(" acde fghj ")).toBe("ACDEFGHJ");
    expect(completePairingCode("acdefghj")).toBe("ACDEFGHJ");
  });

  it("is null until the code is complete, and for anything else", () => {
    for (const input of ["", "ACDE", "ACDE-FGH", "ACDE-FGHJK", "ACDE_FGHJ"]) {
      expect(completePairingCode(input)).toBeNull();
    }
  });
});

describe("platform rules (#406)", () => {
  it("offers rotation to TVs, kiosks and devices without a platform", () => {
    expect(hasRotationSetting("tvos")).toBe(true);
    expect(hasRotationSetting("web")).toBe(true);
    expect(hasRotationSetting(null)).toBe(true);
    expect(hasRotationSetting("ipados")).toBe(false);
    expect(hasRotationSetting("ios")).toBe(false);
  });

  it("treats iPads and iPhones as handheld", () => {
    expect(isHandheld("ios")).toBe(true);
    expect(isHandheld("ipados")).toBe(true);
    expect(isHandheld("tvos")).toBe(false);
    expect(isHandheld("web")).toBe(false);
    expect(isHandheld(null)).toBe(false);
  });
});
