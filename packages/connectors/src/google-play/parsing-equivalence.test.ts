import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { installRows } from "./datasets.js";
import { CsvParser } from "./tabular.js";

// #528 rewrote the CSV scanner and row ids to allocate less. These are the
// implementations before; parsed cells and stored row ids must not change.

class PreviousCsvParser {
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

type Parser = { push(text: string): void; end(): void };
function parse(
  make: (onRow: (cells: string[]) => void) => Parser,
  chunks: string[],
): string[][] | string {
  const rows: string[][] = [];
  const parser = make((cells) => rows.push(cells));
  try {
    for (const chunk of chunks) parser.push(chunk);
    parser.end();
  } catch (error) {
    return (error as Error).message + " after " + JSON.stringify(rows);
  }
  return rows;
}

describe("CSV scanning (#528)", () => {
  it("reads every input and every chunking as before", () => {
    let seed = 528;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const alphabet = ["a", "b", ",", '"', '"', "\r", "\n", " ", "\t", "é", "x"];
    for (let i = 0; i < 20_000; i++) {
      const text = Array.from(
        { length: Math.floor(random() * 24) },
        () => alphabet[Math.floor(random() * alphabet.length)]!,
      ).join("");
      const chunks: string[] = [];
      for (let at = 0; at < text.length;) {
        const size = 1 + Math.floor(random() * 6);
        chunks.push(text.slice(at, at + size));
        at += size;
      }
      const expected = parse((onRow) => new PreviousCsvParser(onRow), chunks);
      expect(
        parse((onRow) => new CsvParser(onRow), chunks),
        JSON.stringify(chunks),
      ).toEqual(expected);
      expect(parse((onRow) => new CsvParser(onRow), [text])).toEqual(
        parse((onRow) => new PreviousCsvParser(onRow), [text]),
      );
    }
  });
});

describe("Google Play row ids (#528)", () => {
  it("are the hash of the sorted original columns, as before", () => {
    // Extra column names that localeCompare orders differently from code
    // units: case, accents and digits.
    const headers = [
      "Date",
      "Package Name",
      "Country",
      "Daily User Installs",
      "Daily Device Installs",
      "zeta",
      "Äpfel",
      "apple",
      "Apple 10",
      "Apple 9",
      "_under",
    ];
    const line = (day: string, extra: string) =>
      [
        day,
        "com.example",
        "de",
        "1",
        "2",
        extra,
        '"q,""u"""',
        "",
        "x",
        "y",
        "😀",
      ].join(",");
    const csv = [
      headers.join(","),
      line("2026-10-01", "a"),
      line("2026-10-02", "b"),
      line("2026-10-02", "b"), // identical line: ordinal 1
      line("2026-10-03", "ü"),
    ].join("\r\n");
    const rows = installRows(
      new TextEncoder().encode(csv),
      "com.example",
      "2026-10-01",
      "installs.csv",
      "7",
    );
    expect(rows).toHaveLength(4);
    const seen = new Map<string, number>();
    for (const row of rows) {
      const original = row.values.provider_fields as Record<string, string>;
      const hash = createHash("sha256")
        .update(
          JSON.stringify(
            Object.entries(original).sort(([a], [b]) => a.localeCompare(b)),
          ),
        )
        .digest("hex");
      const ordinal = seen.get(hash.slice(0, 24)) ?? 0;
      seen.set(hash.slice(0, 24), ordinal + 1);
      expect(row.values.row_id).toBe(`${hash}-${ordinal}`);
    }
    expect(String(rows[2]!.values.row_id).endsWith("-1")).toBe(true);
  });
});
