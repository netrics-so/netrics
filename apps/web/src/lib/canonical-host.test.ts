import { describe, expect, it } from "vitest";

import { canonicalHostConfig, canonicalHostRedirect } from "./canonical-host";
import { pairingHostConfig, pairingHostRedirect } from "./pairing-host";

const env = {
  NETRICS_PAIRING_HOST: "netrics.tv,www.netrics.tv",
  NETRICS_APP_ORIGIN: "https://app.netrics.so/",
};
const hosted = canonicalHostConfig(env);

function redirect(host: string | null, path: string): string | null {
  return canonicalHostRedirect(hosted, host, new URL(path, "http://internal"));
}

const OLD = "web-production-1234.up.railway.app";

describe("canonicalHostConfig", () => {
  it("is off without a valid NETRICS_APP_ORIGIN", () => {
    expect(canonicalHostConfig({})).toBeNull();
    expect(canonicalHostConfig({ NETRICS_APP_ORIGIN: " " })).toBeNull();
    expect(
      canonicalHostConfig({ NETRICS_PAIRING_HOST: "netrics.tv" }),
    ).toBeNull();
    for (const origin of ["app.netrics.so", "javascript:alert(1)", "ftp://x"]) {
      expect(canonicalHostConfig({ NETRICS_APP_ORIGIN: origin })).toBeNull();
    }
  });

  it("needs no pairing host", () => {
    const config = canonicalHostConfig({
      NETRICS_APP_ORIGIN: "https://app.netrics.so",
    });
    expect(canonicalHostRedirect(config, OLD, new URL("http://x/login"))).toBe(
      "https://app.netrics.so/login",
    );
  });

  it("serves the app origin's host and the pairing hosts in place", () => {
    expect(hosted?.appOrigin).toBe("https://app.netrics.so");
    expect([...(hosted?.hosts ?? [])].sort()).toEqual([
      "app.netrics.so",
      "netrics.tv",
      "www.netrics.tv",
    ]);
  });
});

describe("canonicalHostRedirect", () => {
  it("leaves the app origin's host alone", () => {
    expect(redirect("app.netrics.so", "/")).toBeNull();
    expect(redirect("app.netrics.so", "/login?next=%2Fx")).toBeNull();
  });

  it("moves other hosts to the same path and query", () => {
    expect(redirect(OLD, "/")).toBe("https://app.netrics.so/");
    expect(redirect(OLD, "/login?next=%2Fx")).toBe(
      "https://app.netrics.so/login?next=%2Fx",
    );
    expect(redirect("localhost:3190", "/workspaces/w1?tab=a&b=c")).toBe(
      "https://app.netrics.so/workspaces/w1?tab=a&b=c",
    );
    expect(redirect("web.railway.internal:8080", "/status")).toBe(
      "https://app.netrics.so/status",
    );
  });

  it("moves browser API and auth calls too", () => {
    expect(redirect(OLD, "/v1/workspaces")).toBe(
      "https://app.netrics.so/v1/workspaces",
    );
    expect(redirect(OLD, "/v1/devices")).toBe(
      "https://app.netrics.so/v1/devices",
    );
    expect(redirect(OLD, "/v1/serverx")).toBe(
      "https://app.netrics.so/v1/serverx",
    );
    expect(redirect(OLD, "/v1/device")).toBe(
      "https://app.netrics.so/v1/device",
    );
    expect(redirect(OLD, "/api/auth/sign-in/email")).toBe(
      "https://app.netrics.so/api/auth/sign-in/email",
    );
    expect(redirect(OLD, "/healthz/x")).toBe(
      "https://app.netrics.so/healthz/x",
    );
    expect(redirect(OLD, "/kiosk/x")).toBe("https://app.netrics.so/kiosk/x");
  });

  it("serves health checks, the device API, the kiosk and assets anywhere", () => {
    for (const path of [
      "/healthz",
      "/v1/server",
      "/v1/device/me",
      "/v1/device/dashboard?x=1",
      "/v1/device/pairings/poll",
      "/kiosk",
      "/kiosk?debug=1",
      "/_next/static/chunks/main.js",
    ]) {
      expect(redirect(OLD, path), path).toBeNull();
    }
  });

  it("never leaves the app origin", () => {
    const url = new URL("http://internal//evil.example/x");
    expect(url.pathname).toBe("//evil.example/x");
    expect(canonicalHostRedirect(hosted, OLD, url)).toBe(
      "https://app.netrics.so//evil.example/x",
    );
    expect(redirect(OLD, "/%2F%2Fevil.example")).toBe(
      "https://app.netrics.so/%2F%2Fevil.example",
    );
  });

  it("matches the host without case, port or trailing dot", () => {
    expect(redirect("APP.Netrics.SO", "/")).toBeNull();
    expect(redirect("app.netrics.so:443", "/")).toBeNull();
    expect(redirect("app.netrics.so.", "/")).toBeNull();
    expect(redirect("app.netrics.so.evil.example", "/")).toBe(
      "https://app.netrics.so/",
    );
  });

  it("leaves pairing hosts to the pairing redirect", () => {
    expect(redirect("netrics.tv", "/ABCD-EFGH")).toBeNull();
    expect(redirect("WWW.netrics.tv.", "/")).toBeNull();
    expect(
      pairingHostRedirect(
        pairingHostConfig(env),
        "netrics.tv",
        new URL("http://x/ABCD-EFGH"),
      ),
    ).toBe("https://app.netrics.so/devices/approve?code=ABCD-EFGH");
  });

  it("passes requests without a Host header", () => {
    expect(redirect(null, "/")).toBeNull();
    expect(redirect("", "/")).toBeNull();
  });

  it("does nothing when not configured", () => {
    expect(canonicalHostRedirect(null, OLD, new URL("http://x/"))).toBeNull();
  });
});
