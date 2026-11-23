// Pagination styles of a custom API stream: the parameters of a page and
// the decision whether (and where) another page follows. Stops on an empty
// page, a short page, a missing or repeated cursor and a missing or repeated
// next URL; a next URL on another host fails the run. A POST stream may
// place page values in its body instead of URL parameters (ADR 0030 §3).

import {
  CUSTOM_API_LIMITS,
  parseDataPath,
  readDataPath,
  type CustomApiBodyWrite,
  type CustomApiPagination,
} from "@netrics/connector-sdk/custom-api";

import { CustomApiResponseError } from "./errors.js";
import { CUSTOM_API_MESSAGES } from "./messages.js";

/**
 * A cursor keeps the JSON type the response gave it (a number stays a
 * number) for a body path; a URL parameter or a template gets its text.
 */
export type CursorValue = string | number;

export type PageState =
  | { type: "first" }
  | { type: "page_number"; number: number }
  | { type: "offset"; offset: number }
  | { type: "cursor"; cursor: CursorValue }
  | { type: "next_url"; url: string };

export interface PageParams {
  params: Record<string, string>;
  placeholders: Record<string, string>;
  /** Page values written into the body (POST streams with body paths). */
  bodyWrites: CustomApiBodyWrite[];
  nextUrl?: string;
}

/**
 * URL parameters by name, without a prototype: a parameter named
 * `__proto__` (a valid name) stays an own entry, not the map's prototype.
 */
function paramMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

function pageNumberParams(
  p: Extract<CustomApiPagination, { type: "page_number" }>,
  number: number,
): PageParams {
  const params = paramMap();
  params[p.param] = String(number);
  const placeholders: Record<string, string> = {
    "page.number": String(number),
  };
  if (p.size !== undefined) {
    if (p.sizeParam !== undefined) params[p.sizeParam] = String(p.size);
    placeholders["page.size"] = String(p.size);
    placeholders["page.offset"] = String((number - p.start) * p.size);
  }
  return { params, placeholders, bodyWrites: [] };
}

function offsetParams(
  p: Extract<CustomApiPagination, { type: "offset" }>,
  offset: number,
): PageParams {
  const params = paramMap();
  const bodyWrites: CustomApiBodyWrite[] = [];
  if (p.offsetParam !== undefined) params[p.offsetParam] = String(offset);
  if (p.offsetBodyPath !== undefined)
    bodyWrites.push({ path: parseDataPath(p.offsetBodyPath), value: offset });
  if (p.limitParam !== undefined) params[p.limitParam] = String(p.limit);
  if (p.limitBodyPath !== undefined)
    bodyWrites.push({ path: parseDataPath(p.limitBodyPath), value: p.limit });
  return {
    params,
    placeholders: {
      "page.offset": String(offset),
      "page.size": String(p.limit),
    },
    bodyWrites,
  };
}

function cursorParams(
  p: Extract<CustomApiPagination, { type: "cursor" }>,
  cursor: CursorValue | null,
): PageParams {
  const params = paramMap();
  const bodyWrites: CustomApiBodyWrite[] = [];
  // The first page has no cursor yet: no URL parameter, and a template
  // that names it gets "". A body path sends JSON null or leaves the
  // property out; an empty string is never sent as a cursor.
  if (p.param !== undefined && cursor !== null)
    params[p.param] = String(cursor);
  if (p.bodyPath !== undefined) {
    const path = parseDataPath(p.bodyPath);
    bodyWrites.push(
      cursor !== null
        ? { path, value: cursor }
        : p.firstPage === "omit"
          ? { path, omit: true }
          : { path, value: null },
    );
  }
  return {
    params,
    placeholders: { "page.cursor": cursor === null ? "" : String(cursor) },
    bodyWrites,
  };
}

export function firstPageParams(p: CustomApiPagination): PageParams {
  switch (p.type) {
    case "page_number":
      return pageNumberParams(p, p.start);
    case "offset":
      return offsetParams(p, 0);
    case "cursor":
      return cursorParams(p, null);
    default:
      return { params: {}, placeholders: {}, bodyWrites: [] };
  }
}

