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
  CUSTOM_API_SKIPPED_LOG,
  skippedLogFields,
  type CustomApiDefinition,
  type CustomApiStream,
} from "@netrics/connector-sdk/custom-api";

import type { CustomApiCredentials } from "./credentials.js";
import {
  CUSTOM_API_SEEN_PAGES,
  decodeCursor,
  encodeCursor,
  type CustomApiCursorV1,
} from "./cursor.js";
import {
  CustomApiAuthError,
  CustomApiConfigError,
  CustomApiGraphqlError,
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
import {
  jsonTooDeep,
  mapRecords,
  selectRecords,
  skippedFieldPaths,
} from "./records.js";
import {
  buildRequest,
  redactRenderedBody,
  stripCustomApiSecrets,
  type BuiltRequest,
} from "./request.js";
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

/**
 * Sends a built request: a POST with its JSON body. An error of the fetch
 * (egress, timeout) never carries the rendered body (ADR 0030 §4).
 */
export async function sendCustomApiRequest(
  fetch: ConnectorRuntime["fetch"],
  built: BuiltRequest,
): Promise<ConnectorResponse> {
  try {
    return await fetch(
      built.url,
      built.method === "POST"
        ? { method: "POST", headers: built.headers, body: built.body! }
        : { headers: built.headers },
    );
  } catch (error) {
    if (error instanceof Error && built.body !== undefined)
      error.message = redactRenderedBody(error.message, built);
    throw error;
  }
}

const send = (runtime: ConnectorRuntime, built: BuiltRequest) =>
  sendCustomApiRequest((url, init) => runtime.fetch(url, init), built);

/**
 * A GraphQL stream's response with a non-empty top-level `errors` array
 * fails with CustomApiGraphqlError: stream, status and count only.
 */
export function checkGraphqlErrors(
  stream: Pick<CustomApiStream, "key" | "request">,
  status: number,
  body: unknown,
): void {
  if (stream.request.body?.kind !== "graphql") return;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return;
  const errors = Object.hasOwn(body, "errors")
    ? (body as { errors: unknown }).errors
    : undefined;
  if (Array.isArray(errors) && errors.length > 0)
    throw new CustomApiGraphqlError(stream.key, status, errors.length);
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
      bodyWrites: params.bodyWrites,
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
    // The host follows no redirect of a POST request (ADR 0030 §2): the
    // 3xx arrives here and fails the run.
    if (
      built.method === "POST" &&
      response.status >= 300 &&
      response.status < 400
    )
      throw new Error(
        `HTTP ${response.status} from ${built.redactedUrl} (${where}): a POST request follows no redirects`,
      );
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
    const response = await send(runtime, built);
    if (response.status === 401)
      return { ok: false, message: CUSTOM_API_MESSAGES.unauthorized };
    if (response.status === 403)
      return { ok: false, message: CUSTOM_API_MESSAGES.forbidden };
    if (response.status < 200 || response.status >= 300)
      refuse(response, built, stream);
    try {
      checkGraphqlErrors(stream, response.status, readJson(response));
    } catch (error) {
      if (
        error instanceof CustomApiResponseError ||
        error instanceof CustomApiGraphqlError
      )
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
    // A cursor of another run (a later window after a failed run) starts
    // over from the first stream with fresh counters: every stream reads
    // the new window, so the run never reports a stream done that it did
    // not read for this window. Re-reads are idempotent (keyed upserts,
    // refresh keys per window); snapshot streams simply refresh.
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
      decoded === null ||
      decoded.stream >= definition.streams.length ||
      decoded.run.request !== runRequest
        ? fresh(0)
        : decoded;

    const stream = definition.streams[cursor.stream]!;
    const chunks = streamChunks(stream, request, timeZone);
    if (cursor.chunk >= chunks.length) {
      const { seen: _stale, ...kept } = cursor;
      cursor = {
        ...kept,
        chunk: 0,
        page: { type: "first" },
        refreshKey: "",
        pageIndex: 0,
      };
    }
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
    const response = await send(runtime, built);
    if (response.status < 200 || response.status >= 300)
      refuse(response, built, stream);
    const body = readJson(response);
    checkGraphqlErrors(stream, response.status, body);
    const raws = selectRecords(body, stream.records);
    const mapped = mapRecords(stream, raws, timeZone);
    const nulledFields = Object.entries(mapped.nulled);
    if (mapped.skipped > 0 || nulledFields.length > 0) {
      // The host keeps the skipped records per stream by field path
      // (#834 review); nulled values stay for the operator's log.
      runtime.log?.warn(CUSTOM_API_SKIPPED_LOG, {
        stream: stream.key,
        ...skippedLogFields(
          mapped.skipped,
          skippedFieldPaths(stream.fields, mapped.skippedFields),
        ),
        ...Object.fromEntries(
          nulledFields
            .slice(0, 8)
            .map(([field, count]) => [`nulled.${field}`, count]),
        ),
      });
    }

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

    const found = nextPage({
      pagination: stream.pagination,
      state: cursor.page,
      body,
      linkHeader: response.headers.link,
      recordCount: raws.length,
      requestUrl: built.url,
      apiHost,
    });
    // The cursor is stored and shown to viewers: never with a secret in it.
    const strip = (url: string) =>
      stripCustomApiSecrets(
        url,
        definition,
        context.credentials as CustomApiCredentials,
        context.config,
        stream,
      );
    // A page by its URL without secrets and with sorted parameters: the
    // request carries the auth where buildRequest put it (a query key
    // last), the API's link may name it first or reorder the rest.
    const pageHash = (url: string) => {
      const normal = new URL(strip(url));
      normal.searchParams.sort();
      return sha256(normal.href).slice(0, 16);
    };
    const nextUrl = found?.type === "next_url" ? strip(found.url) : null;
    // Pages of this refresh read so far, this one included. A next link
    // back to one of them (the page itself, or A → B → A) ends the stream.
    const seen =
      found?.type === "next_url"
        ? [...(cursor.seen ?? []), pageHash(built.url)].slice(
            -CUSTOM_API_SEEN_PAGES,
          )
        : undefined;
    const next: PageState | null =
      found?.type === "next_url"
        ? seen!.includes(pageHash(found.url))
          ? null
          : { type: "next_url", url: nextUrl! }
        : found;

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
    // A new refresh (chunk or stream) starts without remembered pages.
    const { seen: _seen, ...rest } = cursor;
    if (next !== null)
      following = {
        ...rest,
        page: next,
        refreshKey,
        pageIndex,
        run,
        ...(seen ? { seen } : {}),
      };
    else if (cursor.chunk + 1 < chunks.length)
      following = {
        ...rest,
        chunk: cursor.chunk + 1,
        page: { type: "first" },
        refreshKey: "",
        pageIndex: 0,
        run,
      };
    else if (cursor.stream + 1 < definition.streams.length)
      following = {
        ...rest,
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
