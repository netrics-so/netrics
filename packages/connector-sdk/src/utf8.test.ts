import { describe, expect, it } from "vitest";

import { utf8ByteLength } from "./utf8.js";

const encoded = (text: string) => new TextEncoder().encode(text).length;

describe("utf8ByteLength (#528)", () => {
  it("counts what TextEncoder writes, lone surrogates included", () => {
    for (const text of [
      "",
      "plain ascii",
      "é ß ü",
      "中文 テキスト",
      "😀 emoji 👩‍👩‍👧",
      "\u007f\u0080߿ࠀ￿",
      "\ud83d", // lone high surrogate at the end
      "\ud83dx", // lone high surrogate before a non-surrogate
      "\ude00", // lone low surrogate
      "\ude00\ud83d", // reversed pair
      "\ud83d😀", // high surrogate, then a pair
    ])
      expect(utf8ByteLength(text), JSON.stringify(text)).toBe(encoded(text));
  });

  it("counts what TextEncoder writes for random code units", () => {
    let seed = 528;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const units = [
      0x41, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff,
      0xe000, 0xffff,
    ];
    for (let i = 0; i < 2000; i++) {
      const text = String.fromCharCode(
        ...Array.from(
          { length: Math.floor(random() * 12) },
          () => units[Math.floor(random() * units.length)]!,
        ),
      );
      expect(utf8ByteLength(text)).toBe(encoded(text));
    }
  });
});
