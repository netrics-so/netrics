import { describe, expect, it } from "vitest";

import {
  emptyFocusMemory,
  focusLeft,
  focusMoved,
  focusWasTaken,
  type FocusMemory,
} from "./focus-handoff";

// The focus keeper's state machine (#854): what it remembers from focus
// events, and when it says that an update took the focus away.

interface Fake {
  isConnected: boolean;
  disabled: boolean;
  matches: (selector: string) => boolean;
  contains: (other: unknown) => boolean;
}
const fake = (inside: unknown[] = []): Fake => {
  const element: Fake = {
    isConnected: true,
    disabled: false,
    matches: (selector) => selector === ":disabled" && element.disabled,
    contains: (other) => other === element || inside.includes(other),
  };
  return element;
};
const el = (value: Fake) => value as unknown as Element;

function world() {
  const button = fake();
  const other = fake();
  const outside = fake();
  const region = fake([button, other]);
  const body = fake();
  const memory: FocusMemory<string> = emptyFocusMemory();
  const zoneOf = (element: Element) =>
    element === el(button) ? "button" : "other";
  const focus = (target: Fake | null) =>
    focusMoved(memory, target && el(target), el(region), zoneOf);
  const taken = (active: Fake | null) =>
    focusWasTaken(memory, active && el(active), el(body));
  const blur = (target: Fake, related: Fake | null = null) =>
    focusLeft(memory, el(target), related && el(related), el(region));
  return { button, other, outside, region, body, memory, focus, blur, taken };
}

describe("the focus keeper's memory", () => {
  it("remembers the focused element of the region, with its zone", () => {
    const { button, other, memory, focus } = world();
    expect(memory.last).toBeNull();
    focus(button);
    expect(memory).toEqual({ last: button, zone: "button" });
    focus(other);
    expect(memory).toEqual({ last: other, zone: "other" });
  });

  it("forgets it when the focus goes to an element outside", () => {
    const { button, outside, memory, focus } = world();
    focus(button);
    focus(outside);
    expect(memory).toEqual({ last: null, zone: undefined });
    focus(null);
    expect(memory.last).toBeNull();
  });
});

describe("whether an update took the focus away", () => {
  it("yes: the focused element was removed and the focus is on the page", () => {
    const { button, body, focus, taken } = world();
    focus(button);
    button.isConnected = false;
    expect(taken(body)).toBe(true);
    expect(taken(null)).toBe(true);
  });

  it("yes: the focused element was disabled, the focus on the page or still on it", () => {
    const { button, body, focus, taken } = world();
    focus(button);
    button.disabled = true;
    expect(taken(body)).toBe(true);
    expect(taken(button)).toBe(true);
  });

  it("no: the user tabbed onto it after the update had started, and it stays", () => {
    // Nothing is sampled before an update: a focus that arrives at any
    // time is remembered, and nothing is owed while its element is there.
    const { button, body, focus, taken } = world();
    focus(button);
    expect(taken(button)).toBe(false);
    expect(taken(body)).toBe(false);
  });

  it("yes: the user tabbed onto it at the last moment, then it was removed", () => {
    const { button, other, body, focus, taken } = world();
    focus(other);
    focus(button);
    button.isConnected = false;
    expect(taken(body)).toBe(true);
  });

  it("no: the user moved elsewhere before the element went", () => {
    const { button, outside, body, focus, taken } = world();
    focus(button);
    focus(outside);
    button.isConnected = false;
    expect(taken(outside)).toBe(false);
    expect(taken(body)).toBe(false);
  });

  it("no: the element went, but the focus is already on another element", () => {
    const { button, other, focus, taken } = world();
    focus(button);
    button.isConnected = false;
    expect(taken(other)).toBe(false);
  });

  it("no: nothing in the region ever had the focus", () => {
    const { button, body, taken } = world();
    button.isConnected = false;
    expect(taken(body)).toBe(false);
  });

  it("no: a click on the page leaves the element in place", () => {
    const { button, body, focus, taken } = world();
    focus(button);
    expect(taken(body)).toBe(false);
  });
});

describe("a blur of the remembered element", () => {
  it("forgets it when the user clicked on the page: no loss when it goes later", () => {
    // A click on text blurs the button and focuses nothing: no focus
    // event follows. The list then loads and removes the button.
    const { button, body, memory, focus, blur, taken } = world();
    focus(button);
    blur(button);
    expect(memory).toEqual({ last: null, zone: undefined });
    button.isConnected = false;
    expect(taken(body)).toBe(false);
  });

  it("forgets it when the focus goes outside the region", () => {
    const { button, outside, memory, focus, blur } = world();
    focus(button);
    blur(button, outside);
    expect(memory.last).toBeNull();
  });

  it("keeps it when the focus moves within the region", () => {
    const { button, other, memory, focus, blur } = world();
    focus(button);
    blur(button, other);
    expect(memory.last).toBe(button);
  });

  it("keeps it when the update caused the blur: removed or disabled", () => {
    const removed = world();
    removed.focus(removed.button);
    removed.button.isConnected = false;
    removed.blur(removed.button);
    expect(removed.taken(removed.body)).toBe(true);
    const disabled = world();
    disabled.focus(disabled.button);
    disabled.button.disabled = true;
    disabled.blur(disabled.button);
    expect(disabled.taken(disabled.body)).toBe(true);
  });

  it("ignores the blur of another element", () => {
    const { button, other, memory, focus, blur } = world();
    focus(button);
    blur(other);
    expect(memory.last).toBe(button);
  });
});
