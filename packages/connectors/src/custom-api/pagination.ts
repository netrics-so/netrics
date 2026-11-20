// Pagination styles of a custom API stream: the parameters of a page and
// the decision whether (and where) another page follows. Stops on an empty
// page, a short page, a missing or repeated cursor and a missing or repeated
// next URL; a next URL on another host fails the run.

import {
  CUSTOM_API_LIMITS,
  parseDataPath,
  readDataPath,
  type CustomApiPagination,
} from "@netrics/connector-sdk/custom-api";

import { CustomApiResponseError } from "./errors.js";
import { CUSTOM_API_MESSAGES } from "./messages.js";

export type PageState =
  | { type: "first" }
  | { type: "page_number"; number: number }
  | { type: "offset"; offset: number }
  | { type: "cursor"; cursor: string }
  | { type: "next_url"; url: string };

export interface PageParams {
  params: Record<string, string>;
  placeholders: Record<string, string>;
  nextUrl?: string;
}

function pageNumberParams(
  p: Extract<CustomApiPagination, { type: "page_number" }>,
  number: number,
): PageParams {
  const params: Record<string, string> = { [p.param]: String(number) };
  const placeholders: Record<string, string> = {
    "page.number": String(number),
  };
  if (p.size !== undefined) {
    if (p.sizeParam !== undefined) params[p.sizeParam] = String(p.size);
    placeholders["page.size"] = String(p.size);
    placeholders["page.offset"] = String((number - p.start) * p.size);
  }
  return { params, placeholders };
}

function offsetParams(
  p: Extract<CustomApiPagination, { type: "offset" }>,
  offset: number,
): PageParams {
  return {
    params: {
      [p.offsetParam]: String(offset),
      [p.limitParam]: String(p.limit),
    },
    placeholders: {
      "page.offset": String(offset),
      "page.size": String(p.limit),
    },
  };
}

export function firstPageParams(p: CustomApiPagination): {
  params: Record<string, string>;
  placeholders: Record<string, string>;
} {
  switch (p.type) {
    case "page_number":
      return pageNumberParams(p, p.start);
    case "offset":
      return offsetParams(p, 0);
    case "cursor":
      // The first page has no cursor yet; a template that names it gets "".
      return { params: {}, placeholders: { "page.cursor": "" } };
    default:
      return { params: {}, placeholders: {} };
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
    return {
      params: { [p.param]: state.cursor },
      placeholders: { "page.cursor": state.cursor },
    };
  if (p.type === "next_url" && state.type === "next_url")
    return { params: {}, placeholders: {}, nextUrl: state.url };
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

function cursorValue(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
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
      if (state.type === "cursor" && state.cursor === cursor) return null;
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
