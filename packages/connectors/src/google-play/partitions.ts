import { createHash, type Hash } from "node:crypto";

import {
  DATASET_LIMITS,
  type DatasetPage,
  type DatasetRecord,
  type DatasetStageWriter,
  type SourceDatasetDefinition,
} from "@netrics/connector-sdk";

import type { ReportObject } from "./api.js";

/**
 * JSON text of parsed rows held at once while a report is staged, across all
 * apps (#519). Above this, the app with the most pending rows is written out
 * as a shorter page, so memory does not grow with the number of apps. Pending
 * rows are kept as their JSON text, a fraction of the heap a parsed row takes.
 */
export const PENDING_STAGE_BYTES = 8 * 1024 * 1024;
/** Pages handed to the host per staging append. */
const APPEND_BYTES = 2 * 1024 * 1024;
/**
 * Pages one turn emits for its app when the report is not staged (#519): each
 * such turn reads the report again, so it takes as much as it can carry.
 */
export const UNSTAGED_TURN_PAGES = 8;
/** A page's transport overhead before its rows (as in the SDK page budget). */
const PAGE_BASE_BYTES = 4096;

export class RowTooLargeError extends Error {
  constructor() {
    super("Google Play report row exceeds the transport record budget");
  }
}
function rowText(row: DatasetRecord): { text: string; size: number } {
  const text = JSON.stringify(row);
  const size = Buffer.byteLength(text);
  if (size > DATASET_LIMITS.rowBytes) throw new RowTooLargeError();
  return { text, size };
}

/**
 * hash([rows, objects as [name, generation]]) built one row at a time, the
 * same bytes JSON.stringify of the whole value would produce.
 */
export class RowsDigest {
  #hash: Hash = createHash("sha256").update("[[");
  #rows = 0;
  get rows(): number {
    return this.#rows;
  }
  add(text: string): void {
    this.#hash.update((this.#rows++ ? "," : "") + text);
  }
  digest(objects: ReportObject[]): string {
    return this.#hash
      .update(
        "]," +
          JSON.stringify(
            objects.map((object) => [object.name, object.generation]),
          ) +
          "]",
      )
      .digest("hex");
  }
}

/** Whether a row of `size` bytes still fits a page holding `count` rows in `bytes`. */
function fits(count: number, bytes: number, size: number): boolean {
  return (
    count < DATASET_LIMITS.pageRows &&
    bytes + size + 1 <= DATASET_LIMITS.pageBytes
  );
}

export interface StagedPart {
  app: string;
  totalRows: number;
  digest: string;
  /** `bytes`: JSON text of the page's rows, so a turn can take several pages. */
  pages: Array<{ key: string; offset: number; count: number; bytes: number }>;
}
interface Partition {
  digest: RowsDigest;
  /** Rows of the app's next page, as JSON text. */
  pending: string[];
  bytes: number;
  offset: number;
  pages: StagedPart["pages"];
}

/**
 * Writes the rows of one report task into a stage while the report is read,
 * per app partition and in parse order. Each app holds at most one pending
 * page; full pages, and the largest pending page whenever all pending pages
 * together exceed PENDING_STAGE_BYTES, go to the host on the next drain
 * (queued pages are written once APPEND_BYTES collect).
 * Page boundaries depend only on the report, so a rebuilt stage has the same
 * pages. A page cut early is never marked complete: every app ends with a
 * final page (possibly empty) that is.
 */
export class StageBuilder {
  #parts = new Map<string, Partition>();
  #pending = 0;
  #queue: DatasetPage[] = [];
  #queued = 0;
  #sequence = 0;
  constructor(
    private readonly writer: DatasetStageWriter,
    private readonly definition: SourceDatasetDefinition,
    private readonly window: { from: string; toExclusive: string },
  ) {}

  /** Bytes of rows waiting in partially filled pages. */
  get pendingBytes(): number {
    return this.#pending;
  }

