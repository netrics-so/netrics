import { crc32 } from "node:zlib";

import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  IMAGE_MAX_SIDE,
  type ImageContentType,
} from "@netrics/contracts";

/**
 * Workspace image validation (ADR 0015, section 5). Raster only: PNG, JPEG
 * and WebP. The bytes are never decoded here: the header is parsed strictly
 * for the dimensions, and metadata is removed by copying only the chunks and
 * segments an image needs, so the pixel data stays byte-identical. Anything
 * that does not parse exactly is refused, which also refuses polyglots
 * (a PNG header in front of HTML). Bytes after the end of the image (after
 * PNG IEND, JPEG EOI or the RIFF container) are never stored.
 *
 * Errors carry a code only; neither the bytes nor any text from the file
 * ever reaches an error message or a log line.
 */

export type ImageRejection =
  | "image_type_mismatch"
  | "image_invalid"
  | "image_animated"
  | "image_dimensions_too_large"
  | "image_too_large";

export type SanitizedImage =
  | {
      ok: true;
      contentType: ImageContentType;
      width: number;
      height: number;
      /** The image without metadata; pixel data unchanged. */
      content: Buffer;
    }
  | { ok: false; error: ImageRejection };

class Rejected extends Error {
  constructor(readonly code: ImageRejection) {
    super(code);
  }
}

function reject(code: ImageRejection = "image_invalid"): never {
  throw new Rejected(code);
}

function checkDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    reject();
  }
  if (width < 1 || height < 1) {
    reject();
  }
  if (
    width > IMAGE_MAX_SIDE ||
    height > IMAGE_MAX_SIDE ||
    width * height > IMAGE_MAX_PIXELS
  ) {
    reject("image_dimensions_too_large");
  }
}

function startsWith(input: Buffer, magic: readonly number[], at = 0) {
  return (
    input.length >= at + magic.length &&
    magic.every((byte, index) => input[at + index] === byte)
  );
}

// ─── PNG ────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Chunks a still image may keep: the critical ones and those that affect how
// pixels are shown (transparency, colour space, gamma, background, density).
// Every other ancillary chunk is dropped: text (tEXt, zTXt, iTXt), eXIf,
// tIME and any private chunk that could carry data.
const PNG_KEPT_ANCILLARY = new Set([
  "tRNS",
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "cICP",
  "mDCV",
  "cLLI",
  "bKGD",
  "pHYs",
]);
const PNG_ANIMATION = new Set(["acTL", "fcTL", "fdAT"]);
const PNG_BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

/** At most this many chunks or segments per file (work bound). */
const MAX_PARTS = 1000;

