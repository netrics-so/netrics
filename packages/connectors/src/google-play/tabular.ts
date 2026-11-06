import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, inflateRawSync } from "node:zlib";

/** Largest report object read, and the inflated output budget per archive. */
export const REPORT_MAX_BYTES = 64 * 1024 * 1024;

/** A pinned report object read by byte offset, in bounded pieces. */
export interface ReportSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A consumer of one report file's bytes, pushed in order. */
export interface ByteSink {
  push(bytes: Uint8Array): void;
  end(): void;
}

const unreadable = () =>
  new Error("Google Play report has an unreadable text encoding");

/**
 * Incremental form of reportText: the encoding is chosen from the first eight
 * bytes (or the whole file when shorter), malformed bytes are never replaced,
 * and decoded text is handed on chunk by chunk.
 */
export class ReportTextDecoder implements ByteSink {
  #head: Uint8Array[] = [];
  #headBytes = 0;
  #decoder: TextDecoder | undefined;
  #start = true;
  constructor(private readonly out: (text: string) => void) {}
  push(bytes: Uint8Array): void {
    if (this.#decoder) return this.#decode(bytes, true);
    this.#head.push(bytes);
    this.#headBytes += bytes.byteLength;
    if (this.#headBytes >= 8) this.#open();
  }
  end(): void {
    if (!this.#decoder) this.#open();
    this.#decode(undefined, false);
  }
  #open(): void {
    const bytes = Buffer.concat(this.#head);
    this.#head = [];
    let encoding = "utf-8";
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
    else if (bytes.length >= 8 && [1, 3, 5, 7].every((i) => bytes[i] === 0))
      encoding = "utf-16le";
    this.#decoder = new TextDecoder(encoding, { fatal: true });
    this.#decode(bytes, true);
  }
  #decode(bytes: Uint8Array | undefined, stream: boolean): void {
    let text: string;
    try {
      text = this.#decoder!.decode(bytes, { stream });
    } catch {
      throw unreadable();
    }
    if (this.#start && text) {
      text = text.replace(/^\uFEFF/, "");
      this.#start = false;
    }
    if (text.includes("\0")) throw unreadable();
    if (text) this.out(text);
  }
}

/** Decode provider report text without lossy replacement of malformed bytes. */
export function reportText(bytes: Uint8Array): string {
  const parts: string[] = [];
  const decoder = new ReportTextDecoder((text) => parts.push(text));
  decoder.push(bytes);
  decoder.end();
  return parts.join("");
}

/**
 * CSV with quoted commas, escaped quotes and multiline cells. No eval. Text is
 * pushed in chunks of any size; the last code unit of each chunk waits for the
 * next one, so a doubled quote or CRLF split across chunks reads the same.
 */
export class CsvParser {
  #row: string[] = [];
  #field = "";
  #quoted = false;
  #closed = false;
  #carry = "";
  constructor(private readonly onRow: (cells: string[]) => void) {}
  push(text: string): void {
    const chunk = this.#carry + text;
    const next = this.#scan(chunk, chunk.length - 1);
    this.#carry = chunk.slice(next);
  }
  end(): void {
    const chunk = this.#carry;
    this.#carry = "";
    this.#scan(chunk, chunk.length);
    if (this.#quoted)
      throw new Error("Google Play report has an unfinished CSV field");
    if (this.#field !== "" || this.#row.length > 0 || this.#closed)
      this.#endRow();
  }
  #endField(): void {
    this.#row.push(this.#field);
    this.#field = "";
    this.#closed = false;
  }
  #endRow(): void {
    this.#endField();
    const row = this.#row;
    this.#row = [];
    if (row.some((value) => value !== "")) this.onRow(row);
  }
  /** Consume code units before `limit`; returns the first unconsumed index. */
  #scan(text: string, limit: number): number {
    let i = 0;
    for (; i < limit; i++) {
      const c = text[i]!;
      if (this.#quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            this.#field += '"';
            i++;
          } else {
            this.#quoted = false;
            this.#closed = true;
          }
        } else this.#field += c;
      } else if (c === ",") this.#endField();
      else if (c === "\r" || c === "\n") {
        this.#endRow();
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else if (this.#closed) {
        if (c !== " " && c !== "\t")
          throw new Error("Google Play report has malformed quoted CSV");
      } else if (c === '"') {
        if (this.#field !== "")
          throw new Error("Google Play report has malformed quoted CSV");
        this.#quoted = true;
      } else this.#field += c;
    }
    return i;
  }
}

/**
 * Header-checked CSV records, one at a time. The first non-blank row names
 * the columns; every later row must have exactly as many cells.
 */
export class CsvRecordParser {
  #headers: string[] | undefined;
  readonly #parser: CsvParser;
  constructor(
    onHeaders: (headers: string[]) => void,
    onRecord: (record: Record<string, string>) => void,
  ) {
    this.#parser = new CsvParser((cells) => {
      const headers = this.#headers;
      if (!headers) {
        this.#headers = csvHeaders(cells);
        onHeaders(this.#headers);
        return;
      }
      if (cells.length !== headers.length)
        throw new Error("Google Play report has inconsistent CSV columns");
      onRecord(
        Object.fromEntries(headers.map((name, index) => [name, cells[index]!])),
      );
    });
  }
  push(text: string): void {
    this.#parser.push(text);
  }
  end(): void {
    this.#parser.end();
    if (!this.#headers) this.#headers = csvHeaders([]);
  }
}
function csvHeaders(cells: string[]): string[] {
  const headers = cells.map((name) => name.trim().replace(/^\uFEFF/, ""));
  if (
    headers.length === 0 ||
    headers.some((name) => !name) ||
    new Set(headers).size !== headers.length
  )
    throw new Error("Google Play report has missing or duplicate CSV headers");
  return headers;
}

/** Report bytes to CSV records: decoding and parsing both run incrementally. */
export function reportCsv(
  onHeaders: (headers: string[]) => void,
  onRecord: (record: Record<string, string>) => void,
): ByteSink {
  const records = new CsvRecordParser(onHeaders, onRecord);
  const text = new ReportTextDecoder((chunk) => records.push(chunk));
  return {
    push: (bytes) => text.push(bytes),
    end: () => {
      text.end();
      records.end();
    },
  };
}

export function csvTable(text: string): {
  headers: string[];
  records: Array<Record<string, string>>;
} {
  let headers: string[] = [];
  const records: Array<Record<string, string>> = [];
  const parser = new CsvRecordParser(
    (names) => (headers = names),
    (record) => records.push(record),
  );
  parser.push(text);
  parser.end();
  return { headers, records };
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
/** Running CRC-32: start from 0 and pass the previous result back in. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let value = (previous ^ 0xffffffff) >>> 0;
  for (const byte of bytes)
    value = CRC_TABLE[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

class ZipError extends Error {
  constructor() {
    super(
      "Google Play earnings report is not a supported readable ZIP archive",
    );
  }
}
const bad = (): never => {
  throw new ZipError();
};
/** Where the end-of-central-directory record says the directory lies. */
interface ZipEnd {
  count: number;
  size: number;
  start: number;
}
const ZIP_TAIL_BYTES = 65557;
/** Find the end record in the archive's last bytes (`tail` starts at `base`). */
function zipEnd(tail: Buffer, base: number, length: number): ZipEnd {
  let eocd = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (
      tail.readUInt32LE(at) === 0x06054b50 &&
      base + at + 22 + tail.readUInt16LE(at + 20) === length
    ) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return bad();
  const count = tail.readUInt16LE(eocd + 10);
  const size = tail.readUInt32LE(eocd + 12),
    start = tail.readUInt32LE(eocd + 16);
  if (
    tail.readUInt16LE(eocd + 4) !== 0 ||
    tail.readUInt16LE(eocd + 6) !== 0 ||
    tail.readUInt16LE(eocd + 8) !== count ||
    count === 65535 ||
    start + size > base + eocd
  )
    return bad();
  return { count, size, start };
}
interface ZipMember {
  name: string;
  method: number;
  crc: number;
  compressed: number;
  inflated: number;
  local: number;
}
/**
 * Every central-directory entry is checked before any member is read; only
 * `.csv` members are returned. `directory` holds exactly the directory bytes.
 */
function zipMembers(directory: Buffer, end: ZipEnd): ZipMember[] {
  let at = 0;
  const members: ZipMember[] = [],
    names = new Set<string>();
  for (let entry = 0; entry < end.count; entry++) {
    if (at + 46 > end.size || directory.readUInt32LE(at) !== 0x02014b50)
      return bad();
    const flags = directory.readUInt16LE(at + 8),
      method = directory.readUInt16LE(at + 10);
    const crc = directory.readUInt32LE(at + 16),
      compressed = directory.readUInt32LE(at + 20),
      inflated = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28),
      extraLength = directory.readUInt16LE(at + 30),
      commentLength = directory.readUInt16LE(at + 32),
      disk = directory.readUInt16LE(at + 34),
      local = directory.readUInt32LE(at + 42);
    if (
      at + 46 + nameLength + extraLength + commentLength > end.size ||
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
        directory.subarray(at + 46, at + 46 + nameLength),
      );
    } catch {
      return bad();
    }
    at += 46 + nameLength + extraLength + commentLength;
    if (names.has(name)) return bad();
    names.add(name);
    if (!name.toLowerCase().endsWith(".csv")) continue;
    members.push({ name, method, crc, compressed, inflated, local });
  }
  if (at !== end.size || members.length === 0) return bad();
  return members;
}
/** Check a member's local header (its first 30 bytes); returns the data offset. */
function memberData(
  header: Buffer,
  member: ZipMember,
  end: ZipEnd,
  budget: number,
): number {
  if (
    member.local + 30 > end.start ||
    header.readUInt32LE(0) !== 0x04034b50 ||
    header.readUInt16LE(8) !== member.method ||
    header.readUInt16LE(6) & 1
  )
    return bad();
  const dataStart =
    member.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (dataStart + member.compressed > end.start || member.inflated > budget)
    return bad();
  return dataStart;
}