  #part(app: string): Partition {
    let part = this.#parts.get(app);
    if (!part) {
      part = {
        digest: new RowsDigest(),
        pending: [],
        bytes: PAGE_BASE_BYTES,
        offset: 0,
        pages: [],
      };
      this.#parts.set(app, part);
    }
    return part;
  }
  #cut(app: string, part: Partition, complete: boolean): void {
    const records = part.pending.map(
      (text) => JSON.parse(text) as DatasetRecord,
    );
    const pageKey = String(this.#sequence++);
    part.pages.push({
      key: pageKey,
      offset: part.offset,
      count: records.length,
      bytes: part.bytes - PAGE_BASE_BYTES,
    });
    this.#queue.push({
      datasetKey: this.definition.key,
      schemaVersion: this.definition.version,
      refreshKey: "staging",
      pageKey,
      previousPageKey: null,
      complete,
      records,
      window: { ...this.window, partition: { app_id: app } },
    });
    this.#queued += part.bytes;
    this.#pending -= part.bytes - PAGE_BASE_BYTES;
    part.offset += records.length;
    part.pending = [];
    part.bytes = PAGE_BASE_BYTES;
  }

  add(app: string, row: DatasetRecord): void {
    const { text, size } = rowText(row);
    const part = this.#part(app);
    part.digest.add(text);
    if (!fits(part.pending.length, part.bytes, size))
      this.#cut(app, part, false);
    part.pending.push(text);
    part.bytes += size + 1;
    this.#pending += size + 1;
    while (this.#pending > PENDING_STAGE_BYTES) {
      let largest: [string, Partition] | undefined;
      for (const entry of this.#parts)
        if (!largest || entry[1].bytes > largest[1].bytes) largest = entry;
      this.#cut(largest![0], largest![1], false);
    }
  }

  /** Writes queued pages once enough have collected (or always, with `all`). */
  async drain(all = false): Promise<void> {
    if (!this.#queue.length || (!all && this.#queued < APPEND_BYTES)) return;
    const pages = this.#queue;
    this.#queue = [];
    this.#queued = 0;
    await this.writer.append(pages);
  }

  /** Final pages for every app of the task (in `apps` order), then the page index. */
  async finish(apps: string[], objects: ReportObject[]): Promise<StagedPart[]> {
    const parts = apps.map((app) => {
      const part = this.#part(app);
      this.#cut(app, part, true);
      return {
        app,
        totalRows: part.offset,
        digest: part.digest.digest(objects),
        pages: part.pages,
      };
    });
    await this.drain(true);
    return parts;
  }
}

/** Rows of one app from a checkpoint offset, for a turn without a stage. */
export interface AppWindow {
  app: string;
  offset: number;
  /** Up to UNSTAGED_TURN_PAGES consecutive pages from `offset`. */
  pages: DatasetRecord[][];
  totalRows: number;
  digest: string;
}

/**
 * Keeps the rows of one app from `offset` while a report is read again, cut
 * into at most UNSTAGED_TURN_PAGES pages, and counts and digests all of that
 * app's rows. Without a fixed app it follows the smallest app id seen (and
 * the given candidates): the first app of the task. An app's rows all come
 * after the first one seen, so switching to a smaller app loses nothing.
 */
export class WindowReader {
  #app: string | undefined;
  #digest = new RowsDigest();
  #pages: DatasetRecord[][] = [];
  #page: DatasetRecord[] = [];
  #bytes = PAGE_BASE_BYTES;
  constructor(
    private readonly fixed: string | undefined,
    private readonly offset: number,
    candidates: string[],
  ) {
    this.#app = fixed ?? [...candidates].sort()[0];
  }
  add(app: string, row: DatasetRecord): void {
    if (app !== this.#app) {
      if (
        this.fixed !== undefined ||
        (this.#app !== undefined && app > this.#app)
      )
        return;
      this.#app = app;
      this.#digest = new RowsDigest();
      this.#pages = [];
      this.#page = [];
      this.#bytes = PAGE_BASE_BYTES;
    }
    const { text, size } = rowText(row);
    const index = this.#digest.rows;
    this.#digest.add(text);
    if (index < this.offset || this.#pages.length === UNSTAGED_TURN_PAGES)
      return;
    if (!fits(this.#page.length, this.#bytes, size)) {
      this.#pages.push(this.#page);
      this.#page = [];
      this.#bytes = PAGE_BASE_BYTES;
      if (this.#pages.length === UNSTAGED_TURN_PAGES) return;
    }
    this.#page.push(row);
    this.#bytes += size + 1;
  }
  result(objects: ReportObject[]): AppWindow | undefined {
    if (this.#app === undefined) return undefined;
    const pages = [...this.#pages];
    if (
      pages.length < UNSTAGED_TURN_PAGES &&
      (this.#page.length || !pages.length)
    )
      pages.push(this.#page);
    return {
      app: this.#app,
      offset: this.offset,
      pages,
      totalRows: this.#digest.rows,
      digest: this.#digest.digest(objects),
    };
  }
}
