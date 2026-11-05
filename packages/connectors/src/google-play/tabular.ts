import { inflateRawSync } from "node:zlib";

/** Decode provider report text without lossy replacement of malformed bytes. */
export function reportText(bytes: Uint8Array): string {
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else if (bytes.length >= 8 && [1, 3, 5, 7].every((i) => bytes[i] === 0))
    encoding = "utf-16le";
  try {
    const text = new TextDecoder(encoding, { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, "");
    if (text.includes("\0")) throw new Error();
    return text;
  } catch {
    throw new Error("Google Play report has an unreadable text encoding");
  }
}

/** CSV with quoted commas, escaped quotes and multiline cells. No eval. */
export function csvTable(text: string): {
  headers: string[];
  records: Array<Record<string, string>>;
} {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  const endField = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  const endRow = () => {
    endField();
    if (row.some((value) => value !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === ",") endField();
    else if (c === "\r" || c === "\n") {
      endRow();
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else if (closed) {
      if (c !== " " && c !== "\t")
        throw new Error("Google Play report has malformed quoted CSV");
    } else if (c === '"') {
      if (field !== "")
        throw new Error("Google Play report has malformed quoted CSV");
      quoted = true;
    } else field += c;
  }
  if (quoted) throw new Error("Google Play report has an unfinished CSV field");
  if (field !== "" || row.length > 0 || closed) endRow();
  const headers = (rows.shift() ?? []).map((name) =>
    name.trim().replace(/^\uFEFF/, ""),
  );
  if (
    headers.length === 0 ||
    headers.some((name) => !name) ||
    new Set(headers).size !== headers.length
  )
    throw new Error("Google Play report has missing or duplicate CSV headers");
  return {
    headers,
    records: rows.map((cells) => {
      if (cells.length !== headers.length)
        throw new Error("Google Play report has inconsistent CSV columns");
      return Object.fromEntries(
        headers.map((name, index) => [name, cells[index]!]),
      );
    }),
  };
}
export function csvRecords(text: string): Array<Record<string, string>> {
  return csvTable(text).records;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = CRC_TABLE[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Read CSV members in memory, never extract paths. Central-directory lengths,
 * output budget, compression method and CRC are checked before use. Unsupported
 * ZIP64/multipart metadata is rejected explicitly rather than truncated.
 */
export function reportZip(
  bytes: Uint8Array,
  maxOutputBytes = 64 * 1024 * 1024,
): Array<{ name: string; bytes: Uint8Array }> {
  const buffer = Buffer.from(bytes);
  const bad = (): never => {
    throw new Error(
      "Google Play earnings report is not a supported readable ZIP archive",
    );
  };
  let eocd = -1;
  for (
    let at = buffer.length - 22;
    at >= Math.max(0, buffer.length - 65557);
    at--
  ) {
    if (
      buffer.readUInt32LE(at) === 0x06054b50 &&
      at + 22 + buffer.readUInt16LE(at + 20) === buffer.length
    ) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return bad();
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12),
    start = buffer.readUInt32LE(eocd + 16);
  if (
    buffer.readUInt16LE(eocd + 4) !== 0 ||
    buffer.readUInt16LE(eocd + 6) !== 0 ||
    buffer.readUInt16LE(eocd + 8) !== count ||
    count === 65535 ||
    start + size > eocd
  )
    return bad();
  let at = start,
    total = 0;
  const files: Array<{ name: string; bytes: Uint8Array }> = [],
    names = new Set<string>();
  for (let entry = 0; entry < count; entry++) {
    if (at + 46 > start + size || buffer.readUInt32LE(at) !== 0x02014b50)
      return bad();
    const flags = buffer.readUInt16LE(at + 8),
      method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16),
      compressed = buffer.readUInt32LE(at + 20),
      inflated = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28),
      extraLength = buffer.readUInt16LE(at + 30),
      commentLength = buffer.readUInt16LE(at + 32),
      disk = buffer.readUInt16LE(at + 34),
      local = buffer.readUInt32LE(at + 42);
    if (
      at + 46 + nameLength + extraLength + commentLength > start + size ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      disk !== 0 ||
      compressed === 0xffffffff ||
      inflated === 0xffffffff ||
      local === 0xffffffff
    )
      return bad();
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(at + 46, at + 46 + nameLength),
      );
    } catch {
      return bad();
    }
    at += 46 + nameLength + extraLength + commentLength;
    if (names.has(name)) return bad();
    names.add(name);
    if (!name.toLowerCase().endsWith(".csv")) continue;
    if (
      local + 30 > start ||
      buffer.readUInt32LE(local) !== 0x04034b50 ||
      buffer.readUInt16LE(local + 8) !== method ||
      buffer.readUInt16LE(local + 6) & 1
    )
      return bad();
    const dataStart =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    if (dataStart + compressed > start || inflated > maxOutputBytes - total)
      return bad();
    const compressedBytes = buffer.subarray(dataStart, dataStart + compressed);
    let output: Uint8Array;
    try {
      output =
        method === 0
          ? compressedBytes
          : inflateRawSync(compressedBytes, {
              maxOutputLength: Math.max(1, maxOutputBytes - total),
            });
    } catch {
      return bad();
    }
    if (output.byteLength !== inflated || crc32(output) !== crc) return bad();
    total += output.byteLength;
    files.push({ name, bytes: new Uint8Array(output) });
  }
  if (at !== start + size || files.length === 0) return bad();
  return files;
}

/** Exact decimal strings; comma is accepted only as an English group separator. */
export function reportDecimal(raw: string, nullable = false): string | null {
  const value = raw.trim();
  if (!value && nullable) return null;
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value))
    throw new Error("Google Play report has an invalid decimal value");
  const [whole = "0", fraction] = value
    .replace(/^[+-]/, "")
    .replaceAll(",", "")
    .split(".");
  const digits =
    whole.replace(/^0+(?=\d)/, "") +
    (fraction === undefined ? "" : `.${fraction}`);
  if (digits.replace(".", "").length > 38 || (fraction?.length ?? 0) > 18)
    throw new Error(
      "Google Play report decimal exceeds exact transport precision",
    );
  return value.startsWith("-") && /[1-9]/.test(digits) ? `-${digits}` : digits;
}
