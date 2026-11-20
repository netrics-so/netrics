// The custom-api connector: runs one connection's pinned definition. Each
// sync call sends exactly one HTTP request and returns the dataset pages it
// yields; the cursor carries the position (stream, chunk, page) and the
// run's safety-limit counters. Errors carry a status, a stream key and a
// redacted URL, never a response body, header value or credential.

import { createHash } from "node:crypto";

import {
  DATASET_LIMITS,
  RateLimitedError,
  type CheckResult,
  type ConnectionContext,
  type Connector,
  type ConnectorResponse,
  type ConnectorRuntime,
  type DatasetPage,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";
import {
  CUSTOM_API_LIMITS,
  type CustomApiDefinition,
  type CustomApiStream,
} from "@netrics/connector-sdk/custom-api";

import type { CustomApiCredentials } from "./credentials.js";
import {
  decodeCursor,
  encodeCursor,
  type CustomApiCursorV1,
} from "./cursor.js";
import {
  CustomApiAuthError,
  CustomApiConfigError,
  CustomApiLimitError,
  CustomApiResponseError,
} from "./errors.js";
import {
  customApiEnvironment,
  customApiEnvironmentHost,
  customApiManifest,
  type CustomApiPin,
} from "./manifest.js";
import { CUSTOM_API_MESSAGES } from "./messages.js";
import { nextPage, pageParams, type PageState } from "./pagination.js";
import { jsonTooDeep, mapRecords, selectRecords } from "./records.js";
import { buildRequest, type BuiltRequest } from "./request.js";
import {
  chunkDates,
  chunkInstants,
  nextFromFor,
  streamChunks,
  windowPlaceholders,
  type Chunk,
} from "./windows.js";

export {
  CUSTOM_API_AUTH_ERROR,
  CUSTOM_API_LIMIT_ERROR,
  CustomApiAuthError,
  CustomApiLimitError,
} from "./errors.js";

export interface CustomApiConnectorInput {
  definition: CustomApiDefinition;
  pin: CustomApiPin;
  /** Clock for the run duration limit; tests pin it. */
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Room for a page's envelope next to its rows, below DATASET_LIMITS.pageBytes. */
const PAGE_ROW_BYTES = DATASET_LIMITS.pageBytes - 16_384;

const encoder = new TextEncoder();

function retryAt(response: ConnectorResponse, now: number): Date | undefined {
  const header = response.headers["retry-after"];
  if (!header) return undefined;
  const seconds = Number(header);
  if (/^\d+$/.test(header.trim()) && Number.isFinite(seconds))
    return new Date(now + seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? new Date(date) : undefined;
}

/** A 2xx body as JSON, or CustomApiResponseError(notJson). */
function readJson(response: ConnectorResponse): unknown {
  let text: string;
  try {
    text = response.text();
  } catch {
    throw new CustomApiResponseError(CUSTOM_API_MESSAGES.notJson);
  }
  if (jsonTooDeep(text))
    throw new CustomApiResponseError(CUSTOM_API_MESSAGES.notJson);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CustomApiResponseError(CUSTOM_API_MESSAGES.notJson);
  }
}

function sha256(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Rows into dataset pages of at most 1,000 rows and 1 MiB. */
function cutRows(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[][] {
  const pages: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = encoder.encode(JSON.stringify({ values: row })).length + 1;
    if (
      current.length > 0 &&
      (current.length >= DATASET_LIMITS.pageRows ||
        bytes + size > PAGE_ROW_BYTES)
    ) {
      pages.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

export function createCustomApiConnector(
  input: CustomApiConnectorInput,
): Connector {
  const { definition, pin } = input;
  const now = input.now ?? Date.now;
  const manifest = customApiManifest(definition, pin);
  const environment = customApiEnvironment(definition, pin.environmentId);
  const apiHost = customApiEnvironmentHost(environment);
  const timeZone = definition.defaults.timeZone;

  function build(
    context: ConnectionContext,
    stream: CustomApiStream,
    chunk: Chunk | null,
    page: PageState,
  ): BuiltRequest {
    const params = pageParams(stream.pagination, page);
    return buildRequest({
      definition,
      stream,
      environment,
      config: context.config,
      credentials: context.credentials as CustomApiCredentials,
      placeholders: {
        ...(chunk && stream.window.type !== "none"
          ? windowPlaceholders(stream.window, chunk, timeZone)
          : {}),
        ...params.placeholders,
      },
      pageParams: params.params,
      ...(params.nextUrl !== undefined ? { nextUrl: params.nextUrl } : {}),
    });
  }

  /** Throws for every non-2xx answer; 401/403 as CustomApiAuthError. */
  function refuse(
    response: ConnectorResponse,
    built: BuiltRequest,
    stream: CustomApiStream,
  ): never {
    if (response.status === 401)
      throw new CustomApiAuthError(CUSTOM_API_MESSAGES.unauthorized);
    if (response.status === 403)
      throw new CustomApiAuthError(CUSTOM_API_MESSAGES.forbidden);
    const where = `stream ${stream.key}`;
    if (response.status === 429) {
      const at = retryAt(response, now());
      if (at)
        throw new RateLimitedError(
          `HTTP 429 from ${built.redactedUrl} (${where})`,
          at,
        );
    }
    throw new Error(
      `HTTP ${response.status} from ${built.redactedUrl} (${where})`,
    );
  }

  async function check(
    context: ConnectionContext,
    runtime: ConnectorRuntime,
  ): Promise<CheckResult> {
    const stream = definition.streams[0]!;
    const to = new Date(now());
    const chunks = streamChunks(
      stream,
      {
        mode: "incremental",
        from: new Date(to.getTime() - DAY_MS).toISOString(),
        to: to.toISOString(),
      },
      timeZone,
    );
    const chunk = chunks[chunks.length - 1] ?? null;
    let built: BuiltRequest;
    try {
      built = build(context, stream, chunk, { type: "first" });
    } catch (error) {
      if (
        error instanceof CustomApiAuthError ||
        error instanceof CustomApiConfigError
      )
        return { ok: false, message: error.message };
      throw error;
    }
    const response = await runtime.fetch(built.url, { headers: built.headers });
    if (response.status === 401)
      return { ok: false, message: CUSTOM_API_MESSAGES.unauthorized };
    if (response.status === 403)
      return { ok: false, message: CUSTOM_API_MESSAGES.forbidden };
    if (response.status < 200 || response.status >= 300)
      refuse(response, built, stream);
    try {
      readJson(response);
    } catch (error) {
      if (error instanceof CustomApiResponseError)
        return { ok: false, message: error.message };
      throw error;
    }
    return { ok: true };
  }

  async function sync(
    context: ConnectionContext,
    request: SyncRequest,
    runtime: ConnectorRuntime,
  ): Promise<SyncResult> {
    const runRequest = `${request.mode}|${request.from}|${request.to}`;
    const decoded = decodeCursor(request.cursor);
    // A cursor of another run (a later window after a failed run) keeps
    // only the stream it stopped in: that stream starts again, from its
    // first chunk and page, with fresh limit counters.
    const fresh = (stream: number): CustomApiCursorV1 => ({
      v: 1,
      stream,
      chunk: 0,
      page: { type: "first" },
      refreshKey: "",
      pageIndex: 0,
      run: {
        pages: 0,
        records: 0,
        startedAt: new Date(now()).toISOString(),
        request: runRequest,
      },
    });
    let cursor: CustomApiCursorV1 =
      decoded === null || decoded.stream >= definition.streams.length
        ? fresh(0)
        : decoded.run.request !== runRequest
          ? fresh(decoded.stream)
          : decoded;

    const stream = definition.streams[cursor.stream]!;
    const chunks = streamChunks(stream, request, timeZone);
    if (cursor.chunk >= chunks.length)
      cursor = {
        ...cursor,
        chunk: 0,
        page: { type: "first" },
        refreshKey: "",
        pageIndex: 0,
      };
    // A windowed stream always has a chunk: the end date follows request.to.
    const chunk = chunks[cursor.chunk] ?? null;

    // Safety limits, before the request.
    if (cursor.run.pages >= CUSTOM_API_LIMITS.pagesPerRun)
      throw new CustomApiLimitError(CUSTOM_API_MESSAGES.pageLimit);
    if (cursor.run.records >= CUSTOM_API_LIMITS.recordsPerRun)
      throw new CustomApiLimitError(CUSTOM_API_MESSAGES.recordLimit);
    if (
      now() - Date.parse(cursor.run.startedAt) >=
      CUSTOM_API_LIMITS.runDurationMs
    )
      throw new CustomApiLimitError(CUSTOM_API_MESSAGES.durationLimit);

    const refreshKey =
      cursor.refreshKey ||
      sha256(stream.key, JSON.stringify(chunk), request.from, request.to);

    const built = build(context, stream, chunk, cursor.page);
    const response = await runtime.fetch(built.url, {
      headers: built.headers,
    });
    if (response.status < 200 || response.status >= 300)
      refuse(response, built, stream);
    const body = readJson(response);
    const raws = selectRecords(body, stream.records);
    const mapped = mapRecords(stream, raws, timeZone);
    const skippedFields = Object.entries(mapped.nulled);
    if (mapped.skipped > 0 || skippedFields.length > 0)
      runtime.log?.warn("records skipped", {
        stream: stream.key,
        skipped: mapped.skipped,
        ...Object.fromEntries(
          skippedFields
            .slice(0, 15)
            .map(([field, count]) => [`nulled.${field}`, count]),
        ),
      });

    let rows = mapped.rows;
    let window: DatasetPage["window"];
    if (stream.mode === "replace_window" && chunk) {
      const reporting = stream.fields.find(
        (f) => f.id === stream.reportingField,
      )!;
      if (reporting.type === "date") {
        const dates = chunkDates(chunk, timeZone);
        window = { from: dates.from, toExclusive: dates.to, partition: {} };
        rows = rows.filter((row) => {
          const value = row[reporting.id] as string;
          return value >= dates.from && value < dates.to;
        });
      } else {
        const instants = chunkInstants(chunk, timeZone);
        window = {
          from: new Date(instants.from).toISOString(),
          toExclusive: new Date(instants.to).toISOString(),
          partition: {},
        };
        rows = rows.filter((row) => {
          const ms = Date.parse(row[reporting.id] as string);
          return ms >= instants.from && ms < instants.to;
        });
      }
    }

    const next = nextPage({
      pagination: stream.pagination,
      state: cursor.page,
      body,
      linkHeader: response.headers.link,
      recordCount: raws.length,
      requestUrl: built.url,
      apiHost,
    });

    // Dataset pages of this response; the refresh's last one completes it.
    const groups = cutRows(rows);
    if (next === null && groups.length === 0) groups.push([]);
    if (groups.length > DATASET_LIMITS.datasets)
      throw new Error(
        `One API page of stream ${stream.key} holds more records than one sync step stores`,
      );
    const version = pin.datasetVersions[stream.key]!;
    let pageIndex = cursor.pageIndex;
    const datasetPages: DatasetPage[] = groups.map((group, index) => {
      const page: DatasetPage = {
        datasetKey: stream.key,
        schemaVersion: version,
        refreshKey,
        pageKey: `p${pageIndex}`,
        previousPageKey: pageIndex === 0 ? null : `p${pageIndex - 1}`,
        records: group.map((values) => ({ values })),
        complete: next === null && index === groups.length - 1,
        ...(window ? { window } : {}),
      };
      pageIndex += 1;
      return page;
    });

    const run = {
      ...cursor.run,
      pages: cursor.run.pages + 1,
      records: cursor.run.records + raws.length,
    };
    let following: CustomApiCursorV1 | null;
    if (next !== null)
      following = { ...cursor, page: next, refreshKey, pageIndex, run };
    else if (cursor.chunk + 1 < chunks.length)
      following = {
        ...cursor,
        chunk: cursor.chunk + 1,
        page: { type: "first" },
        refreshKey: "",
        pageIndex: 0,
        run,
      };
    else if (cursor.stream + 1 < definition.streams.length)
      following = {
        ...cursor,
        stream: cursor.stream + 1,
        chunk: 0,
        page: { type: "first" },
        refreshKey: "",
        pageIndex: 0,
        run,
      };
    else following = null;

    if (following)
      return {
        observations: [],
        datasetPages,
        nextCursor: encodeCursor(following),
        done: false,
      };
    const nextFrom = nextFromFor(definition, request);
    return {
      observations: [],
      datasetPages,
      receivedDatasets: definition.streams.map((s) => s.key),
      ...(nextFrom !== undefined ? { nextFrom } : {}),
      done: true,
    };
  }

  return {
    manifest,
    check,
    discover: async () => [],
    sync,
  };
}