/** Valid lengths of a kept ancillary chunk for a colour type. */
function ancillaryLengthOk(
  type: string,
  length: number,
  colorType: number,
  paletteEntries: number,
): boolean {
  switch (type) {
    case "gAMA":
    case "cICP":
      return length === 4;
    case "sRGB":
      return length === 1;
    case "pHYs":
      return length === 9;
    case "cHRM":
      return length === 32;
    case "cLLI":
      return length === 8;
    case "mDCV":
      return length === 24;
    case "bKGD":
      return length === ({ 0: 2, 2: 6, 3: 1, 4: 2, 6: 6 }[colorType] ?? -1);
    case "sBIT":
      return length === ({ 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 }[colorType] ?? -1);
    case "tRNS":
      return colorType === 0
        ? length === 2
        : colorType === 2
          ? length === 6
          : colorType === 3 && length >= 1 && length <= paletteEntries;
    default:
      return true;
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(chunk.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return chunk;
}

/**
 * iCCP with its free-text profile name replaced by "ICC"; null when the
 * chunk is malformed (then it is dropped).
 */
function iccpWithoutName(data: Buffer): Buffer | null {
  const end = data.indexOf(0);
  if (end < 1 || end > 79 || data[end + 1] !== 0 || data.length < end + 3) {
    return null;
  }
  return pngChunk(
    "iCCP",
    Buffer.concat([Buffer.from("ICC\0\0", "latin1"), data.subarray(end + 2)]),
  );
}

function isChunkTypeByte(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function sanitizePng(input: Buffer) {
  const kept: Buffer[] = [input.subarray(0, 8)];
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let seenPlte = false;
  let paletteEntries = 0;
  let chunks = 0;
  let idatState: "before" | "inside" | "after" = "before";
  let ended = false;
  let first = true;
  const seen = new Set<string>();

  while (!ended) {
    chunks += 1;
    if (chunks > MAX_PARTS || offset + 12 > input.length) {
      reject();
    }
    const length = input.readUInt32BE(offset);
    if (length > 0x7fffffff || offset + 12 + length > input.length) {
      reject();
    }
    const typeBytes = input.subarray(offset + 4, offset + 8);
    if (!typeBytes.every(isChunkTypeByte) || (typeBytes[2]! & 0x20) !== 0) {
      reject();
    }
    const type = typeBytes.toString("latin1");
    const data = input.subarray(offset + 8, offset + 8 + length);
    const crc = input.readUInt32BE(offset + 8 + length);
    if (crc32(input.subarray(offset + 4, offset + 8 + length)) !== crc) {
      reject();
    }
    const chunk = input.subarray(offset, offset + 12 + length);
    offset += 12 + length;

    if (first !== (type === "IHDR")) {
      reject();
    }
    first = false;
    if (PNG_ANIMATION.has(type)) {
      reject("image_animated");
    }
    if (type === "IDAT") {
      if (idatState === "after" || (colorType === 3 && !seenPlte)) {
        reject();
      }
      idatState = "inside";
      kept.push(chunk);
      continue;
    }
    if (idatState === "inside") {
      idatState = "after";
    }

    const critical = (typeBytes[0]! & 0x20) === 0;
    if (critical || PNG_KEPT_ANCILLARY.has(type)) {
      // Critical and kept chunks occur once (IDAT is handled above).
      if (seen.has(type)) {
        reject();
      }
      seen.add(type);
    }
    switch (type) {
      case "IHDR": {
        if (length !== 13) {
          reject();
        }
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        const bitDepth = data[8]!;
        colorType = data[9]!;
        if (
          !(PNG_BIT_DEPTHS[colorType] ?? []).includes(bitDepth) ||
          data[10] !== 0 ||
          data[11] !== 0 ||
          (data[12] !== 0 && data[12] !== 1)
        ) {
          reject();
        }
        if (width > 0x7fffffff || height > 0x7fffffff) {
          reject();
        }
        checkDimensions(width, height);
        kept.push(chunk);
        break;
      }
      case "PLTE":
        if (
          idatState !== "before" ||
          length === 0 ||
          length % 3 !== 0 ||
          length > 768 ||
          colorType === 0 ||
          colorType === 4
        ) {
          reject();
        }
        seenPlte = true;
        paletteEntries = length / 3;
        kept.push(chunk);
        break;
      case "IEND":
        if (length !== 0 || idatState === "before") {
          reject();
        }
        kept.push(chunk);
        ended = true;
        break;
      default:
        if (critical) {
          // An unknown critical chunk: a decoder must refuse the image.
          reject();
        }
        // A kept chunk with an impossible length is dropped, not stored.
        if (
          PNG_KEPT_ANCILLARY.has(type) &&
          ancillaryLengthOk(type, length, colorType, paletteEntries)
        ) {
          if (type === "iCCP") {
            const iccp = iccpWithoutName(data);
            if (iccp) {
              kept.push(iccp);
            }
          } else {
            kept.push(chunk);
          }
        }
    }
  }
  // Bytes after IEND are not part of the image (some tools append data;
  // so do polyglots): they are not stored.
  return { width, height, content: Buffer.concat(kept) };
}

// ─── JPEG ───────────────────────────────────────────────────────────────────

// Frame types browsers decode: baseline, extended sequential, progressive,
// and their arithmetic-coded variants. Lossless and hierarchical frames are
// refused.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc9, 0xca]);
const JPEG_OTHER_SOF = new Set([
  0xc3, 0xc5, 0xc6, 0xc7, 0xcb, 0xcd, 0xce, 0xcf,
]);
// Table and restart segments the decoder needs.
const JPEG_TABLES = new Set([0xc4, 0xcc, 0xdb, 0xdd]);
const ICC_PROFILE_ID = Buffer.from("ICC_PROFILE\0", "latin1");
const JFIF_ID = Buffer.from("JFIF\0", "latin1");
const ADOBE_ID = Buffer.from("Adobe", "latin1");

function sanitizeJpeg(input: Buffer) {
  const kept: Buffer[] = [input.subarray(0, 2)];
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawScan = false;
  let segments = 0;

  for (;;) {
    segments += 1;
    if (
      segments > MAX_PARTS ||
      offset >= input.length ||
      input[offset] !== 0xff
    ) {
      reject();
    }
    // Fill bytes (0xFF) may precede a marker.
    while (offset < input.length && input[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= input.length) {
      reject();
    }
    const marker = input[offset]!;
    offset += 1;

    if (marker === 0xd9) {
      if (!sawScan) {
        reject();
      }
      kept.push(Buffer.from([0xff, 0xd9]));
      // Anything after EOI (multi-picture trailers, appended files) is
      // dropped: it is not part of the image.
      break;
    }
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      reject();
    }
    if (offset + 2 > input.length) {
      reject();
    }
    const length = input.readUInt16BE(offset);
    if (length < 2 || offset + length > input.length) {
      reject();
    }
    const data = input.subarray(offset + 2, offset + length);
    const segment = Buffer.concat([
      Buffer.from([0xff, marker]),
      input.subarray(offset, offset + length),
    ]);
    offset += length;

    if (JPEG_SOF.has(marker)) {
      if (sawFrame || data.length < 6) {
        reject();
      }
      const precision = data[0]!;
      height = data.readUInt16BE(1);
      width = data.readUInt16BE(3);
      const components = data[5]!;
      if (
        precision !== 8 ||
        ![1, 3, 4].includes(components) ||
        data.length !== 6 + 3 * components
      ) {
        reject();
      }
      // Height 0 (defined later by a DNL segment) is refused: strict.
      checkDimensions(width, height);
      sawFrame = true;
      kept.push(segment);
      continue;
    }
    if (JPEG_OTHER_SOF.has(marker)) {
      reject();
    }
    if (JPEG_TABLES.has(marker)) {
      if (data.length === 0) {
        reject();
      }
      kept.push(segment);
      continue;
    }
    if (marker === 0xda) {
      if (!sawFrame || data.length < 1) {
        reject();
      }
      const components = data[0]!;
      if (
        components < 1 ||
        components > 4 ||
        data.length !== 4 + 2 * components
      ) {
        reject();
      }
      // Entropy-coded data runs to the next marker that is neither a
      // stuffed 0xFF00 nor a restart marker.
      let end = offset;
      for (;;) {
        const next = input.indexOf(0xff, end);
        if (next === -1 || next + 1 >= input.length) {
          reject();
        }
        const following = input[next + 1]!;
        if (following === 0x00 || (following >= 0xd0 && following <= 0xd7)) {
          end = next + 2;
          continue;
        }
        if (following === 0xff) {
          end = next + 1;
          continue;
        }
        end = next;
        break;
      }
      kept.push(segment, input.subarray(offset, end));
      offset = end;
      sawScan = true;
      continue;
    }
    if (marker === 0xe0) {
      // JFIF only, without its thumbnail: the 14-byte header with the
      // thumbnail size zeroed. JFXX (extension thumbnails) and anything
      // else in APP0 are dropped.
      if (data.length >= 14 && startsWith(data, [...JFIF_ID])) {
        const jfif = Buffer.from([
          0xff,
          0xe0,
          0x00,
          0x10,
          ...data.subarray(0, 14),
        ]);
        jfif[16] = 0;
        jfif[17] = 0;
        kept.push(jfif);
      }
      continue;
    }
    if (marker === 0xee) {
      // Adobe's colour transform, exactly the 12-byte segment.
      if (data.length === 12 && startsWith(data, [...ADOBE_ID])) {
        kept.push(segment);
      }
      continue;
    }
    if (marker === 0xe2) {
      // APP2 keeps only the ICC profile (not FlashPix or MPF).
      if (startsWith(data, [...ICC_PROFILE_ID])) {
        kept.push(segment);
      }
      continue;
    }
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) {
      // APP1 (EXIF, XMP), APP13 (IPTC), other APPn and COM are dropped.
      continue;
    }
    // DNL, DHP, EXP, JPG extensions and reserved markers.
    reject();
  }
  return { width, height, content: Buffer.concat(kept) };
}

// ─── WebP ───────────────────────────────────────────────────────────────────

interface RiffChunk {
  fourcc: string;
  data: Buffer;
  /** The chunk as stored, with header and padding. */
  raw: Buffer;
}

function readRiffChunks(input: Buffer): RiffChunk[] {
  const chunks: RiffChunk[] = [];
  let offset = 12;
  while (offset < input.length) {
    if (chunks.length >= MAX_PARTS) {
      reject();
    }
    if (offset + 8 > input.length) {
      reject();
    }
    const fourcc = input.subarray(offset, offset + 4).toString("latin1");
    const size = input.readUInt32LE(offset + 4);
    const padded = size + (size % 2);
    if (offset + 8 + padded > input.length) {
      reject();
    }
    chunks.push({
      fourcc,
      data: input.subarray(offset + 8, offset + 8 + size),
      raw: input.subarray(offset, offset + 8 + padded),
    });
    offset += 8 + padded;
  }
  return chunks;
}

function vp8Dimensions(data: Buffer): { width: number; height: number } {
  if (data.length < 10) {
    reject();
  }
  const tag = data[0]! | (data[1]! << 8) | (data[2]! << 16);
  const keyFrame = (tag & 1) === 0;
  const version = (tag >> 1) & 7;
  const showFrame = (tag >> 4) & 1;
  const firstPartition = tag >>> 5;
  if (
    !keyFrame ||
    version > 3 ||
    showFrame !== 1 ||
    firstPartition > data.length - 10 ||
    !startsWith(data, [0x9d, 0x01, 0x2a], 3)
  ) {
    reject();
  }
  return {
    width: data.readUInt16LE(6) & 0x3fff,
    height: data.readUInt16LE(8) & 0x3fff,
  };
}

function vp8lDimensions(data: Buffer): { width: number; height: number } {
  if (data.length < 5 || data[0] !== 0x2f) {
    reject();
  }
  const bits = data.readUInt32LE(1);
  if (bits >>> 29 !== 0) {
    reject();
  }
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
  };
}

const VP8X_ICC = 0x20;
const VP8X_ALPHA = 0x10;
const VP8X_ANIMATION = 0x02;

function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, "latin1");
  return Buffer.concat([header, body]);
}

