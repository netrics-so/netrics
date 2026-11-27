import { describe, expect, it } from "vitest";

import {
  boundedPreview,
  CUSTOM_API_TEST_LIMITS,
  redactEchoes,
  redactText,
  redactUrl,
  secretSetOf,
} from "./preview.js";

// The builder's test response is redacted by value and bounded (#806,
// Review Focus 2 and 3).

const none = secretSetOf({}, {});
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("redaction of large values (ADR 0030 review)", () => {
  // A rendered POST body of up to 128 KiB, non-ASCII: its percent-encoded
  // forms alone would make one combined pattern too large for V8.
  const body = JSON.stringify({
    q: "ü€".repeat(20_000),
    tenant: "acme-tenant",
  });

  it("matches rendered bodies as plain text, next to the secrets", () => {
    const secrets = secretSetOf({ token: "tok-123456" }, {}, [], [body]);
    expect(redactText(`echo ${body} tok-123456`, secrets)).toBe(
      "echo [redacted] [redacted]",
    );
    expect(redactText(JSON.stringify({ echo: body }), secrets)).toBe(
      '{"echo":"[redacted]"}',
    );
    expect(boundedPreview({ echo: body }, secrets).body).toEqual({
      echo: "[redacted]",
    });
  });

  it("never throws, nor names a secret, when the secrets' pattern would be too large", () => {
    const huge = Array.from(
      { length: 20 },
      (_, i) => `${i}-${"ü€/ +".repeat(1_600)}`,
    );
    let secrets: ReturnType<typeof secretSetOf> | undefined;
    expect(() => {
      secrets = secretSetOf(
        { token: "tok-123456" },
        Object.fromEntries(huge.map((value, i) => [`v${i}`, value])),
      );
    }).not.toThrow();
    const text = `a ${huge[3]} b ${encodeURIComponent(huge[7]!)} c ${encodeURIComponent(huge[9]!).toLowerCase()} tok-123456`;
    expect(redactText(text, secrets!)).toBe(
      "a [redacted] b [redacted] c [redacted] [redacted]",
    );
  });

  it("matches percent-escapes in mixed hex case when the pattern would be too large (#885)", () => {
    const huge = Array.from(
      { length: 20 },
      (_, i) => `${i}-${"ü€/ +".repeat(1_600)}`,
    );
    const secrets = secretSetOf(
      {},
      Object.fromEntries(huge.map((value, i) => [`v${i}`, value])),
    );
    expect(secrets.pattern).toBeNull();
    let escape = 0;
    // `%c3%BC`, `%C3%bc`, `%e2%8A%AC`…: each escape in another case,
    // and digits within one escape mixed too (`%cB`).
    const mixed = (value: string) =>
      encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (e) => {
        escape += 1;
        return escape % 3 === 0
          ? e.toLowerCase()
          : escape % 3 === 1
            ? e
            : `%${e[1]!.toLowerCase()}${e[2]}`;
      });
    const text = `a ${mixed(huge[4]!)} b ${mixed(huge[11]!)} c`;
    expect(text).toMatch(/%c3%BC|%C3%bc|%c3%Bc|%C3%BC%e2/);
    expect(redactText(text, secrets)).toBe("a [redacted] b [redacted] c");
    // Nothing else changes: escapes outside a secret keep their case.
    expect(redactText(`x%c3%BCy ${mixed(huge[0]!)}`, secrets)).toBe(
      "x%c3%BCy [redacted]",
    );
  });
});

