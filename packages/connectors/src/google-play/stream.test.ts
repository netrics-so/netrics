import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";
import {
  syncResultSchema,
  type ConnectionContext,
  type DatasetPage,
  type SyncRequest,
} from "@netrics/connector-sdk";

import { createPlayReportsClient, REPORT_RANGE_BYTES } from "./api.js";
import {
  earningsRows,
  installRows,
  ReportTooLargeError,
  streamEarningsRows,
  streamInstallRows,
} from "./datasets.js";
import { createGooglePlayConnector } from "./index.js";
import { rowsDigest } from "./sync.js";
import {
  crc32,
  REPORT_MAX_BYTES,
  reportCsv,
  reportZipStream,
  type ByteSink,
} from "./tabular.js";
import {
  ALPHA,
  BETA,
  fakePlay,
  fixtureBytes,
  memorySource,
  TEST_BUCKET,
  TEST_NOW,
  zipArchive,
} from "./test-helpers.js";

// The buffered parsers as they were before incremental parsing, kept verbatim
// as the reference the streamed parsers must match.
/** Decode provider report text without lossy replacement of malformed bytes. */
function legacyReportText(bytes: Uint8Array): string {
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
function legacyCsvTable(text: string): {
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

/**
 * Read CSV members in memory, never extract paths. Central-directory lengths,
 * output budget, compression method and CRC are checked before use. Unsupported
 * ZIP64/multipart metadata is rejected explicitly rather than truncated.
 */
function legacyReportZip(
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

type Table = { headers: string[]; records: Array<Record<string, string>> };
function outcome<T>(run: () => T): { ok: T } | { error: string } {
  try {
    return { ok: run() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
async function settled<T>(run: () => Promise<T>) {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
function streamedCsv(bytes: Uint8Array, size: number): Table {
  let headers: string[] = [];
  const records: Table["records"] = [];
  const sink = reportCsv(
    (names) => (headers = names),
    (record) => records.push(record),
  );
  for (let at = 0; at < bytes.byteLength; at += size)
    sink.push(bytes.subarray(at, at + size));
  sink.end();
  return { headers, records };
}
const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const utf16le = (text: string) => new Uint8Array(Buffer.from(text, "utf16le"));
const utf16be = (text: string) => {
  const bytes = Buffer.from(text, "utf16le");
  bytes.swap16();
  return new Uint8Array(bytes);
};
const encodings = (text: string) => [
  utf8(text),
  utf8("﻿" + text),
  utf16le("﻿" + text),
  utf16le(text),
  utf16be("﻿" + text),
];
const CHUNKS = [1, 2, 3, 5, 8, 13, 64, 4096];

const EARNINGS_HEADER =
  "Description,Transaction Date,Transaction Type,Package ID,Buyer Country,Merchant Currency,Amount (Merchant Currency)";
const charge = (app: string, amount = "1.00", id = "GPA.1") =>
  `${id},"Oct 01, 2026",Charge,${app},US,USD,${amount}`;
const earningsCsv = (rows: string[]) =>
  EARNINGS_HEADER + "\r\n" + rows.join("\r\n") + "\r\n";
/** Several CSV members (deflated, stored, UTF-16 and UTF-8) plus a skipped file. */
function multiArchive(): Uint8Array {
  return zipArchive([
    {
      name: "first.csv",
      bytes: utf16le(
        "﻿" + earningsCsv([charge(ALPHA), charge(ALPHA), charge(BETA, "2.50")]),
      ),
    },
    { name: "README.txt", bytes: utf8("not a report") },
    {
      name: "second.csv",
      bytes: utf8(earningsCsv([charge(ALPHA), charge("", "-0.30", "fee")])),
      store: true,
    },
    {
      name: "nested/third.CSV",
      bytes: utf8(
        earningsCsv([
          `"multi\nline","Oct 31, 2026",Refund,${BETA},DE,EUR,-1.00`,
        ]),
      ),
    },
  ]);
}
async function streamedMembers(
  bytes: Uint8Array,
  readBytes: number,
  maxOutputBytes?: number,
) {
  const files: Array<{ name: string; bytes: Uint8Array }> = [];
  await reportZipStream(
    memorySource(bytes).source,
    (name): ByteSink => {
      const parts: Uint8Array[] = [];
      return {
        push: (chunk) => parts.push(new Uint8Array(chunk)),
        end: () => files.push({ name, bytes: Buffer.concat(parts) }),
      };
    },
    { readBytes, ...(maxOutputBytes ? { maxOutputBytes } : {}) },
  );
  return files.map((file) => ({
    name: file.name,
    bytes: Buffer.from(file.bytes),
  }));
}
const legacyMembers = (bytes: Uint8Array, maxOutputBytes?: number) =>
  legacyReportZip(bytes, maxOutputBytes).map((file) => ({
    name: file.name,
    bytes: Buffer.from(file.bytes),
  }));

describe("incremental report text and CSV", () => {
  it("matches the buffered parser for every encoding and chunk boundary, including failures", () => {
    const texts = [
      'Name,Code,Value\r\n"A, B",001,"first\nsecond ""quoted"""\r\n',
      "Name,Value\n\n\na,1\r\rb,2",
      '﻿Name,City\n"x" ,Zürich\n"""",🎉 emoji\n',
      'A,B\r\n1,""\r\n,\r\n2,"x\r\ny"',
      'Name\n"unfinished',
      "Name,Name\na,b",
      "Name,Value\na",
      'Name\n"ok"unexpected',
      'Name\nbad"quote',
      "Nul,Value\na\0,1",
      "",
      "a",
      "ab\n",
    ];
    const inputs = [
      ...texts.flatMap(encodings),
      new Uint8Array([0xc3, 0x28]),
      new Uint8Array([...utf16le("﻿Name\nx"), 0x41]),
      fixtureBytes("installs-alpha.csv"),
      fixtureBytes("installs-beta.csv"),
      ...["earnings_202610.zip", "earnings_202610_adjustment.zip"].flatMap(
        (name) => legacyReportZip(fixtureBytes(name)).map((file) => file.bytes),
      ),
    ];
    let compared = 0;
    for (const bytes of inputs) {
      const expected = outcome(() => legacyCsvTable(legacyReportText(bytes)));
      for (const size of CHUNKS) {
        expect(outcome(() => streamedCsv(bytes, size))).toEqual(expected);
        compared++;
      }
    }
    expect(compared).toBe(inputs.length * CHUNKS.length);
  });
});

describe("incremental earnings archives", () => {
  it("inflates several members piece by piece exactly as the buffered reader does", async () => {
    const archives = [
      multiArchive(),
      fixtureBytes("earnings_202610.zip"),
      fixtureBytes("earnings_202610_adjustment.zip"),
    ];
    for (const archive of archives) {
      const expected = legacyMembers(archive);
      for (const size of [1, 7, 4096])
        expect(await streamedMembers(archive, size)).toEqual(expected);
    }
    expect(legacyMembers(archives[0]!).map((file) => file.name)).toEqual([
      "first.csv",
      "second.csv",
      "nested/third.CSV",
    ]);
  });
  it("rejects the same damaged, ambiguous or oversized archives", async () => {
    const original = Buffer.from(multiArchive());
    const central = original.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    const variant = (edit: (bytes: Buffer) => void) => {
      const bytes = Buffer.from(original);
      edit(bytes);
      return new Uint8Array(bytes);
    };
    const cases: Array<[Uint8Array, number?]> = [
      [variant((bytes) => (bytes[central + 16] = bytes[central + 16]! ^ 1))],
      [variant((bytes) => bytes.writeUInt16LE(99, central + 10))],
      [variant((bytes) => (bytes[0] = 0))],
      [variant((bytes) => (bytes[40] = bytes[40]! ^ 0xff))],
      [original.subarray(0, original.length - 1)],
      [new Uint8Array(Buffer.concat([original, Buffer.from([0])]))],
      [
        zipArchive([
          { name: "a.csv", bytes: utf8("A\n1\n") },
          { name: "a.csv", bytes: utf8("A\n2\n") },
        ]),
      ],
      [zipArchive([{ name: "notes.txt", bytes: utf8("A\n1\n") }])],
      [new Uint8Array(10)],
      [original, 32],
      [original, legacyMembers(original)[0]!.bytes.byteLength + 1],
    ];
    for (const [bytes, budget] of cases) {
      const expected = outcome(() => legacyMembers(bytes, budget));
      expect(expected).toHaveProperty("error");
      for (const size of [1, 7, 4096])
        expect(
          await settled(() => streamedMembers(bytes, size, budget)),
        ).toEqual(expected);
    }
  });
  it("keeps a provider read failure distinct from archive damage mid-member", async () => {
    const archive = multiArchive();
    const failure = new Error("synthetic provider read failure");
    let reads = 0;
    const source = {
      size: archive.byteLength,
      async read(offset: number, length: number) {
        // The tail, then the first local header, then member data.
        if (++reads === 4) throw failure;
        return archive.slice(offset, offset + length);
      },
    };
    await expect(
      reportZipStream(source, () => ({ push() {}, end() {} }), {
        readBytes: 16,
      }),
    ).rejects.toBe(failure);
  });
});

describe("streamed typed rows", () => {
  it("keeps row identities, duplicate ordinals, scope, selection and unmapped counts", async () => {
    for (const archive of [
      multiArchive(),
      fixtureBytes("earnings_202610.zip"),
      fixtureBytes("earnings_202610_adjustment.zip"),
    ])
      for (const selected of [undefined, new Set([ALPHA]), new Set<string>()])
        expect(
          await streamEarningsRows(
            memorySource(archive).source,
            "2026-10-01",
            "earnings/x.zip",
            "7",
            selected,
          ),
        ).toEqual(
          earningsRows(archive, "2026-10-01", "earnings/x.zip", "7", selected),
        );
    const parsed = await streamEarningsRows(
      memorySource(multiArchive()).source,
      "2026-10-01",
      "earnings/x.zip",
      "7",
    );
    const alpha = parsed.records.get(ALPHA)!.map((row) => row.values);
    expect(alpha.map((row) => String(row.row_id).slice(-2))).toEqual([
      "-0",
      "-1",
      "-0",
    ]);
    expect(String(alpha[0]!.row_id).slice(0, 64)).toBe(
      String(alpha[1]!.row_id).slice(0, 64),
    );
    expect(alpha.map((row) => row.report_file)).toEqual([
      "earnings/x.zip/first.csv",
      "earnings/x.zip/first.csv",
      "earnings/x.zip/second.csv",
    ]);
    expect(parsed.unmapped).toBe(1);

    const header =
      "Date,Package Name,Country,Daily User Installs,Daily Device Installs\r\n";
    const row = `2026-10-02,${ALPHA},us,3,4\r\n`;
    for (const bytes of [
      fixtureBytes("installs-alpha.csv"),
      utf16le("﻿" + header + row + row),
      utf8(header + row),
    ])
      for (const [app, month] of [
        [ALPHA, "2026-10-01"],
        [BETA, "2026-10-01"],
        [ALPHA, "2026-11-01"],
      ] as const)
        expect(
          await settled(() =>
            streamInstallRows(memorySource(bytes).source, app, month, "f", "1"),
          ),
        ).toEqual(outcome(() => installRows(bytes, app, month, "f", "1")));
  });
  it("digests rows exactly as hashing their whole JSON text did, so checkpoints carry over", async () => {
    const objects = [
      { name: "earnings/a.zip", generation: "1", updated: "", size: "1" },
      { name: "earnings/ü🎉.zip", generation: "22", updated: "", size: "1" },
    ];
    const rows = [
      ...installRows(
        fixtureBytes("installs-alpha.csv"),
        ALPHA,
        "2026-10-01",
        "f",
        "1",
      ),
      ...[
        ...earningsRows(
          multiArchive(),
          "2026-10-01",
          "x.zip",
          "7",
        ).records.values(),
      ].flat(),
      { values: { text: "lone \ud800 surrogate", nested: { a: [1, null] } } },
    ];
    for (const set of [rows, rows.slice(0, 1), []])
      expect(rowsDigest(set, objects)).toBe(
        createHash("sha256")
          .update(
            JSON.stringify([
              set,
              objects.map((object) => [object.name, object.generation]),
            ]),
          )
          .digest("hex"),
      );
  });
  it("refuses an object above the read limit before reading any of it", async () => {
    const { source, reads } = memorySource(new Uint8Array(1));
    const large = { ...source, size: REPORT_MAX_BYTES + 1 };
    await expect(
      streamEarningsRows(large, "2026-10-01", "x.zip", "1"),
    ).rejects.toBeInstanceOf(ReportTooLargeError);
    await expect(
      streamInstallRows(large, ALPHA, "2026-10-01", "x.csv", "1"),
    ).rejects.toBeInstanceOf(ReportTooLargeError);
    expect(reads).toEqual([]);
  });
});

const context: ConnectionContext = {
  connectionId: "play-stream",
  credentials: { accessToken: "synthetic-access-token" },
  config: { reportBucket: TEST_BUCKET },
};
const FETCH_LIMIT = 10 * 1024 * 1024;

describe("range-bounded report transfer", () => {
  it("reads an object above the fetch limit as pinned ranges no larger than one range", async () => {
    const fake = fakePlay({ maxResponseBytes: FETCH_LIMIT });
    const bytes = new Uint8Array(2 * REPORT_RANGE_BYTES + 12345);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
    fake.put("earnings/earnings_202609.zip", bytes, "9");
    const object = fake.objects.get("earnings/earnings_202609.zip")!;
    const client = createPlayReportsClient(context, fake.runtime);
    await expect(client.bytes(object)).rejects.toThrow("fetch limit");
    const source = client.source(object);
    expect(source.size).toBe(bytes.length);
    expect(
      Buffer.from(await source.read(REPORT_RANGE_BYTES - 3, 10)).equals(
        Buffer.from(
          bytes.subarray(REPORT_RANGE_BYTES - 3, REPORT_RANGE_BYTES + 7),
        ),
      ),
    ).toBe(true);
    const parts: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += 1024 * 1024)
      parts.push(
        await source.read(at, Math.min(1024 * 1024, bytes.length - at)),
      );
    expect(Buffer.concat(parts).equals(Buffer.from(bytes))).toBe(true);
    const media = fake.calls.filter(
      (call) => call.url.searchParams.get("alt") === "media",
    );
    expect(media.map((call) => call.init?.headers?.range)).toEqual([
      undefined,
      `bytes=0-${REPORT_RANGE_BYTES - 1}`,
      `bytes=${REPORT_RANGE_BYTES}-${2 * REPORT_RANGE_BYTES - 1}`,
      `bytes=0-${REPORT_RANGE_BYTES - 1}`,
      `bytes=${REPORT_RANGE_BYTES}-${2 * REPORT_RANGE_BYTES - 1}`,
      `bytes=${2 * REPORT_RANGE_BYTES}-${bytes.length - 1}`,
    ]);
    expect(
      media.every((call) => call.url.searchParams.get("generation") === "9"),
    ).toBe(true);
    expect(Math.max(...fake.mediaBytes)).toBeLessThanOrEqual(
      REPORT_RANGE_BYTES,
    );
  });
  it("fetches a small object whole and rejects ranges that do not match the pinned object", async () => {
    const fake = fakePlay();
    const object = fake.objects.get("earnings/earnings_202610.zip")!;
    const client = createPlayReportsClient(context, fake.runtime);
    await client.source(object).read(0, 22);
    expect(
      fake.calls
        .filter((call) => call.url.searchParams.get("alt") === "media")
        .map((call) => call.init?.headers?.range),
    ).toEqual([undefined]);
    fake.put(
      "earnings/earnings_202609.zip",
      new Uint8Array(REPORT_RANGE_BYTES + 1),
      "3",
    );
    const large = fake.objects.get("earnings/earnings_202609.zip")!;
    for (const [header, value] of [
      [
        "content-range",
        `bytes 0-${REPORT_RANGE_BYTES - 1}/${REPORT_RANGE_BYTES + 2}`,
      ],
      ["x-goog-generation", "4"],
    ] as const) {
      const altered = createPlayReportsClient(context, {
        ...fake.runtime,
        fetch: async (url, init) => {
          const response = await fake.fetch(url, init);
          return init?.headers?.range
            ? { ...response, headers: { ...response.headers, [header]: value } }
            : response;
        },
      });
      await expect(altered.source(large).read(0, 1)).rejects.toThrow(
        "while it was read",
      );
    }
  });
});

describe("large report ingestion", () => {
  const request: SyncRequest = {
    mode: "backfill",
    from: "2026-10-01T00:00:00.000Z",
    to: new Date(TEST_NOW).toISOString(),
    resources: [ALPHA],
  };
  async function syncAll(fake: ReturnType<typeof fakePlay>) {
    const connector = createGooglePlayConnector({ now: () => TEST_NOW });
    const pages: DatasetPage[] = [];
    let cursor: string | undefined;
    for (let turn = 0; turn < 50; turn++) {
      const result = syncResultSchema.parse(
        await connector.sync(context, { ...request, cursor }, fake.runtime),
      );
      pages.push(...(result.datasetPages ?? []));
      if (result.done) return pages;
      cursor = result.nextCursor;
    }
    throw new Error("Sync did not finish");
  }
  it("ingests an earnings archive above the fetch limit through bounded ranges", async () => {
    const fake = fakePlay({ maxResponseBytes: FETCH_LIMIT });
    const other = charge(BETA, "1.00", "GPA.0000-0000-0000-00000");
    const rows = Array.from(
      { length: Math.ceil((1.5 * FETCH_LIMIT) / other.length) },
      () => other,
    );
    rows.splice(1000, 0, charge(ALPHA, "4.00"), charge(ALPHA, "4.00"));
    rows.push(charge(ALPHA, "-1.00", "refund"));
    const archive = zipArchive([
      { name: "earnings.csv", bytes: utf8(earningsCsv(rows)), store: true },
    ]);
    expect(archive.byteLength).toBeGreaterThan(FETCH_LIMIT);
    fake.objects.delete("earnings/earnings_202610_adjustment.zip");
    fake.put("earnings/earnings_202610.zip", archive, "5");
    const pages = await syncAll(fake);
    const earnings = pages
      .filter((page) => page.datasetKey === "earning_rows")
      .flatMap((page) => page.records.map((row) => row.values));
    expect(earnings.map((row) => row.merchant_amount).sort()).toEqual([
      "-1.00",
      "4.00",
      "4.00",
    ]);
    expect(new Set(earnings.map((row) => row.row_id)).size).toBe(3);
    expect(
      pages
        .filter((page) => page.datasetKey === "report_status")
        .flatMap((page) => page.records.map((row) => row.values))
        .find(
          (row) =>
            row.report_type === "earnings" && row.report_month === "2026-10-01",
        ),
    ).toMatchObject({ availability: "available", unmapped_rows: 0 });
    expect(Math.max(...fake.mediaBytes)).toBeLessThanOrEqual(
      REPORT_RANGE_BYTES,
    );
    expect(fake.calls.some((call) => call.init?.headers?.range)).toBe(true);
  });
  it("records an object above the read limit as invalid without downloading it", async () => {
    const fake = fakePlay();
    const name = "earnings/earnings_202610.zip";
    fake.objects.set(name, {
      ...fake.objects.get(name)!,
      size: String(REPORT_MAX_BYTES + 1),
    });
    const pages = await syncAll(fake);
    expect(
      pages
        .filter((page) => page.datasetKey === "report_status")
        .flatMap((page) => page.records.map((row) => row.values))
        .find(
          (row) =>
            row.report_type === "earnings" && row.report_month === "2026-10-01",
        ),
    ).toMatchObject({ availability: "invalid_report" });
    expect(
      fake.calls.some(
        (call) =>
          call.url.pathname.endsWith(encodeURIComponent(name)) &&
          call.url.searchParams.get("alt") === "media",
      ),
    ).toBe(false);
  });
});

describe("bounded parser memory", () => {
  const MIB = 1024 * 1024;
  // Measure live memory, not garbage the collector has not reached yet.
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const used = () => {
    gc();
    const memory = process.memoryUsage();
    return memory.heapUsed + memory.arrayBuffers;
  };
  it("does not retain a large report while streaming it", async () => {
    const line = `2026-10-01,${ALPHA},US,1,2,${"x".repeat(27)}\n`;
    const block = utf8(line.repeat(Math.floor(MIB / line.length)));
    const total = 48;
    // Deflated, the repetitive member is small; inflated it is 48 MiB.
    const member = new Uint8Array(total * block.byteLength);
    for (let i = 0; i < total; i++) member.set(block, i * block.byteLength);
    const archive = zipArchive([{ name: "large.csv", bytes: member }]);
    const expectedRows = total * Math.floor(MIB / line.length);
    const results: Array<{ rows: number; peak: number }> = [];
    for (const run of ["text", "zip"] as const) {
      const baseline = used();
      let peak = 0,
        rows = 0;
      const sink = reportCsv(
        () => {},
        () => {
          if (++rows % 100_000 === 0) peak = Math.max(peak, used() - baseline);
        },
      );
      if (run === "text") {
        for (let i = 0; i < total; i++) sink.push(block);
        sink.end();
      } else
        await reportZipStream(memorySource(archive).source, () => sink, {
          maxOutputBytes: REPORT_MAX_BYTES,
        });
      results.push({ rows, peak });
    }
    for (const result of results) {
      // The header row is the first line; every other line is a record.
      expect(result.rows).toBe(expectedRows - 1);
      expect(result.peak).toBeLessThan(8 * MIB);
    }
    if (process.env.PLAY_MEMORY_REPORT) console.log(results);
  }, 60_000);
});