function sanitizeWebp(file: Buffer) {
  const riffSize = file.readUInt32LE(4);
  if (riffSize % 2 !== 0 || riffSize + 8 > file.length) {
    reject();
  }
  // Bytes after the RIFF container are not part of the image: not stored.
  const input = file.subarray(0, riffSize + 8);
  const chunks = readRiffChunks(input);
  const [first, ...rest] = chunks;
  if (!first) {
    reject();
  }
  if (first.fourcc === "VP8 " || first.fourcc === "VP8L") {
    if (rest.length > 0) {
      reject();
    }
    const { width, height } =
      first.fourcc === "VP8 "
        ? vp8Dimensions(first.data)
        : vp8lDimensions(first.data);
    checkDimensions(width, height);
    return { width, height, content: riff([first.raw]) };
  }
  if (first.fourcc !== "VP8X" || first.data.length !== 10) {
    reject();
  }
  const flags = first.data[0]!;
  const width = first.data.readUIntLE(4, 3) + 1;
  const height = first.data.readUIntLE(7, 3) + 1;
  if (flags & VP8X_ANIMATION) {
    reject("image_animated");
  }
  checkDimensions(width, height);

  const kept: Buffer[] = [];
  let icc: RiffChunk | null = null;
  let alpha: RiffChunk | null = null;
  let image: RiffChunk | null = null;
  for (const chunk of rest) {
    switch (chunk.fourcc) {
      case "ANIM":
      case "ANMF":
        reject("image_animated");
        break;
      case "VP8X":
        reject();
        break;
      case "ICCP":
        if (icc || alpha || image) {
          reject();
        }
        icc = chunk;
        break;
      case "ALPH":
        if (alpha || image) {
          reject();
        }
        alpha = chunk;
        break;
      case "VP8 ":
      case "VP8L": {
        if (image || (alpha && chunk.fourcc === "VP8L")) {
          reject();
        }
        const size =
          chunk.fourcc === "VP8 "
            ? vp8Dimensions(chunk.data)
            : vp8lDimensions(chunk.data);
        if (size.width !== width || size.height !== height) {
          reject();
        }
        image = chunk;
        break;
      }
      default:
        // EXIF, "XMP " and unknown chunks are dropped.
        break;
    }
  }
  if (!image) {
    reject();
  }
  if (icc) {
    kept.push(icc.raw);
  }
  if (alpha) {
    kept.push(alpha.raw);
  }
  kept.push(image.raw);

  const header = Buffer.from(first.raw);
  // Flags follow what is kept: ICC only with an ICCP chunk, never EXIF or
  // XMP; reserved bits and bytes are cleared.
  header[8] = (flags & VP8X_ALPHA) | (icc ? VP8X_ICC : 0);
  header[9] = 0;
  header[10] = 0;
  header[11] = 0;
  return { width, height, content: riff([header, ...kept]) };
}

