import { describe, expect, it } from "vitest";

import { connectorAccessNote } from "./connector-note";
import { de } from "@/messages/de";
import { en } from "@/messages/en";

// The permanent access note on a connection page (#872 review): Hetzner
// Cloud cannot tell whether a token can write, so the page says that
// netrics only reads and that a Read token is enough.

describe("the connector access note", () => {
  it("is shown for Hetzner Cloud only", () => {
    expect(connectorAccessNote("hetzner-cloud")).toBe("hetznerCloudReadOnly");
    for (const id of ["railway", "posthog", "vercel", "demo"]) {
      expect(connectorAccessNote(id)).toBeNull();
    }
  });

  it("is worded in English and German", () => {
    const english = en.connections.detail.hetznerCloudReadOnly;
    const german = de.connections.detail.hetznerCloudReadOnly;
    expect(english).toMatch(/only reads/);
    expect(english).toMatch(/Read/);
    expect(german).toMatch(/liest nur/);
    expect(german).not.toBe(english);
    expect(de.connections.detail.hetznerCloudAbout).not.toBe(
      en.connections.detail.hetznerCloudAbout,
    );
  });
});
