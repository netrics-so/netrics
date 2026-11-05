import { describe, expect, it } from "vitest";
import { validateDatasetPage } from "@netrics/connector-sdk";

import {
  earningsDataset,
  earningsRows,
  installDataset,
  installRows,
} from "./datasets.js";
import {
  crc32,
  csvRecords,
  reportDecimal,
  reportText,
  reportZip,
} from "./tabular.js";
import { ALPHA, BETA, fixtureBytes } from "./test-helpers.js";

describe("Play report encodings and CSV", () => {
  it("decodes provider UTF-16 and preserves strings, quoted commas and multiline fields", () => {
    const text = 'Name,Code,Value\r\n"A, B",001,"first\nsecond ""quoted"""\r\n';
    for (const bytes of [
      new TextEncoder().encode(text),
      new Uint8Array(Buffer.from("\uFEFF" + text, "utf16le")),
    ]) {
      expect(csvRecords(reportText(bytes))).toEqual([
        { Name: "A, B", Code: "001", Value: 'first\nsecond "quoted"' },
      ]);
    }
    const little = Buffer.from("\uFEFF" + text, "utf16le");
    const big = Buffer.from(little);
    big.swap16();
    expect(csvRecords(reportText(big))).toHaveLength(1);
  });
  it("rejects malformed CSV and decoding without quoting source values", () => {
    for (const text of [
      "Name,Name\na,b",
      "Name,Value\na",
      'Name\n"unfinished',
      'Name\n"ok"unexpected',
      'Name\nbad"quote',
    ])
      expect(() => csvRecords(text)).toThrow("Google Play report");
    expect(() => reportText(new Uint8Array([0xc3, 0x28]))).toThrow("encoding");
  });
  it("canonicalizes decimal strings exactly, without locale guesses or floating-point rounding", () => {
    expect(reportDecimal("-001,234.560000")).toBe("-1234.560000");
    expect(reportDecimal("9007199254740993.123456789012345678")).toBe(
      "9007199254740993.123456789012345678",
    );
    expect(reportDecimal("-0.000")).toBe("0.000");
    expect(reportDecimal("", true)).toBeNull();
    for (const bad of [
      "",
      "1,2",
      "1.234,56",
      "NaN",
      "1e3",
      "private-invalid-input",
    ]) {
      try {
        reportDecimal(bad);
        expect.unreachable();
      } catch (error) {
        expect(String(error)).not.toContain("private-invalid-input");
        expect(String(error)).toContain("invalid decimal");
      }
    }
  });
});

describe("earnings archive integrity", () => {
  it("reads a standard-library generated ZIP and verifies a known independent CRC vector", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const files = reportZip(fixtureBytes("earnings_202610.zip"));
    expect(files.map((file) => file.name)).toEqual(["earnings.csv"]);
    expect(csvRecords(reportText(files[0]!.bytes))).toHaveLength(8);
  });
  it("rejects truncated archives, wrong checksums, unsupported methods and output beyond budget", () => {
    const original = Buffer.from(fixtureBytes("earnings_202610.zip"));
    expect(() => reportZip(original.subarray(0, original.length - 1))).toThrow(
      "ZIP",
    );
    const crc = Buffer.from(original),
      central = crc.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    crc[central + 16] = crc[central + 16]! ^ 1;
    expect(() => reportZip(crc)).toThrow("ZIP");
    const method = Buffer.from(original);
    method.writeUInt16LE(99, central + 10);
    expect(() => reportZip(method)).toThrow("ZIP");
    expect(() => reportZip(original, 32)).toThrow("ZIP");
  });
});

describe("typed provider records", () => {
  it("keeps zero and withheld install values distinct, with original fields and app/date scope", () => {
    const records = installRows(
      fixtureBytes("installs-alpha.csv"),
      ALPHA,
      "2026-10-01",
      "report.csv",
      "123",
    );
    expect(records.map((row) => row.values.daily_user_installs)).toEqual([
      "10",
      "0",
      null,
    ]);
    expect(records[0]?.values.provider_fields).toMatchObject({
      "Future metric": "001",
    });
    expect(
      validateDatasetPage(installDataset, {
        datasetKey: installDataset.key,
        schemaVersion: 1,
        refreshKey: "run",
        pageKey: "0",
        previousPageKey: null,
        records,
        complete: true,
        window: {
          from: "2026-10-01",
          toExclusive: "2026-11-01",
          partition: { app_id: ALPHA },
        },
      }).records,
    ).toEqual(records);
    expect(() =>
      installRows(
        fixtureBytes("installs-alpha.csv"),
        BETA,
        "2026-10-01",
        "report.csv",
        "123",
      ),
    ).toThrow("scope");
    expect(() =>
      installRows(
        fixtureBytes("installs-alpha.csv"),
        ALPHA,
        "2026-11-01",
        "report.csv",
        "123",
      ),
    ).toThrow("scope");
    expect(() =>
      installRows(
        new TextEncoder().encode("Wrong,Headers\n"),
        ALPHA,
        "2026-10-01",
        "report.csv",
        "123",
      ),
    ).toThrow("required columns");
  });
  it("retains exact fee/refund/unknown lines and report-month identities without allocating account adjustments", () => {
    const parsed = earningsRows(
      fixtureBytes("earnings_202610.zip"),
      "2026-10-01",
      "earnings.zip",
      "123",
    );
    expect(parsed.records.get(ALPHA)).toHaveLength(5);
    expect(parsed.records.get(BETA)).toHaveLength(2);
    expect(parsed.records.get("__unmapped")).toHaveLength(1);
    expect(parsed.unmapped).toBe(1);
    expect(
      parsed.records.get(ALPHA)?.map((row) => row.values.merchant_amount),
    ).toEqual(["10.00", "-3.00", "-2.00", "0.60", "-0.10"]);
    expect(
      parsed.records.get(ALPHA)?.[0]?.values.provider_fields,
    ).toMatchObject({ "Buyer Postcode": "00123", "Future Column": "retained" });
    expect(
      earningsDataset.fields.find((field) => field.id === "provider_fields"),
    ).toMatchObject({ classification: "personal", retentionDays: null });
    for (const [app, records] of parsed.records)
      validateDatasetPage(earningsDataset, {
        datasetKey: earningsDataset.key,
        schemaVersion: 1,
        refreshKey: "run",
        pageKey: app,
        previousPageKey: null,
        records,
        complete: true,
        window: {
          from: "2026-10-01",
          toExclusive: "2026-11-01",
          partition: { app_id: app },
        },
      });
    const selected = earningsRows(
      fixtureBytes("earnings_202610.zip"),
      "2026-10-01",
      "earnings.zip",
      "123",
      new Set([ALPHA]),
    );
    expect([...selected.records.keys()]).toEqual([ALPHA]);
    expect(selected.unmapped).toBe(1);
    const adjustment = earningsRows(
      fixtureBytes("earnings_202610_adjustment.zip"),
      "2026-10-01",
      "adjustment.zip",
      "124",
    );
    expect(adjustment.records.get(ALPHA)?.[0]?.values).toMatchObject({
      transaction_type: "Adjustment",
      merchant_amount: "0.25",
      report_month: "2026-10-01",
    });
  });
});