// ─── Entry point ────────────────────────────────────────────────────────────

const MAGIC: Record<ImageContentType, (input: Buffer) => boolean> = {
  "image/png": (input) => startsWith(input, PNG_SIGNATURE),
  "image/jpeg": (input) => startsWith(input, [0xff, 0xd8, 0xff]),
  "image/webp": (input) =>
    input.length >= 12 &&
    input.subarray(0, 4).toString("latin1") === "RIFF" &&
    input.subarray(8, 12).toString("latin1") === "WEBP",
};

const SANITIZERS: Record<
  ImageContentType,
  (input: Buffer) => { width: number; height: number; content: Buffer }
> = {
  "image/png": sanitizePng,
  "image/jpeg": sanitizeJpeg,
  "image/webp": sanitizeWebp,
};

/**
 * Checks an upload against its declared type and returns it without
 * metadata, or the reason it is refused.
 */
export function sanitizeImage(
  contentType: ImageContentType,
  input: Buffer,
): SanitizedImage {
  if (input.length > IMAGE_MAX_BYTES) {
    return { ok: false, error: "image_too_large" };
  }
  if (!MAGIC[contentType](input)) {
    return { ok: false, error: "image_type_mismatch" };
  }
  try {
    const { width, height, content } = SANITIZERS[contentType](input);
    return { ok: true, contentType, width, height, content };
  } catch (error) {
    if (error instanceof Rejected) {
      return { ok: false, error: error.code };
    }
    // A bounds error from a Buffer read is a malformed file, nothing else.
    if (error instanceof RangeError) {
      return { ok: false, error: "image_invalid" };
    }
    throw error;
  }
}
