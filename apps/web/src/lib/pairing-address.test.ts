import { describe, expect, it } from "vitest";

import { pairingAddress } from "./pairing-address";

describe("pairingAddress", () => {
  it("shows host and path without scheme or trailing slash", () => {
    expect(pairingAddress("https://netrics.tv")).toBe("netrics.tv");
    expect(pairingAddress("https://netrics.tv/")).toBe("netrics.tv");
    expect(pairingAddress("https://app.example.com/devices/approve")).toBe(
      "app.example.com/devices/approve",
    );
    expect(pairingAddress("http://nas.local:8080/devices/approve/")).toBe(
      "nas.local:8080/devices/approve",
    );
  });

  it("passes through what is not a URL", () => {
    expect(pairingAddress("netrics.tv")).toBe("netrics.tv");
  });
});
