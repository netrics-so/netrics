import { describe, expect, it } from "vitest";

import { buildVersion } from "./version.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";

describe("buildVersion", () => {
  it("reports the plain version for the commit that sets it", () => {
    expect(
      buildVersion({ version: "0.3.0", parentVersion: "0.2.0", commit }),
    ).toBe("0.3.0");
  });

  it("adds the commit to every later main build of that version", () => {
    expect(
      buildVersion({ version: "0.3.0", parentVersion: "0.3.0", commit }),
    ).toBe("0.3.0+0123456789ab");
  });

  it("treats going back to an older version as a release commit too", () => {
    expect(
      buildVersion({ version: "0.2.1", parentVersion: "0.3.0", commit }),
    ).toBe("0.2.1");
  });

  it.each(["0.3", "v0.3.0", "0.3.0+abc", "0.3.0-dev", ""])(
    "refuses the package version %j",
    (version) => {
      expect(() =>
        buildVersion({ version, parentVersion: "0.2.0", commit }),
      ).toThrow(/package\.json version/);
    },
  );

  it("refuses a commit that is not a full SHA", () => {
    expect(() =>
      buildVersion({ version: "0.3.0", parentVersion: "0.3.0", commit: "abc" }),
    ).toThrow(/commit/);
  });
});