describe("redaction", () => {
  it("redacts an echoed token in values, keys, URL-encoded form and URLs", () => {
    const secrets = secretSetOf({ token: "tok/en+value" }, {});
    const out = boundedPreview(
      {
        me: "tok/en+value",
        "tok/en+value": 1,
        link: "https://api.example.test/x?k=tok%2Fen%2Bvalue",
        form: "k=tok%2Fen%2Bvalue",
      },
      secrets,
    );
    expect(JSON.stringify(out.body)).not.toMatch(
      /tok\/en\+value|tok%2Fen%2Bvalue/,
    );
    expect(out.body).toMatchObject({ me: "[redacted]", "[redacted]": 1 });
    expect(
      redactUrl(
        "https://u:p@api.example.test/a?api_key=tok%2Fen%2Bvalue",
        secrets,
      ),
    ).toBe("https://api.example.test/a?api_key=[redacted]");
  });

  it("redacts secret variable values and derived values, never the host", () => {
    const secrets = secretSetOf(
      { host: "api.example.test", username: "user-1", password: "pass-1" },
      { tenant: "tenant secret" },
      ["Basic dXNlci0xOnBhc3MtMQ=="],
    );
    expect(
      redactText(
        "api.example.test said tenant secret / tenant+secret / tenant%20secret, Basic dXNlci0xOnBhc3MtMQ== for pass-1",
        secrets,
      ),
    ).toBe(
      "api.example.test said [redacted] / [redacted] / [redacted], [redacted] for [redacted]",
    );
  });

  it("keeps an OAuth envelope's hosts and client ID readable (#834)", () => {
    const secrets = secretSetOf(
      {
        host: "api.example.test:8443",
        hosts: ["api.example.test", "auth.example.test"],
        clientId: "client-123",
        clientSecret: "client-secret-1",
        refreshToken: null,
      },
      {},
    );
    expect(
      redactUrl(
        "https://api.example.test:8443/items?client_id=client-123&s=client-secret-1",
        secrets,
      ),
    ).toBe(
      "https://api.example.test:8443/items?client_id=client-123&s=[redacted]",
    );
  });

  it("redacts lowercase percent-escapes, JSON-escaped forms and URLs that new URL() re-encodes", () => {
    const secrets = secretSetOf({ token: "tok/en+value" }, {});
    expect(redactText("a tok%2fen%2bvalue b TOK%2Fen%2Bvalue", secrets)).toBe(
      "a [redacted] b TOK%2Fen%2Bvalue",
    );
    expect(redactText('{"k":"tok\\/en+value"}', secrets)).toBe(
      '{"k":"[redacted]"}',
    );
    const quoted = secretSetOf({ token: "ab'cd/ef(x)" }, {});
    expect(redactUrl("https://api.example.test/p?k=ab'cd/ef(x)", quoted)).toBe(
      "https://api.example.test/p?k=[redacted]",
    );
    const escaped = secretSetOf({ token: 'q"uo\\te-1' }, {});
    expect(redactText(JSON.stringify({ v: 'q"uo\\te-1' }), escaped)).toBe(
      '{"v":"[redacted]"}',
    );
  });

  it("ignores values shorter than 4 characters", () => {
    const secrets = secretSetOf({ token: "abc" }, {});
    expect(redactText("abcabc", secrets)).toBe("abcabc");
  });
});

