import { afterEach, describe, expect, it, vi } from "vitest";

import { holdsFocus } from "./focus-handoff";

// Focus is handed on only by a control that still has it (#854).

const element = (inside: unknown[] = []) =>
  ({
    contains: (other: unknown) => inside.includes(other),
  }) as unknown as Element;

describe("holdsFocus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is true for the focused element and for a region around it", () => {
    const button = element();
    const self = element([button]);
    vi.stubGlobal("document", { activeElement: button });
    expect(holdsFocus(self)).toBe(true);
    const form = element([button]);
    expect(holdsFocus(form)).toBe(true);
  });

  it("is false once the user has moved elsewhere, or to nothing", () => {
    const button = element();
    const region = element([button]);
    const elsewhere = element();
    vi.stubGlobal("document", { activeElement: elsewhere });
    expect(holdsFocus(region)).toBe(false);
    vi.stubGlobal("document", { activeElement: null });
    expect(holdsFocus(region)).toBe(false);
  });

  it("is false without a region or a document", () => {
    expect(holdsFocus(element())).toBe(false);
    vi.stubGlobal("document", { activeElement: element() });
    expect(holdsFocus(null)).toBe(false);
    expect(holdsFocus(undefined)).toBe(false);
  });
});
