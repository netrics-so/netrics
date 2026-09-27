import { describe, expect, it } from "vitest";

import { observationKey } from "./transport.js";

describe("observationKey", () => {
  const base = {
    metricKey: "acme.visitors",
    sourceTimestamp: "2026-09-01T00:00:00.000Z",
    value: 1,
    dimensions: { resource: "site-1", country: "DE" },
  };

  it("ignores dimension order and value", () => {
    expect(
      observationKey({
        ...base,
        value: 2,
        dimensions: { country: "DE", resource: "site-1" },
      }),
    ).toBe(observationKey(base));
  });

  it("distinguishes metric, dimensions and timestamp", () => {
    const key = observationKey(base);
    expect(observationKey({ ...base, metricKey: "acme.other" })).not.toBe(key);
    expect(
      observationKey({ ...base, dimensions: { resource: "site-2" } }),
    ).not.toBe(key);
    expect(
      observationKey({ ...base, sourceTimestamp: "2026-09-02T00:00:00.000Z" }),
    ).not.toBe(key);
  });
});