describe("boundedPreview", () => {
  it("keeps a 100,000-item array under 256 KiB with a count of what is left out", () => {
    const out = boundedPreview(
      { data: range(100_000).map((i) => ({ i })) },
      none,
    );
    expect(Buffer.byteLength(JSON.stringify(out.body))).toBeLessThanOrEqual(
      262_144,
    );
    expect(out.truncated).toBe(true);
    const data = (out.body as { data: unknown[] }).data;
    expect(data).toHaveLength(51);
    expect(data.at(-1)).toBe("… 99950 more");
    expect(out.omitted.arrays).toBe(1);
  });

  it("cuts long strings and deep nesting", () => {
    const long = "x".repeat(5_000_000);
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    const out = boundedPreview({ long, deep }, none);
    const body = out.body as { long: string; deep: unknown };
    expect(body.long.endsWith("… (5000000 characters)")).toBe(true);
    expect(body.long.length).toBe(
      CUSTOM_API_TEST_LIMITS.stringChars + "… (5000000 characters)".length,
    );
    expect(JSON.stringify(body.deep)).toContain("… (nested deeper)");
    expect(out.omitted).toEqual({ arrays: 0, strings: 1, depth: 1, bytes: 0 });
    expect(out.truncated).toBe(true);
  });

  it("names the original length when the budget cuts a long string further", () => {
    const out = boundedPreview({ long: "x".repeat(10_000) }, none, 600);
    const long = (out.body as { long: string }).long;
    expect(long).toMatch(/^x+… \(10000 characters\)$/);
    expect(long.match(/…/g)).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(out.body))).toBeLessThanOrEqual(
      600,
    );
  });

  it("cuts arrays once the serialized budget is used and says how many items are left out", () => {
    const row = { text: "y".repeat(1_900), more: "z".repeat(1_900) };
    const out = boundedPreview(
      { a: range(50).map(() => row), b: range(50).map(() => row), c: [1] },
      none,
    );
    expect(Buffer.byteLength(JSON.stringify(out.body))).toBeLessThanOrEqual(
      262_144,
    );
    const body = out.body as { a: unknown[]; b: unknown[]; c: unknown[] };
    expect(body.a).toHaveLength(50);
    expect(String(body.b.at(-1))).toMatch(/^… \d+ more$/);
    expect(out.truncated).toBe(true);
  });

  it("bounds the work on hostile shapes, not only the output (review #820)", () => {
    // A depth-3 nested array of about 2 MB.
    const nested = range(90).map(() => range(90).map(() => range(90)));
    expect(JSON.stringify(nested).length).toBeGreaterThan(1_500_000);
    // An object of 20,000 small arrays.
    const wide = Object.fromEntries(
      range(20_000).map((i) => [`id${i}`, range(10)]),
    );
    for (const body of [nested, wide]) {
      const started = performance.now();
      const out = boundedPreview(body, secretSetOf({ token: "abcdefgh" }, {}));
      expect(performance.now() - started).toBeLessThan(500);
      expect(out.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(out.body))).toBeLessThanOrEqual(
        CUSTOM_API_TEST_LIMITS.previewBytes,
      );
    }
  });

  it("cuts objects with too many keys and marks it", () => {
    const wide = Object.fromEntries(range(20_000).map((i) => [`k${i}`, i]));
    const out = boundedPreview(wide, none);
    const body = out.body as Record<string, unknown>;
    expect(Object.keys(body).length).toBeLessThan(20_000);
    expect(String(body["…"])).toMatch(/^\d+ more keys$/);
  });

  it("stays within a smaller byte budget when one is given", () => {
    const out = boundedPreview(
      { rows: range(50).map(() => ({ t: "x".repeat(1_500) })) },
      none,
      10_000,
    );
    expect(Buffer.byteLength(JSON.stringify(out.body))).toBeLessThanOrEqual(
      10_000,
    );
    expect(out.truncated).toBe(true);
  });

  it("keeps a partial tree within the budget for large multibyte text (review #820 N1)", () => {
    const jp = "日本語のテキスト".repeat(300);
    for (let pad = 0; pad < 40; pad++) {
      const body = {
        data: range(50).map((i) => ({
          id: i,
          pad: "x".repeat(pad * 37),
          title: jp,
          body: jp,
        })),
      };
      const out = boundedPreview(body, none);
      const serialized = JSON.stringify(out.body);
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
        CUSTOM_API_TEST_LIMITS.previewBytes,
      );
      expect(typeof out.body).toBe("object");
      const data = (out.body as { data: unknown[] }).data;
      expect(data.length).toBeGreaterThan(1);
      expect(String(data.at(-1))).toMatch(/^… \d+ more$/);
      expect(JSON.parse(serialized)).toEqual(out.body);
      expect(out.truncated).toBe(true);
    }
  });

  it("keeps a partial tree for many empty containers (review #820 N1)", () => {
    const empties = range(50).map(() =>
      Object.fromEntries(
        range(200).map((k) => [`k${k}`, range(50).map(() => ({}))]),
      ),
    );
    const cube = range(50).map(() =>
      range(50).map(() => range(50).map(() => [])),
    );
    for (const body of [empties, cube]) {
      const out = boundedPreview(body, none);
      const serialized = JSON.stringify(out.body);
      expect(Array.isArray(out.body)).toBe(true);
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
        CUSTOM_API_TEST_LIMITS.previewBytes,
      );
      expect(JSON.parse(serialized)).toEqual(out.body);
      expect(out.truncated).toBe(true);
    }
  });

  it("fits every budget exactly, down to a tiny one", () => {
    const body = {
      a: range(50).map((i) => ({ t: "€".repeat(500 + i), n: [{}, [], null] })),
    };
    for (const budget of [200, 1_000, 5_000, 20_000, 100_000]) {
      const out = boundedPreview(body, none, budget);
      expect(
        Buffer.byteLength(JSON.stringify(out.body)),
        String(budget),
      ).toBeLessThanOrEqual(budget);
      expect(typeof out.body).toBe("object");
    }
  });

  it("passes scalars and null through", () => {
    expect(boundedPreview("plain", none).body).toBe("plain");
    expect(boundedPreview(42, none).body).toBe(42);
    expect(boundedPreview(null, none)).toEqual({
      body: null,
      truncated: false,
      omitted: { arrays: 0, strings: 0, depth: 0, bytes: 0 },
    });
  });
});

