import { describe, expect, it } from "vitest";

import { redactCredentialValues, redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("redacts secret-looking object keys at any depth", () => {
    const input = {
      connection: "demo",
      token: "abc123",
      meta: { nested: { api_secret: "shh" } },
      list: [{ password: "hunter2", ok: 1 }],
    };
    // A key matching the pattern redacts its whole subtree.
    expect(redactSecrets(input)).toEqual({
      connection: "demo",
      token: "[redacted]",
      meta: { nested: { api_secret: "[redacted]" } },
      list: [{ password: "[redacted]", ok: 1 }],
    });
    // input is not mutated
    expect(input.token).toBe("abc123");
  });

  it("leaves non-object input untouched and survives cycles", () => {
    expect(redactSecrets("plain string")).toBe("plain string");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(redactSecrets(cyclic)).toEqual({ self: "[circular]" });
  });
});

describe("redactCredentialValues", () => {
  it("replaces credential values wherever they appear in a message", () => {
    const message = redactCredentialValues(
      "provider rejected token sk-live-1234 (sk-live-1234)",
      { token: "sk-live-1234" },
    );
    expect(message).toBe("provider rejected token [redacted] ([redacted])");
    expect(message).not.toContain("sk-live-1234");
  });

  it("walks nested credential structures and ignores short values", () => {
    const message = redactCredentialValues(
      "failed for x=ab and y=long-secret",
      {
        outer: { pin: "ab", key: "long-secret" },
      },
    );
    expect(message).toBe("failed for x=ab and y=[redacted]");
  });
});
