import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import { IMAGE_MAX_BYTES } from "@netrics/contracts";

import { sanitizeImage } from "./format.js";
import { sanitizeImageName } from "./service.js";

// Fixtures are tiny images written by Pillow (24 × 16 px), some with the
// metadata a phone or editor adds: EXIF with GPS, XMP, IPTC-like text,
// comments, ICC profiles. Everything else is built or mutated here.
function fixture(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, crc]);
}

function ihdr(width: number, height: number, depth = 8, colorType = 6) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = depth;
  data[9] = colorType;
  return pngChunk("IHDR", data);
}

interface PngChunk {
  type: string;
  data: Buffer;
}

function pngChunks(input: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    chunks.push({
      type: input.subarray(offset + 4, offset + 8).toString("latin1"),
      data: input.subarray(offset + 8, offset + 8 + length),
    });
    offset += 12 + length;
  }
  return chunks;
}

/** A PNG rebuilt from a fixture's chunks, with changes. */
function rebuildPng(
  source: Buffer,
  map: (chunk: PngChunk) => Buffer[] = (chunk) => [
    pngChunk(chunk.type, chunk.data),
  ],
): Buffer {
  return Buffer.concat([PNG_SIGNATURE, ...pngChunks(source).flatMap(map)]);
}

interface JpegSegment {
  marker: number;
  bytes: Buffer;
}

/** Marker segments up to EOI; a scan's entropy data is part of its SOS. */
function jpegSegments(input: Buffer): JpegSegment[] {
  const segments: JpegSegment[] = [];
  let offset = 2;
  for (;;) {
    const marker = input[offset + 1]!;
    if (marker === 0xd9) {
      return segments;
    }
    const length = input.readUInt16BE(offset + 2);
    let end = offset + 2 + length;
    if (marker === 0xda) {
      for (;;) {
        const next = input.indexOf(0xff, end);
        const following = input[next + 1]!;
        if (following === 0x00 || (following >= 0xd0 && following <= 0xd7)) {
          end = next + 2;
          continue;
        }
        end = next;
        break;
      }
    }
    segments.push({ marker, bytes: input.subarray(offset, end) });
    offset = end;
  }
}

function riffChunks(input: Buffer): Array<{ fourcc: string; data: Buffer }> {
  const chunks = [];
  let offset = 12;
  while (offset < input.length) {
    const size = input.readUInt32LE(offset + 4);
    chunks.push({
      fourcc: input.subarray(offset, offset + 4).toString("latin1"),
      data: input.subarray(offset + 8, offset + 8 + size),
    });
    offset += 8 + size + (size % 2);
  }
  return chunks;
}

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, "latin1");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([
    header,
    data,
    data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
}

function webp(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, "latin1");
  return Buffer.concat([header, body]);
}

function vp8x(flags: number, width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return riffChunk("VP8X", data);
}

function expectRejected(
  type: "image/png" | "image/jpeg" | "image/webp",
  input: Buffer,
  error: string,
) {
  expect(sanitizeImage(type, input)).toEqual({ ok: false, error });
}

function accepted(
  type: "image/png" | "image/jpeg" | "image/webp",
  input: Buffer,
) {
  const result = sanitizeImage(type, input);
  if (!result.ok) {
    throw new Error(`expected the image to be accepted: ${result.error}`);
  }
  return result;
}