describe("structured echo of rendered bodies (#885)", () => {
  const sent = {
    kind: "ItemsQuery",
    tenant: "acme-tenant",
    page: { offset: 0, limit: 10 },
    tags: ["a", "b"],
  };
  const secrets = secretSetOf({}, {}, [], [JSON.stringify(sent)]);
  // The provider parsed the body and answers it as JSON, keys reordered.
  const echoed = () => ({
    tags: ["a", "b"],
    page: { limit: 10, offset: 0 },
    tenant: "acme-tenant",
    kind: "ItemsQuery",
  });

  it("redacts the body echoed as an object or array, at any depth", () => {
    const body = {
      items: [{ id: 1, request: echoed() }],
      json: echoed(),
      list: [[echoed()]],
      // Parts of the body and look-alikes stay.
      page: { limit: 10, offset: 0 },
      near: { ...echoed(), extra: true },
      other: { ...echoed(), tags: ["b", "a"] },
    };
    const out = boundedPreview(body, secrets).body as Record<string, unknown>;
    expect(out.items).toEqual([{ id: 1, request: "[redacted]" }]);
    expect(out.json).toBe("[redacted]");
    expect(out.list).toEqual([["[redacted]"]]);
    expect(out.page).toEqual({ limit: 10, offset: 0 });
    expect(out.near).toMatchObject({ kind: "ItemsQuery", extra: true });
    expect(out.other).toMatchObject({ tags: ["b", "a"] });
  });

  it("redacts echoed bodies in a copy for the field suggestions, leaving the original", () => {
    const records = [{ id: 1, request: echoed(), page: { limit: 10 } }];
    const out = redactEchoes(records, secrets);
    expect(out).toEqual([
      { id: 1, request: "[redacted]", page: { limit: 10 } },
    ]);
    expect(records[0]!.request).toEqual(echoed());
    // Nothing echoed: the same value back.
    const plain = [{ id: 1 }];
    expect(redactEchoes(plain, secrets)).toBe(plain);
    expect(redactEchoes(echoed(), secrets)).toBe("[redacted]");
    // Deeper than the stack would allow for recursion.
    let deep: unknown = echoed();
    for (let i = 0; i < 100_000; i++) deep = [deep];
    let walked = redactEchoes(deep, secrets);
    for (let i = 0; i < 100_000; i++) walked = (walked as unknown[])[0];
    expect(walked).toBe("[redacted]");
  });

  it("never treats an empty or scalar body as an echo", () => {
    const scalars = secretSetOf({}, {}, [], ["{}", "[]", "12345"]);
    const body = { a: {}, b: [], c: 12345 };
    expect(boundedPreview(body, scalars).body).toEqual(body);
    expect(redactEchoes(body, scalars)).toBe(body);
  });
});