/**
 * Read CSV members in memory, never extract paths. Central-directory lengths,
 * output budget, compression method and CRC are checked before use. Unsupported
 * ZIP64/multipart metadata is rejected explicitly rather than truncated.
 */
export function reportZip(
  bytes: Uint8Array,
  maxOutputBytes = REPORT_MAX_BYTES,
): Array<{ name: string; bytes: Uint8Array }> {
  const buffer = Buffer.from(bytes);
  const base = Math.max(0, buffer.length - ZIP_TAIL_BYTES);
  const end = zipEnd(buffer.subarray(base), base, buffer.length);
  const members = zipMembers(
    buffer.subarray(end.start, end.start + end.size),
    end,
  );
  let total = 0;
  const files: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const member of members) {
    if (member.local + 30 > end.start) return bad();
    const dataStart = memberData(
      buffer.subarray(member.local, member.local + 30),
      member,
      end,
      maxOutputBytes - total,
    );
    const compressedBytes = buffer.subarray(
      dataStart,
      dataStart + member.compressed,
    );
    let output: Uint8Array;
    try {
      output =
        member.method === 0
          ? compressedBytes
          : inflateRawSync(compressedBytes, {
              maxOutputLength: Math.max(1, maxOutputBytes - total),
            });
    } catch {
      return bad();
    }
    if (output.byteLength !== member.inflated || crc32(output) !== member.crc)
      return bad();
    total += output.byteLength;
    files.push({ name: member.name, bytes: new Uint8Array(output) });
  }
  return files;
}

