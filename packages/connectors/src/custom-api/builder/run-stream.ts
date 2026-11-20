// The test request of the custom API builder (milestone 13, #806): one
// stream of an unsaved definition, read page by page with the connector's
// own request, pagination and mapping functions, within small bounds
// (pages, records, total time). Reports a trace per page. Pure apart from
// `fetch`; the host passes its egress-guarded fetch.

import type { ConnectorRuntime } from "@netrics/connector-sdk";
import type {
  CustomApiDefinition,
  CustomApiStream,
} from "@netrics/connector-sdk/custom-api";

import type { CustomApiCredentials } from "../credentials.js";
import { CustomApiAuthError, CustomApiResponseError } from "../errors.js";
import { customApiEnvironment, customApiEnvironmentHost } from "../manifest.js";
import { CUSTOM_API_MESSAGES } from "../messages.js";
import { nextPage, pageParams, type PageState } from "../pagination.js";
import { jsonTooDeep, mapRecords, selectRecords } from "../records.js";
import { buildRequest } from "../request.js";
import { windowPlaceholders, type Chunk } from "../windows.js";

export interface CustomApiPageTrace {
  page: number;
  method: "GET";
  /** BuiltRequest.redactedUrl. */
  url: string;
  status: number | null;
  durationMs: number;
  bytes: number;
  /** Parsed JSON, or the text when the body is not JSON; null without a response. */
  body: unknown;
  contentType: string | null;
  records: number | null;
}

/** A non-2xx answer other than 401/403; the trace holds its body. */
export class CustomApiHttpError extends Error {
  constructor(readonly status: number) {
    super(`The API answered HTTP ${status}.`);
    this.name = "CustomApiHttpError";
  }
}

export type CustomApiTestStop =
  "end" | "page_limit" | "record_limit" | "duration";

export interface CustomApiTestStreamResult {
  rows: Record<string, unknown>[];
  skipped: number;
  nulled: Record<string, number>;
  stopped: CustomApiTestStop;
}

function parseBody(text: string): { json: boolean; value: unknown } {
  if (jsonTooDeep(text)) return { json: false, value: text };
  try {
    return { json: true, value: JSON.parse(text) as unknown };
  } catch {
    return { json: false, value: text };
  }
}

export async function runCustomApiTestStream(input: {
  definition: Pick<
    CustomApiDefinition,
    "auth" | "variables" | "environments" | "defaults"
  >;
  stream: Pick<
    CustomApiStream,
    "request" | "pagination" | "records" | "window"
  > &
    Pick<Partial<CustomApiStream>, "keyFields"> & {
      fields: CustomApiStream["fields"];
    };
  environmentId: string;
  config: Record<string, string>;
  credentials: CustomApiCredentials;
  fetch: ConnectorRuntime["fetch"];
  /** C-G3 windows.ts; the server computes the default chunk. */
  chunk: Chunk | null;
  limits: { maxPages: number; maxRecords: number; deadline: number };
  onPage?: (trace: CustomApiPageTrace) => void;
  /** Clock (ms) for the deadline; tests pin it. */
  now?: () => number;
}): Promise<CustomApiTestStreamResult> {
  const { definition, stream, limits } = input;
  const now = input.now ?? Date.now;
  const timeZone = definition.defaults.timeZone;
  const environment = customApiEnvironment(definition, input.environmentId);
  const apiHost = customApiEnvironmentHost(environment);
  const window =
    stream.window.type !== "none" && input.chunk
      ? windowPlaceholders(stream.window, input.chunk, timeZone)
      : {};
  const mapping = { fields: stream.fields, keyFields: stream.keyFields ?? [] };
  const rows: Record<string, unknown>[] = [];
  const nulled: Record<string, number> = {};
  let skipped = 0;
  let records = 0;
  let state: PageState = { type: "first" };

  for (let page = 1; ; page++) {
    if (page > 1 && now() >= limits.deadline)
      return { rows, skipped, nulled, stopped: "duration" };
    const params = pageParams(stream.pagination, state);
    const built = buildRequest({
      definition,
      stream,
      environment,
      config: input.config,
      credentials: input.credentials,
      placeholders: { ...window, ...params.placeholders },
      pageParams: params.params,
      ...(params.nextUrl !== undefined ? { nextUrl: params.nextUrl } : {}),
    });
    const started = now();
    const trace: CustomApiPageTrace = {
      page,
      method: "GET",
      url: built.redactedUrl,
      status: null,
      durationMs: 0,
      bytes: 0,
      body: null,
      contentType: null,
      records: null,
    };
    let response: Awaited<ReturnType<ConnectorRuntime["fetch"]>>;
    try {
      response = await input.fetch(built.url, { headers: built.headers });
    } catch (error) {
      trace.durationMs = Math.max(0, Math.round(now() - started));
      input.onPage?.(trace);
      throw error;
    }
    const text = response.text();
    const body = parseBody(text);
    trace.status = response.status;
    trace.durationMs = Math.max(0, Math.round(now() - started));
    trace.bytes = Buffer.byteLength(text, "utf8");
    trace.body = body.value;
    trace.contentType = response.headers["content-type"] ?? null;

    if (response.status === 401 || response.status === 403) {
      input.onPage?.(trace);
      throw new CustomApiAuthError(
        response.status === 401
          ? CUSTOM_API_MESSAGES.unauthorized
          : CUSTOM_API_MESSAGES.forbidden,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      input.onPage?.(trace);
      throw new CustomApiHttpError(response.status);
    }
    if (!body.json) {
      input.onPage?.(trace);
      throw new CustomApiResponseError(CUSTOM_API_MESSAGES.notJson);
    }
    let selected: unknown[];
    try {
      selected = selectRecords(body.value, stream.records);
    } catch (error) {
      input.onPage?.(trace);
      throw error;
    }
    trace.records = selected.length;
    input.onPage?.(trace);

    const room = limits.maxRecords - records;
    const taken = selected.slice(0, room);
    records += taken.length;
    const mapped = mapRecords(mapping, taken, timeZone);
    rows.push(...mapped.rows);
    skipped += mapped.skipped;
    for (const [id, n] of Object.entries(mapped.nulled))
      nulled[id] = (nulled[id] ?? 0) + n;
    const next = nextPage({
      pagination: stream.pagination,
      state,
      body: body.value,
      linkHeader: response.headers.link,
      recordCount: selected.length,
      requestUrl: built.url,
      apiHost,
    });
    if (
      selected.length > room ||
      (records >= limits.maxRecords && next !== null)
    )
      return { rows, skipped, nulled, stopped: "record_limit" };
    if (next === null) return { rows, skipped, nulled, stopped: "end" };
    if (page >= limits.maxPages)
      return { rows, skipped, nulled, stopped: "page_limit" };
    state = next;
  }
}