export function pageParams(
  p: CustomApiPagination,
  state: PageState,
): PageParams {
  if (state.type === "first") return firstPageParams(p);
  if (p.type === "page_number" && state.type === "page_number")
    return pageNumberParams(p, state.number);
  if (p.type === "offset" && state.type === "offset")
    return offsetParams(p, state.offset);
  if (p.type === "cursor" && state.type === "cursor")
    return cursorParams(p, state.cursor);
  if (p.type === "next_url" && state.type === "next_url")
    return { params: {}, placeholders: {}, bodyWrites: [], nextUrl: state.url };
  // A stored state from another pagination type: start over.
  return firstPageParams(p);
}

/** The target of a `Link` header's rel="next", if any. */
export function linkHeaderNext(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /^\s*<([^>]*)>\s*;(.*)$/.exec(part);
    if (!match) continue;
    const rels = /(?:^|;)\s*rel\s*=\s*"?([^";]*)"?/i.exec(match[2]!);
    if (rels && rels[1]!.toLowerCase().split(/\s+/).includes("next"))
      return match[1];
  }
  return undefined;
}

/** A string or finite number as the response gave it; "" is no cursor. */
export function cursorValue(value: unknown): CursorValue | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/**
 * A repeated cursor ends the stream. A URL parameter sends a cursor's text,
 * so 5 and "5" are the same request there; a body path sends its JSON type,
 * so there they differ.
 */
function sameCursor(
  p: Extract<CustomApiPagination, { type: "cursor" }>,
  previous: CursorValue,
  next: CursorValue,
): boolean {
  return p.bodyPath !== undefined
    ? previous === next
    : String(previous) === String(next);
}

/** null = the stream is done. */
export function nextPage(input: {
  pagination: CustomApiPagination;
  state: PageState;
  body: unknown;
  linkHeader: string | undefined;
  recordCount: number;
  requestUrl: string;
  /** The environment's host (with a non-default port). */
  apiHost: string;
}): PageState | null {
  const { pagination: p, state, recordCount } = input;
  if (p.type === "none" || recordCount === 0) return null;
  switch (p.type) {
    case "page_number": {
      if (p.size !== undefined && recordCount < p.size) return null;
      const current = state.type === "page_number" ? state.number : p.start;
      return { type: "page_number", number: current + 1 };
    }
    case "offset": {
      if (recordCount < p.limit) return null;
      const current = state.type === "offset" ? state.offset : 0;
      return { type: "offset", offset: current + recordCount };
    }
    case "cursor": {
      const cursor = cursorValue(
        readDataPath(input.body, parseDataPath(p.cursorPath)),
      );
      if (cursor === undefined) return null;
      if (state.type === "cursor" && sameCursor(p, state.cursor, cursor))
        return null;
      return { type: "cursor", cursor };
    }
    case "next_url": {
      const raw =
        p.source === "body"
          ? readDataPath(input.body, parseDataPath(p.path))
          : linkHeaderNext(input.linkHeader);
      if (typeof raw !== "string" || raw === "") return null;
      if (raw.length > CUSTOM_API_LIMITS.nextUrlLength)
        throw new CustomApiResponseError(CUSTOM_API_MESSAGES.nextUrlOffHost);
      let url: URL;
      try {
        url = new URL(raw, input.requestUrl);
      } catch {
        throw new CustomApiResponseError(CUSTOM_API_MESSAGES.nextUrlOffHost);
      }
      const current = new URL(input.requestUrl);
      if (
        url.host !== input.apiHost ||
        url.protocol !== current.protocol ||
        url.username !== "" ||
        url.password !== ""
      )
        throw new CustomApiResponseError(CUSTOM_API_MESSAGES.nextUrlOffHost);
      url.hash = "";
      if (url.href === current.href) return null;
      return { type: "next_url", url: url.href };
    }
  }
}