/** Largest piece read from a source at once while inflating a member. */
export const ZIP_READ_BYTES = 1024 * 1024;
/** Central directories above this are refused rather than buffered. */
const ZIP_DIRECTORY_BYTES = 8 * 1024 * 1024;

/**
 * Incremental reportZip over a ranged source: the same checks, but members are
 * inflated piece by piece into `open(name)` sinks, so neither the archive nor
 * an inflated member is held whole. A member's sink ends only after its size
 * and CRC verify; a sink may already have seen data when a check fails.
 */
export async function reportZipStream(
  source: ReportSource,
  open: (name: string) => ByteSink,
  {
    maxOutputBytes = REPORT_MAX_BYTES,
    readBytes = ZIP_READ_BYTES,
  }: { maxOutputBytes?: number; readBytes?: number } = {},
): Promise<void> {
  const base = Math.max(0, source.size - ZIP_TAIL_BYTES);
  const tail = Buffer.from(await source.read(base, source.size - base));
  const end = zipEnd(tail, base, source.size);
  // The directory is metadata: one bounded read, inside the tail when small.
  if (end.size > ZIP_DIRECTORY_BYTES) return bad();
  const directory =
    end.start >= base
      ? tail.subarray(end.start - base, end.start - base + end.size)
      : Buffer.from(await source.read(end.start, end.size));
  const members = zipMembers(directory, end);
  let total = 0;
  for (const member of members) {
    if (member.local + 30 > end.start) return bad();
    const dataStart = memberData(
      Buffer.from(await source.read(member.local, 30)),
      member,
      end,
      maxOutputBytes - total,
    );
    const budget = maxOutputBytes - total;
    const sink = open(member.name);
    let produced = 0,
      crc = 0;
    const take = (chunk: Uint8Array) => {
      produced += chunk.byteLength;
      if (produced > member.inflated || produced > budget) bad();
      crc = crc32(chunk, crc);
      sink.push(chunk);
    };
    async function* compressed() {
      for (let at = 0; at < member.compressed; at += readBytes)
        yield await source.read(
          dataStart + at,
          Math.min(readBytes, member.compressed - at),
        );
    }
    if (member.method === 0) {
      for await (const chunk of compressed()) take(chunk);
    } else {
      try {
        await pipeline(
          Readable.from(compressed()),
          createInflateRaw(),
          async (output: AsyncIterable<Buffer>) => {
            for await (const chunk of output) take(chunk);
          },
        );
      } catch (error) {
        // Provider read failures and sink rejections keep their own meaning;
        // only zlib's own errors are archive damage.
        if (
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          error.code.startsWith("Z_")
        )
          return bad();
        throw error;
      }
    }
    if (produced !== member.inflated || crc !== member.crc) return bad();
    total += produced;
    sink.end();
  }
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
