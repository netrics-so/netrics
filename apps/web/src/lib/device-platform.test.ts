import { describe, expect, it } from "vitest";

import {
  approveQuery,
  connectTvHref,
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

describe("the approval page's query (#835)", () => {
  it("reads the code, workspace and dashboard and returns to them after sign-in", () => {
    const query = approveQuery({
      code: "ABCD-EFGH",
      workspace: "w1",
      dashboard: "d1",
    });
    expect(query).toEqual({
      code: "ABCD-EFGH",
      workspace: "w1",
      dashboard: "d1",
      here: "/devices/approve?code=ABCD-EFGH&workspace=w1&dashboard=d1",
    });
    // The login's `next` brings the person back to the same choice.
    const next = new URL(query.here, "https://app.example");
    expect(next.searchParams.get("workspace")).toBe("w1");
    expect(next.searchParams.get("dashboard")).toBe("d1");
  });
  it("round-trips the link Connect a TV makes", () => {
    const link = new URL(connectTvHref("w1", "d1"), "https://app.example");
    const query = approveQuery(Object.fromEntries(link.searchParams));
    expect(query.here).toBe(connectTvHref("w1", "d1"));
  });
  it("ignores repeated or missing values and cuts long ones", () => {
    expect(approveQuery({})).toEqual({
      code: "",
      workspace: "",
      dashboard: "",
      here: "/devices/approve",
    });
    expect(
      approveQuery({ workspace: ["a", "b"], code: "X".repeat(40) }),
    ).toEqual({
      code: "X".repeat(20),
      workspace: "",
      dashboard: "",
      here: `/devices/approve?code=${"X".repeat(20)}`,
    });
  });
});
