import { describe, expect, it } from "vitest";

import {
  normalizeHost,
  normalizePairingCode,
  pairingHostConfig,
  pairingHostRedirect,
} from "./pairing-host";

const hosted = pairingHostConfig({
  NETRICS_PAIRING_HOST: "netrics.tv, WWW.netrics.tv",
  NETRICS_APP_ORIGIN: "https://app.netrics.so/",
});

function redirect(host: string | null, path: string): string | null {
  return pairingHostRedirect(hosted, host, new URL(path, "http://internal"));
}

const APPROVE = "https://app.netrics.so/devices/approve";

describe("pairingHostConfig", () => {
  it("is off unless both variables are set and valid", () => {
    expect(pairingHostConfig({})).toBeNull();
    expect(
      pairingHostConfig({ NETRICS_PAIRING_HOST: "netrics.tv" }),
    ).toBeNull();
    expect(
      pairingHostConfig({ NETRICS_APP_ORIGIN: "https://app.netrics.so" }),
    ).toBeNull();
    expect(
      pairingHostConfig({
        NETRICS_PAIRING_HOST: " , ",
        NETRICS_APP_ORIGIN: "https://app.netrics.so",
      }),
    ).toBeNull();
    for (const origin of ["app.netrics.so", "javascript:alert(1)", "ftp://x"]) {
      expect(
        pairingHostConfig({
          NETRICS_PAIRING_HOST: "netrics.tv",
          NETRICS_APP_ORIGIN: origin,
        }),
      ).toBeNull();
    }
  });

  it("refuses an app origin on a pairing host (a redirect loop)", () => {
    expect(
      pairingHostConfig({
        NETRICS_PAIRING_HOST: "netrics.tv",
        NETRICS_APP_ORIGIN: "https://netrics.tv",
      }),
    ).toBeNull();
  });

  it("keeps only the app origin", () => {
    expect(hosted?.appOrigin).toBe("https://app.netrics.so");
    expect([...(hosted?.hosts ?? [])]).toEqual([
      "netrics.tv",
      "www.netrics.tv",
    ]);
  });
});

describe("pairingHostRedirect", () => {
  it("sends a code in the path to the approval page", () => {
    expect(redirect("netrics.tv", "/ABCD-EFGH")).toBe(
      `${APPROVE}?code=ABCD-EFGH`,
    );
    expect(redirect("netrics.tv", "/abcdefgh")).toBe(
      `${APPROVE}?code=ABCD-EFGH`,
    );
    expect(redirect("netrics.tv", "/abcd%20efgh/")).toBe(
      `${APPROVE}?code=ABCD-EFGH`,
    );
  });

  it("accepts ?code= too", () => {
    expect(redirect("netrics.tv", "/?code=abcdefgh")).toBe(
      `${APPROVE}?code=ABCD-EFGH`,
    );
    expect(redirect("netrics.tv", "/link?code=ABCD-EFGH")).toBe(
      `${APPROVE}?code=ABCD-EFGH`,
    );
  });

  it("drops anything that is not a code", () => {
    for (const path of [
      "/",
      "/%3Cscript%3E",
      "/<script>",
      "/ABCD-EFG",
      "/ABCD-EFGHI",
      "/ABCD--EFGH",
      "/%E0%A4%A",
      "/favicon.ico",
      "/?code=%22%3E%3Cscript%3E",
      "/?code=ABCD-EFGH&code=x&next=https://evil.example",
      "/devices/approve?next=//evil.example",
    ]) {
      const location = redirect("netrics.tv", path);
      expect(
        location === APPROVE || location === `${APPROVE}?code=ABCD-EFGH`,
        path,
      ).toBe(true);
    }
    expect(redirect("netrics.tv", "/<script>")).toBe(APPROVE);
  });

  it("matches the host without case, port or trailing dot", () => {
    expect(redirect("NETRICS.TV:443", "/")).toBe(APPROVE);
    expect(redirect("www.netrics.tv.", "/")).toBe(APPROVE);
  });

  it("leaves every other host alone", () => {
    expect(redirect("app.netrics.so", "/ABCD-EFGH")).toBeNull();
    expect(redirect("netrics.tv.evil.example", "/")).toBeNull();
    expect(redirect("evilnetrics.tv", "/")).toBeNull();
    expect(redirect("localhost:3000", "/")).toBeNull();
    expect(redirect(null, "/")).toBeNull();
  });

  it("does nothing when not configured", () => {
    expect(
      pairingHostRedirect(null, "netrics.tv", new URL("http://x/ABCD-EFGH")),
    ).toBeNull();
  });
});

describe("normalizePairingCode", () => {
  it("normalizes the XXXX-XXXX shape", () => {
    expect(normalizePairingCode(" abcd efgh ")).toBe("ABCD-EFGH");
    expect(normalizePairingCode("A1B2-C3D4")).toBe("A1B2-C3D4");
    expect(normalizePairingCode("ÄBCD-EFGH")).toBeNull();
    expect(normalizePairingCode(null)).toBeNull();
    expect(normalizePairingCode("x".repeat(100))).toBeNull();
  });
});

describe("normalizeHost", () => {
  it("strips port and case", () => {
    expect(normalizeHost("Example.COM:8080")).toBe("example.com");
    expect(normalizeHost("[::1]:3000")).toBe("[::1]");
  });
});
