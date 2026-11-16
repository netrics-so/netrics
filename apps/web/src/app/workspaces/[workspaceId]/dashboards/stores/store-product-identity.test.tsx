import { describe, expect, it } from "vitest";
import type { StoreTemplateProducts } from "@netrics/contracts";

import { renderI18n } from "@/lib/i18n/test-render";

import {
  StoreProductIdentity,
  StoreProductIdentityUnavailable,
} from "./store-product-identity";

const W = "00000000-0000-4000-8000-000000000001";
const REQUEST = "00000000-0000-4000-8000-0000000000f1";
const APPLE = "00000000-0000-4000-8000-0000000000a1";
const PLAY = "00000000-0000-4000-8000-0000000000a2";
const VERCEL = "00000000-0000-4000-8000-0000000000a3";
const products: StoreTemplateProducts = {
  requestId: REQUEST,
  products: [
    {
      productId: "product:focus",
      name: "Focus",
      apps: [
        {
          connectionId: APPLE,
          appId: "123",
          name: "Focus",
          connectorId: "app-store-connect",
        },
      ],
      icon: {
        id: "00000000-0000-4000-8000-0000000000c1",
        name: "Focus icon",
        contentType: "image/png",
        bytes: 10,
        width: 1024,
        height: 1024,
        sha256: "a".repeat(64),
        origin: "resource_icon",
        connectionId: APPLE,
        resourceId: "123",
        createdAt: "2026-11-01T00:00:00.000Z",
        url: "/v1/workspaces/w/images/focus",
      },
      iconSource: { connectionId: APPLE, resourceId: "123" },
      pricing: "auto",
      hadProceeds: true,
      paid: true,
      website: {
        connectionId: VERCEL,
        projectId: "prj_focus",
        name: "focus.app",
      },
    },
    {
      productId: PLAY + ":com.timer",
      name: "Timer",
      apps: [
        {
          connectionId: PLAY,
          appId: "com.timer",
          name: "Timer",
          connectorId: "google-play",
        },
      ],
      icon: null,
      iconSource: { connectionId: PLAY, resourceId: "com.timer" },
      pricing: "auto",
      hadProceeds: false,
      paid: false,
      website: null,
    },
  ],
  websites: [
    {
      connectionId: VERCEL,
      name: "Websites",
      projects: [{ id: "prj_focus", name: "focus.app" }],
    },
  ],
};
const selected = (html: string) =>
  [...html.matchAll(/<option[^>]*selected=""[^>]*>([^<]*)</g)].map(
    (match) => match[1],
  );

describe("store product identity", () => {
  it("shows each app's icon, automatic paid or free and website", () => {
    const html = renderI18n(
      <StoreProductIdentity
        workspaceId={W}
        requestId={REQUEST}
        initial={products}
      />,
    );
    expect(html).toContain("App identity");
    expect(html).toContain('src="/v1/workspaces/w/images/focus"');
    // Only the app without an icon offers to get one.
    expect(html.match(/Use app icon/g)).toHaveLength(1);
    expect(selected(html)).toEqual([
      "Automatic (now paid: proceeds in the last 90 days)",
      "focus.app",
      "Automatic (now free: no proceeds in the last 90 days)",
      "No website",
    ]);
    expect(html).not.toContain("connect Vercel Web Analytics first");
  });

  it("speaks German and points to Vercel when no website can be linked", () => {
    const html = renderI18n(
      <StoreProductIdentity
        workspaceId={W}
        requestId={REQUEST}
        initial={{
          ...products,
          products: [{ ...products.products[1]!, pricing: "paid" }],
          websites: [],
        }}
      />,
      "de",
    );
    expect(html).toContain("App-Identität");
    expect(selected(html)).toEqual(["Kostenpflichtig", "Keine Website"]);
    expect(html).toContain("verbinde zuerst Vercel Web Analytics");
    expect(html).toContain(`href="/workspaces/${W}/sources"`);
  });

  it("is read-only while a scope change applies", () => {
    const html = renderI18n(
      <StoreProductIdentity
        workspaceId={W}
        requestId={REQUEST}
        initial={products}
        locked
      />,
    );
    const controls = [...html.matchAll(/<(select|button)[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control).toContain('disabled=""');
  });

  it("keeps product ids that are object property names apart", () => {
    // Valid ids in the editable Products table: no inherited property.
    const html = renderI18n(
      <StoreProductIdentity
        workspaceId={W}
        requestId={REQUEST}
        initial={{
          ...products,
          products: ["constructor", "__proto__", "toString"].map(
            (productId) => ({ ...products.products[1]!, productId }),
          ),
        }}
      />,
    );
    expect(selected(html)).toEqual(
      Array.from({ length: 3 }, () => [
        "Automatic (now free: no proceeds in the last 90 days)",
        "No website",
      ]).flat(),
    );
  });

  it("explains an identity that cannot be read, without the editor", () => {
    const html = renderI18n(
      <StoreProductIdentityUnavailable
        error={{ status: 413, code: "data_source_row_limit" }}
      />,
    );
    expect(html).toContain("App identity");
    expect(html).toContain('role="alert"');
    expect(html).toContain("row limit");
    expect(html).not.toContain("<select");
  });
});
