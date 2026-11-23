import { describe, expect, it } from "vitest";

import { emptyBuilderState } from "./custom-api-builder";
import {
  builderStorageKey,
  clearStoredBuilders,
  parseStoredBuilder,
  serializeStoredBuilder,
} from "./custom-api-storage";
import { TEST_RESPONSE } from "@/components/custom-api/test-fixtures";

// The builder's session copy (#807, review of #824).

const DEF = "33333333-3333-4333-8333-333333333333";

describe("builder session copy", () => {
  it("keeps the loaded version and drops the last test answer", () => {
    const state = {
      ...emptyBuilderState("en", "UTC"),
      lastTest: TEST_RESPONSE,
    };
    const raw = serializeStoredBuilder({
      state,
      step: "review",
      definitionId: DEF,
      baseVersion: 3,
    });
    expect(raw).not.toContain("recordArrays");
    expect(parseStoredBuilder(raw, DEF)).toMatchObject({
      step: "review",
      baseVersion: 3,
      state: { lastTest: null },
    });
  });

  it("ignores a copy of another definition, another shape or garbage", () => {
    const raw = serializeStoredBuilder({
      state: emptyBuilderState("en", "UTC"),
      step: "login",
      definitionId: null,
      baseVersion: null,
    });
    expect(parseStoredBuilder(raw, null)).not.toBeNull();
    expect(parseStoredBuilder(raw, DEF)).toBeNull();
    expect(
      parseStoredBuilder(raw.replace('"version":2', '"version":0'), null),
    ).toBeNull();
    expect(parseStoredBuilder("{", null)).toBeNull();
    expect(parseStoredBuilder('{"version":2,"step":"nope"}', null)).toBeNull();
  });

  it("reads a copy from before #869 with its kept POST body", () => {
    const state = emptyBuilderState("en", "UTC");
    const { method: _method, body: _body, ...stream } = state.stream;
    const { readOnly: _readOnly, ...rest } = state;
    const raw = JSON.stringify({
      version: 1,
      state: {
        ...rest,
        stream: {
          ...stream,
          path: "/query",
          post: {
            method: "POST",
            body: { kind: "json", value: { q: 1 }, readOnlyConfirmed: true },
          },
        },
      },
      step: "request",
      definitionId: null,
      baseVersion: null,
    });
    const parsed = parseStoredBuilder(raw, null)!;
    expect(parsed.state.stream.method).toBe("POST");
    expect(parsed.state.stream.body.kind).toBe("json");
    expect(JSON.parse(parsed.state.stream.body.json)).toEqual({ q: 1 });
    expect(parsed.state.stream).not.toHaveProperty("post");
    // No confirmation was kept then: the save asks again.
    expect(parsed.state.readOnly).toEqual({});
  });

  it("is keyed by workspace and draft, and sign-out clears every copy", () => {
    expect(builderStorageKey("w1", "d1")).not.toBe(
      builderStorageKey("w2", "d1"),
    );
    const items = new Map<string, string>([
      [builderStorageKey("w1", "d1"), "x"],
      [builderStorageKey("w2", "d2"), "y"],
      ["other.key", "z"],
    ]);
    const storage = {
      get length() {
        return items.size;
      },
      key: (i: number) => [...items.keys()][i] ?? null,
      removeItem: (key: string) => void items.delete(key),
    };
    clearStoredBuilders(storage);
    expect([...items.keys()]).toEqual(["other.key"]);
  });
});
