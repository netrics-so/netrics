// The test request of the custom API builder (milestone 13, #806): one
// stream of an unsaved definition, read page by page with the connector's
// own request, pagination and mapping functions, within small bounds
// (pages, records, total time). Reports a trace per page. Pure apart from
// `fetch`; the host passes its egress-guarded fetch.

import type { ConnectorRuntime } from "@netrics/connector-sdk";
import {
  readDataPath,
  type CustomApiDefinition,
  type CustomApiField,
  type CustomApiStream,
} from "@netrics/connector-sdk/custom-api";

import type { CustomApiCredentials } from "../credentials.js";
import {
  CustomApiAuthError,
  CustomApiGraphqlError,
  CustomApiResponseError,
} from "../errors.js";
import { customApiEnvironment, customApiEnvironmentHost } from "../manifest.js";
import { CUSTOM_API_MESSAGES } from "../messages.js";
import { nextPage, pageParams, type PageState } from "../pagination.js";
import {
  fieldPath,
  jsonTooDeep,
  mapRecords,
  selectRecords,
} from "../records.js";
import { buildRequest, type BuiltRequest } from "../request.js";
import {
  checkGraphqlErrors,
  graphqlErrorCount,
  sendCustomApiRequest,
} from "../connector.js";
import { windowPlaceholders, type Chunk } from "../windows.js";
import { hiddenOnPath, type HiddenValue } from "./suggest.js";

export interface CustomApiPageTrace {
  page: number;
  method: "GET" | "POST";
  /** BuiltRequest.redactedUrl. */
  url: string;
  status: number | null;
  durationMs: number;
  bytes: number;
  /** Page 1 only: parsed JSON, or the text when the body is not JSON. Null without a response and on later pages. */
  body: unknown;
  contentType: string | null;
  records: number | null;
}

/** A non-2xx answer other than 401/403; the trace holds its body. */
export class CustomApiHttpError extends Error {
  constructor(
    readonly status: number,
    method: "GET" | "POST" = "GET",
  ) {
    super(
      method === "POST" && status >= 300 && status < 400
        ? `The API answered HTTP ${status}, a redirect. A POST request follows no redirects.`
        : `The API answered HTTP ${status}.`,
    );
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

/**
 * Sets each cell whose source path reaches into, or is, a hidden value of
 * its record to that value's replacement; with `all`, every cell (the
 * records themselves lie in a hidden value). Reads only along the paths.
 * Each object or array of the page is asked once (#932): fields under the
 * same value (100 under an echoed `request`) share one comparison.
 */
function hideCells(
  rows: Record<string, unknown>[],
  raws: readonly unknown[],
  all: string | undefined,
  fields: readonly CustomApiField[],
  ask: HiddenValue,
): void {
  const seen = new Map<object, string | undefined>();
  const hidden = (value: unknown): string | undefined => {
    if (value === null || typeof value !== "object") return ask(value);
    if (seen.has(value)) return seen.get(value);
    const shown = ask(value);
    seen.set(value, shown);
    return shown;
  };
  rows.forEach((row, index) => {
    for (const field of fields) {
      if (all !== undefined) {
        row[field.id] = all;
        continue;
      }
      let value = raws[index];
      let shown = hidden(value);
      for (const segment of fieldPath(field)) {
        if (shown !== undefined || value === undefined) break;
        value = readDataPath(value, [segment]);
        shown = hidden(value);
      }
      if (shown !== undefined) row[field.id] = shown;
    }
  });
}

export async function runCustomApiTestStream(input: {
  definition: Pick<
    CustomApiDefinition,
    "auth" | "variables" | "environments" | "defaults"
  >;
  stream: Pick<
    CustomApiStream,
    "key" | "request" | "pagination" | "records" | "window"
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
  /**
   * The `window.*` values the host resolved from `chunk` (and, for a
   * JSON body, confirmed): sent as given instead of computed again, so
   * what was confirmed is what is sent.
   */
  windowValues?: Readonly<Record<string, string>>;
  onPage?: (trace: CustomApiPageTrace) => void;
  /**
   * Each request just before it is sent, rendered body included: for the
   * host's redaction set, never for the public trace (ADR 0030 §4).
   */
  onSend?: (built: BuiltRequest) => void;
  /**
   * Values of a response the host does not show (a request body sent and
   * echoed as JSON, #885): a mapped cell read from one, or from inside
   * one, is set to what this returns. Asked after `onSend`, so it knows
   * the body of the request the page answers.
   */
  hidden?: HiddenValue;
  /** Clock (ms) for the deadline; tests pin it. */
  now?: () => number;
}): Promise<CustomApiTestStreamResult> {
  const { definition, stream, limits } = input;
  const now = input.now ?? Date.now;
  const timeZone = definition.defaults.timeZone;
  const environment = customApiEnvironment(definition, input.environmentId);
  const apiHost = customApiEnvironmentHost(environment);
  const window =
    input.windowValues ??
    (stream.window.type !== "none" && input.chunk
      ? windowPlaceholders(stream.window, input.chunk, timeZone)
      : {});
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
      bodyWrites: params.bodyWrites,
      ...(params.nextUrl !== undefined ? { nextUrl: params.nextUrl } : {}),
    });
    const started = now();
    const trace: CustomApiPageTrace = {
      page,
      method: built.method,
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
      input.onSend?.(built);
      response = await sendCustomApiRequest(input.fetch, built);
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
    // Only the first page's body is shown; later pages keep their
    // metadata, so a test never holds every page in memory.
    trace.body = page === 1 ? body.value : null;
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
      // A GraphQL error envelope: graphql_errors, as on a 2xx (not for a
      // redirect or a rate limit).
      const count =
        (response.status < 300 || response.status >= 400) &&
        response.status !== 429 &&
        body.json
          ? graphqlErrorCount(stream, body.value)
          : 0;
      if (count > 0)
        throw new CustomApiGraphqlError(stream.key, response.status, count);
      throw new CustomApiHttpError(response.status, built.method);
    }
    if (!body.json) {
      input.onPage?.(trace);
      throw new CustomApiResponseError(CUSTOM_API_MESSAGES.notJson);
    }
    let selected: unknown[];
    try {
      checkGraphqlErrors(stream, response.status, body.value);
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
    if (input.hidden)
      hideCells(
        mapped.rows,
        mapped.sources.map((index) => taken[index]),
        hiddenOnPath(body.value, stream.records, input.hidden),
        stream.fields,
        input.hidden,
      );
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