/** Deterministic PRNG (mulberry32), so every run mutates the same bytes. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VALID = [
  ["image/png", "plain.png"],
  ["image/png", "metadata.png"],
  ["image/jpeg", "plain.jpg"],
  ["image/jpeg", "gps.jpg"],
  ["image/webp", "lossy.webp"],
  ["image/webp", "lossless.webp"],
  ["image/webp", "alpha.webp"],
  ["image/webp", "metadata.webp"],
] as const;

describe("sanitizeImage: valid images", () => {
  it.each(VALID)("accepts %s %s with its dimensions", (type, name) => {
    const result = accepted(type, fixture(name));
    expect(result).toMatchObject({ contentType: type, width: 24, height: 16 });
    // Idempotent: a stripped image passes unchanged.
    expect(accepted(type, result.content).content).toEqual(result.content);
  });

  it("keeps images without metadata byte for byte", () => {
    for (const [type, name] of [
      ["image/png", "plain.png"],
      ["image/webp", "lossy.webp"],
      ["image/webp", "lossless.webp"],
      ["image/webp", "alpha.webp"],
    ] as const) {
      expect(accepted(type, fixture(name)).content).toEqual(fixture(name));
    }
  });
});

describe("sanitizeImage: metadata", () => {
  it("drops PNG text, eXIf and tIME chunks and keeps iCCP and pixels", () => {
    const source = fixture("metadata.png");
    const types = pngChunks(source).map((chunk) => chunk.type);
    expect(types).toEqual(
      expect.arrayContaining(["tEXt", "zTXt", "iTXt", "tIME", "eXIf", "iCCP"]),
    );
    const { content } = accepted("image/png", source);
    expect(pngChunks(content).map((chunk) => chunk.type)).toEqual([
      "IHDR",
      "iCCP",
      "IDAT",
      "IEND",
    ]);
    const idat = (input: Buffer) =>
      Buffer.concat(
        pngChunks(input)
          .filter((chunk) => chunk.type === "IDAT")
          .map((chunk) => chunk.data),
      );
    expect(idat(content)).toEqual(idat(source));
    expect(content.includes("secret")).toBe(false);
    expect(content.includes("Jane")).toBe(false);
  });

  it("drops private and unknown ancillary PNG chunks", () => {
    const source = rebuildPng(fixture("plain.png"), (chunk) =>
      chunk.type === "IDAT"
        ? [
            pngChunk("prVt", Buffer.from("tracking id")),
            pngChunk(chunk.type, chunk.data),
          ]
        : [pngChunk(chunk.type, chunk.data)],
    );
    const { content } = accepted("image/png", source);
    expect(content).toEqual(fixture("plain.png"));
  });

  it("removes EXIF with GPS, XMP and comments from a JPEG, pixels unchanged", () => {
    const source = fixture("gps.jpg");
    expect(source.includes("Exif\0\0")).toBe(true);
    expect(source.includes("http://ns.adobe.com/xap/1.0/")).toBe(true);
    expect(source.includes("secret comment")).toBe(true);

    const { content } = accepted("image/jpeg", source);
    expect(content.includes("Exif")).toBe(false);
    expect(content.includes("GPS")).toBe(false);
    expect(content.includes("xap")).toBe(false);
    expect(content.includes("secret")).toBe(false);
    expect(content.includes("ExampleCam")).toBe(false);
    expect(content.includes("ICC_PROFILE\0")).toBe(true);

    // Every segment the decoder reads (tables, frame, scans with their
    // entropy-coded data) is byte-identical, so the pixels are too.
    const image = (input: Buffer) =>
      jpegSegments(input)
        .filter(
          ({ marker }) => (marker < 0xe0 || marker > 0xef) && marker !== 0xfe,
        )
        .map(({ bytes }) => bytes.toString("hex"));
    expect(image(content)).toEqual(image(source));
    expect(
      jpegSegments(content).map(({ marker }) => marker.toString(16)),
    ).not.toContain("e1");
    expect(content.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it("drops APP13, other APPn, COM and non-ICC APP2 segments; keeps APP0 and APP14", () => {
    const source = fixture("plain.jpg");
    const segment = (marker: number, payload: string) => {
      const data = Buffer.from(payload, "latin1");
      const header = Buffer.from([0xff, marker, 0, 0]);
      header.writeUInt16BE(data.length + 2, 2);
      return Buffer.concat([header, data]);
    };
    const extra = Buffer.concat([
      segment(0xed, "Photoshop 3.0\0IPTC secret"),
      segment(0xe2, "MPF\0secret pictures"),
      segment(0xe5, "vendor secret"),
      segment(0xfe, "secret comment"),
      segment(0xee, "Adobe\0d\0\0\0\0\x01"),
    ]);
    const input = Buffer.concat([
      source.subarray(0, 2),
      extra,
      source.subarray(2),
    ]);
    const { content } = accepted("image/jpeg", input);
    expect(content.includes("secret")).toBe(false);
    expect(content.includes("Adobe")).toBe(true);
    expect(content.includes("JFIF")).toBe(true);
  });

  it("drops anything after the JPEG end-of-image marker", () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    const { content } = accepted(
      "image/jpeg",
      Buffer.concat([fixture("plain.jpg"), html]),
    );
    expect(content).toEqual(fixture("plain.jpg"));
  });

  it("removes WebP EXIF and XMP chunks, clears their flags and keeps ICC", () => {
    const source = fixture("metadata.webp");
    expect(riffChunks(source).map((chunk) => chunk.fourcc)).toEqual(
      expect.arrayContaining(["VP8X", "ICCP", "EXIF", "XMP "]),
    );
    expect(source[20]! & 0x0c).toBe(0x0c);

    const { content } = accepted("image/webp", source);
    const chunks = riffChunks(content);
    expect(chunks.map((chunk) => chunk.fourcc)).toEqual([
      "VP8X",
      "ICCP",
      "VP8 ",
    ]);
    expect(content[20]).toBe(0x20);
    expect(content.readUInt32LE(4)).toBe(content.length - 8);
    const bitstream = (input: Buffer) =>
      riffChunks(input).find((chunk) => chunk.fourcc === "VP8 ")!.data;
    expect(bitstream(content)).toEqual(bitstream(source));
    expect(content.includes("GPS")).toBe(false);
    expect(content.includes("xmpmeta")).toBe(false);
  });
});

describe("sanitizeImage: refused files", () => {
  it("refuses SVG and HTML whatever type they claim", () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    );
    const html = Buffer.from("<!doctype html><script>alert(1)</script>");
    for (const type of ["image/png", "image/jpeg", "image/webp"] as const) {
      expectRejected(type, svg, "image_type_mismatch");
      expectRejected(type, html, "image_type_mismatch");
    }
  });

  it("refuses a file whose magic bytes name another type", () => {
    expectRejected("image/jpeg", fixture("plain.png"), "image_type_mismatch");
    expectRejected("image/webp", fixture("plain.jpg"), "image_type_mismatch");
    expectRejected("image/png", fixture("lossy.webp"), "image_type_mismatch");
  });

  it("refuses a PNG signature followed by HTML (polyglot)", () => {
    const polyglot = Buffer.concat([
      PNG_SIGNATURE,
      Buffer.from("<html><script>alert(1)</script></html>"),
    ]);
    expectRejected("image/png", polyglot, "image_invalid");
  });

  it("does not store data after IEND or after the RIFF container", () => {
    const html = Buffer.from("<script>alert(1)</script>");
    for (const [type, name] of [
      ["image/png", "plain.png"],
      ["image/webp", "lossy.webp"],
    ] as const) {
      const { content } = accepted(type, Buffer.concat([fixture(name), html]));
      expect(content).toEqual(fixture(name));
    }
  });

  it("refuses an HTML chunk next to a simple WebP bitstream", () => {
    const [image] = riffChunks(fixture("lossy.webp"));
    expectRejected(
      "image/webp",
      webp(
        riffChunk(image!.fourcc, image!.data),
        riffChunk("HTML", Buffer.from("<script>alert(1)</script>")),
      ),
      "image_invalid",
    );
  });

  it.each(VALID)("refuses every truncation of %s %s", (type, name) => {
    const source = fixture(name);
    for (let length = 0; length < source.length; length += 1) {
      const result = sanitizeImage(type, source.subarray(0, length));
      expect(result.ok, `${name} cut at ${length}`).toBe(false);
    }
  });

  it("refuses a PNG with a broken chunk CRC, in every chunk", () => {
    const source = fixture("metadata.png");
    let offset = 8;
    while (offset < source.length) {
      const length = source.readUInt32BE(offset);
      const broken = Buffer.from(source);
      const crcAt = offset + 8 + length;
      broken[crcAt] = broken[crcAt]! ^ 0x01;
      expectRejected("image/png", broken, "image_invalid");
      offset += 12 + length;
    }
  });

  it("refuses PNG structure errors", () => {
    const plain = fixture("plain.png");
    const chunks = pngChunks(plain);
    const at = (type: string) => chunks.find((chunk) => chunk.type === type)!;
    const idat = pngChunk("IDAT", at("IDAT").data);
    const iend = pngChunk("IEND");
    const header = ihdr(24, 16);
    const cases: Buffer[] = [
      // IHDR not first, twice, missing IDAT or IEND
      Buffer.concat([PNG_SIGNATURE, idat, header, iend]),
      Buffer.concat([PNG_SIGNATURE, header, header, idat, iend]),
      Buffer.concat([PNG_SIGNATURE, header, iend]),
      Buffer.concat([PNG_SIGNATURE, header, idat]),
      // an unknown critical chunk
      Buffer.concat([PNG_SIGNATURE, header, pngChunk("HTML"), idat, iend]),
      // IDAT chunks that are not consecutive
      Buffer.concat([
        PNG_SIGNATURE,
        header,
        idat,
        pngChunk("tEXt", Buffer.from("a\0b")),
        idat,
        iend,
      ]),
      // invalid bit depth / colour type, compression or filter method
      Buffer.concat([PNG_SIGNATURE, ihdr(24, 16, 3, 6), idat, iend]),
      Buffer.concat([PNG_SIGNATURE, ihdr(24, 16, 8, 5), idat, iend]),
      // palette image without PLTE
      Buffer.concat([PNG_SIGNATURE, ihdr(24, 16, 8, 3), idat, iend]),
      // zero width
      Buffer.concat([PNG_SIGNATURE, ihdr(0, 16), idat, iend]),
      // a chunk type with a non-letter
      Buffer.concat([PNG_SIGNATURE, header, pngChunk("t<X>"), idat, iend]),
      // a chunk length beyond the file
      Buffer.concat([
        PNG_SIGNATURE,
        header,
        Buffer.from([0x7f, 0xff, 0xff, 0xff]),
        Buffer.from("IDAT"),
      ]),
    ];
    for (const input of cases) {
      expectRejected("image/png", input, "image_invalid");
    }
  });

  it("refuses animated PNG (APNG) and animated WebP", () => {
    expectRejected("image/png", fixture("animated.png"), "image_animated");
    expectRejected("image/webp", fixture("animated.webp"), "image_animated");
  });

  it("refuses an animation chunk even when the VP8X flag is cleared", () => {
    const [image] = riffChunks(fixture("lossy.webp"));
    expectRejected(
      "image/webp",
      webp(
        vp8x(0, 24, 16),
        riffChunk("ANMF", Buffer.alloc(16)),
        riffChunk("VP8 ", image!.data),
      ),
      "image_animated",
    );
  });

  it("refuses an acTL chunk after IDAT as well", () => {
    const source = rebuildPng(fixture("plain.png"), (chunk) =>
      chunk.type === "IEND"
        ? [pngChunk("acTL", Buffer.alloc(8)), pngChunk("IEND")]
        : [pngChunk(chunk.type, chunk.data)],
    );
    expectRejected("image/png", source, "image_animated");
  });

  it("refuses more than 1 MiB", () => {
    const big = Buffer.concat([
      fixture("plain.png"),
      Buffer.alloc(IMAGE_MAX_BYTES),
    ]);
    expectRejected("image/png", big, "image_too_large");
  });

  it("refuses oversized dimensions from the header alone (decompression bombs)", () => {
    const plain = fixture("plain.png");
    const idat = pngChunk("IDAT", pngChunks(plain)[1]!.data);
    const png = (width: number, height: number) =>
      Buffer.concat([
        PNG_SIGNATURE,
        ihdr(width, height),
        idat,
        pngChunk("IEND"),
      ]);
    expectRejected("image/png", png(4097, 1), "image_dimensions_too_large");
    expectRejected("image/png", png(1, 65_535), "image_dimensions_too_large");
    expectRejected(
      "image/png",
      png(0x7fffffff, 0x7fffffff),
      "image_dimensions_too_large",
    );
    expect(accepted("image/png", png(4096, 4096))).toMatchObject({
      width: 4096,
      height: 4096,
    });

    const jpeg = Buffer.from(fixture("plain.jpg"));
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    jpeg.writeUInt16BE(65_000, sof + 5);
    jpeg.writeUInt16BE(65_000, sof + 7);
    expectRejected("image/jpeg", jpeg, "image_dimensions_too_large");

    const [lossy] = riffChunks(fixture("lossy.webp"));
    expectRejected(
      "image/webp",
      webp(vp8x(0, 16_384, 16_384), riffChunk("VP8 ", lossy!.data)),
      "image_dimensions_too_large",
    );
    const lossless = Buffer.from(riffChunks(fixture("lossless.webp"))[0]!.data);
    // 14-bit width and height fields: 16384 × 16384.
    lossless.writeUInt32LE(0x0fffffff, 1);
    expectRejected(
      "image/webp",
      webp(riffChunk("VP8L", lossless)),
      "image_dimensions_too_large",
    );
  });

  it("refuses a VP8X canvas that differs from the bitstream", () => {
    const [lossy] = riffChunks(fixture("lossy.webp"));
    expectRejected(
      "image/webp",
      webp(vp8x(0, 25, 16), riffChunk("VP8 ", lossy!.data)),
      "image_invalid",
    );
  });

  it("refuses JPEG frames browsers do not decode and scans before a frame", () => {
    const lossless = Buffer.from(fixture("plain.jpg"));
    lossless[lossless.indexOf(Buffer.from([0xff, 0xc0])) + 1] = 0xc3;
    expectRejected("image/jpeg", lossless, "image_invalid");

    const source = fixture("plain.jpg");
    const sofAt = source.indexOf(Buffer.from([0xff, 0xc0]));
    const sofLength = source.readUInt16BE(sofAt + 2);
    const withoutFrame = Buffer.concat([
      source.subarray(0, sofAt),
      source.subarray(sofAt + 2 + sofLength),
    ]);
    expectRejected("image/jpeg", withoutFrame, "image_invalid");

    // a second SOI
    expectRejected(
      "image/jpeg",
      Buffer.concat([source.subarray(0, 2), source]),
      "image_invalid",
    );
  });

  it("never throws on random corruption, and anything accepted is within limits", () => {
    const next = random(217);
    for (const [type, name] of VALID) {
      const source = fixture(name);
      for (let round = 0; round < 400; round += 1) {
        const mutated = Buffer.from(source);
        const flips = 1 + Math.floor(next() * 8);
        for (let flip = 0; flip < flips; flip += 1) {
          const at = Math.floor(next() * mutated.length);
          mutated[at] = Math.floor(next() * 256);
        }
        const result = sanitizeImage(type, mutated);
        if (result.ok) {
          expect(result.width).toBeLessThanOrEqual(4096);
          expect(result.height).toBeLessThanOrEqual(4096);
          expect(result.content.length).toBeLessThanOrEqual(mutated.length);
          // What is stored passes the same check again.
          expect(sanitizeImage(type, result.content).ok).toBe(true);
        }
      }
    }
  });

  it("never throws on random bytes behind valid magic bytes", () => {
    const next = random(42);
    const magic = {
      "image/png": PNG_SIGNATURE,
      "image/jpeg": Buffer.from([0xff, 0xd8, 0xff]),
      "image/webp": Buffer.from("RIFF\0\0\0\0WEBP", "latin1"),
    };
    for (const [type, prefix] of Object.entries(magic)) {
      for (let round = 0; round < 500; round += 1) {
        const tail = Buffer.alloc(Math.floor(next() * 256));
        for (let index = 0; index < tail.length; index += 1) {
          tail[index] = Math.floor(next() * 256);
        }
        const result = sanitizeImage(
          type as keyof typeof magic,
          Buffer.concat([prefix, tail]),
        );
        expect(result.ok).toBe(false);
      }
    }
  });
});

describe("sanitizeImageName", () => {
  it.each([
    [undefined, "image"],
    ["", "image"],
    ["logo.png", "logo.png"],
    [encodeURIComponent("Würfel Logo.png"), "Würfel Logo.png"],
    [encodeURIComponent("../../etc/passwd"), "passwd"],
    [encodeURIComponent("C:\\Users\\me\\logo.png"), "logo.png"],
    [encodeURIComponent("a\u202Egnp.exe"), "agnp.exe"],
    [encodeURIComponent("line\nbreak\ttab"), "line break tab"],
    ["%E0%A4%A", "image"],
    [encodeURIComponent("x".repeat(300)), "x".repeat(100)],
    [encodeURIComponent("   "), "image"],
  ])("%s → %s", (raw, expected) => {
    expect(sanitizeImageName(raw)).toBe(expected);
  });
});
