// Request bodies of custom API POST streams (ADR 0030, schema version 2): a
// fixed JSON template or a GraphQL query with variables. Pure helpers shared
// by the definition's rules, the builder's draft checks and the connector:
// the JSON template bound, the GraphQL read-only guard, the template's string
// leaves and body paths.

import { Kind, parse } from "graphql";

import { utf8ByteLength } from "../utf8.js";
import type { DataPathSegment } from "./path.js";
import { PlaceholderSyntaxError, parsePlaceholders } from "./placeholders.js";

/** A JSON value whose string leaves may hold `{{ placeholder }}` templates. */
export type CustomApiJsonValue =
  | null
  | boolean
  | number
  | string
  | CustomApiJsonValue[]
  | { [key: string]: CustomApiJsonValue };

export type CustomApiJsonBody = {
  kind: "json";
  value: CustomApiJsonValue;
  /**
   * The definition's author confirmed "this request only reads data"
   * (ADR 0030 §2). netrics cannot verify it; a version with a JSON body is
   * refused without it.
   */
  readOnlyConfirmed?: boolean | undefined;
};
export type CustomApiGraphqlBody = {
  kind: "graphql";
  /** A literal: no placeholder, nothing writes into it. */
  query: string;
  /** The operation's variables; `{}` when it has none. */
  variables: { [key: string]: CustomApiJsonValue };
};
export type CustomApiBody = CustomApiJsonBody | CustomApiGraphqlBody;

export const CUSTOM_API_BODY_LIMITS = {
  /** Compact JSON of a body template. */
  bytes: 65_536,
  /** Nesting of arrays and objects in a body template. */
  depth: 16,
  /** Values (leaves and containers) in a body template. */
  nodes: 5_000,
  /** One string leaf. */
  stringLength: 16_384,
  /** One object key. */
  keyLength: 200,
  /**
   * A body as sent: after placeholders and page values, before the fetch
   * and the redaction set (connection values may lengthen string leaves).
   */
  renderedBytes: 131_072,
  /** A GraphQL query document. */
  graphqlQueryLength: 32_768,
  /** Lexer tokens the GraphQL parser reads at most. */
  graphqlTokens: 10_000,
} as const;

/**
 * URL query parameters a GraphQL stream may never send: some servers let
 * them override the body's operation (ADR 0030 §2). Compared without case.
 */
export const CUSTOM_API_GRAPHQL_RESERVED_PARAMS = [
  "query",
  "operationName",
  "variables",
  "extensions",
] as const;
const GRAPHQL_RESERVED = new Set(
  CUSTOM_API_GRAPHQL_RESERVED_PARAMS.map((name) => name.toLowerCase()),
);

/** True when a URL query parameter name could override a GraphQL body. */
export function isCustomApiGraphqlReservedParam(name: string): boolean {
  return GRAPHQL_RESERVED.has(name.toLowerCase());
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isPlainJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether `value` is a JSON template within CUSTOM_API_BODY_LIMITS: plain
 * JSON values only (finite numbers, no undefined or class instances), no
 * reserved keys. Iterative, so a deeply nested input cannot exhaust the
 * stack before the depth check refuses it.
 */
export function isCustomApiJsonTemplate(
  value: unknown,
): value is CustomApiJsonValue {
  const stack: [unknown, number][] = [[value, 0]];
  let nodes = 0;
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (++nodes > CUSTOM_API_BODY_LIMITS.nodes) return false;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current === "string") {
      if (current.length > CUSTOM_API_BODY_LIMITS.stringLength) return false;
      continue;
    }
    if (depth >= CUSTOM_API_BODY_LIMITS.depth) return false;
    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        if (!Object.hasOwn(current, i)) return false;
        stack.push([current[i], depth + 1]);
      }
      continue;
    }
    if (!isPlainJsonObject(current)) return false;
    for (const key of Object.keys(current)) {
      if (UNSAFE_KEYS.has(key) || key.length > CUSTOM_API_BODY_LIMITS.keyLength)
        return false;
      stack.push([current[key], depth + 1]);
    }
  }
  return utf8ByteLength(JSON.stringify(value)) <= CUSTOM_API_BODY_LIMITS.bytes;
}

export type GraphqlOperationProblem =
  "syntax" | "not_query" | "several_definitions";

/**
 * The read-only guard (ADR 0030 §2): the document parses and is exactly one
 * definition, a `query` operation. A mutation, a subscription, a second
 * operation or a fragment definition is refused. Null when it holds. Never
 * echoes the query or the parser's message.
 */
export function customApiGraphqlProblem(
  query: string,
): GraphqlOperationProblem | null {
  if (query.length > CUSTOM_API_BODY_LIMITS.graphqlQueryLength) return "syntax";
  let document;
  try {
    document = parse(query, {
      noLocation: true,
      maxTokens: CUSTOM_API_BODY_LIMITS.graphqlTokens,
    });
  } catch {
    return "syntax";
  }
  if (document.definitions.length !== 1) return "several_definitions";
  const [definition] = document.definitions;
  if (
    definition?.kind !== Kind.OPERATION_DEFINITION ||
    definition.operation !== "query"
  )
    return "not_query";
  return null;
}

/** The value a body is sent from: a JSON template, or `{ query, variables }` for GraphQL. */
export function customApiBodyTemplate(body: CustomApiBody): CustomApiJsonValue {
  return body.kind === "json"
    ? body.value
    : { query: body.query, variables: body.variables };
}

export interface BodyStringLeaf {
  /** From the sent body's root (GraphQL: starts with "variables"). */
  path: (string | number)[];
  value: string;
}

/**
 * The string leaves placeholders may fill: every one of a JSON template,
 * only those under `variables` of a GraphQL body (the query is a literal).
 */
export function customApiBodyStringLeaves(
  body: CustomApiBody,
): BodyStringLeaf[] {
  const leaves: BodyStringLeaf[] = [];
  const stack: { value: unknown; path: (string | number)[] }[] =
    body.kind === "json"
      ? [{ value: body.value, path: [] }]
      : [{ value: body.variables, path: ["variables"] }];
  while (stack.length > 0) {
    const { value, path } = stack.pop()!;
    if (typeof value === "string") leaves.push({ path, value });
    else if (Array.isArray(value))
      value.forEach((item, index) =>
        stack.push({ value: item, path: [...path, index] }),
      );
    else if (isPlainJsonObject(value))
      for (const key of Object.keys(value))
        stack.push({ value: value[key], path: [...path, key] });
  }
  return leaves.reverse();
}

export type BodyPathProblem =
  "missing" | "not_leaf" | "outside_variables" | "omit_array_element";

/**
 * Whether a body path names an existing leaf of the template (ADR 0030 §3):
 * a GraphQL path stays under `variables`; `omit` needs an object property.
 */
export function customApiBodyPathProblem(
  body: CustomApiBody,
  segments: readonly DataPathSegment[],
  options: { omit?: boolean } = {},
): BodyPathProblem | null {
  if (
    body.kind === "graphql" &&
    (segments.length < 2 ||
      !("key" in segments[0]!) ||
      segments[0].key !== "variables")
  )
    return "outside_variables";
  let current: unknown = customApiBodyTemplate(body);
  for (const segment of segments) {
    if ("index" in segment) {
      if (!Array.isArray(current) || segment.index >= current.length)
        return "missing";
      current = current[segment.index];
    } else {
      if (!isPlainJsonObject(current) || !Object.hasOwn(current, segment.key))
        return "missing";
      current = current[segment.key];
    }
  }
  if (
    segments.length === 0 ||
    (current !== null && typeof current === "object")
  )
    return "not_leaf";
  if (options.omit && "index" in segments[segments.length - 1]!)
    return "omit_array_element";
  return null;
}

/** A page value a body path receives; `omit` removes the property. */
export type CustomApiBodyWrite = {
  path: readonly DataPathSegment[];
} & ({ value: string | number | null } | { omit: true });

/**
 * Renders a body: string leaves through `render` (placeholders), then each
 * write replaces its leaf (its value's JSON type is kept) or removes its
 * property. Writes go to template leaves only (checked with the
 * definition); one that does not land throws. Returns the JSON text.
 */
export function renderCustomApiBody(
  body: CustomApiBody,
  render: (template: string) => string,
  writes: readonly CustomApiBodyWrite[] = [],
): string {
  // Rendered strings are counted as they come, so a template that grows
  // with its values stops at the limit instead of being built whole.
  let rendered = 0;
  // Leaves a page value replaces or removes (ADR 0030 §3) are not
  // interpolated: their template is never sent, so it cannot fail a send.
  const key = (path: readonly (string | number)[]) => JSON.stringify(path);
  const written = new Set(
    writes.map((write) =>
      key(
        write.path.map((segment) =>
          "index" in segment ? segment.index : segment.key,
        ),
      ),
    ),
  );
  const clone = (
    value: CustomApiJsonValue,
    path: (string | number)[],
  ): CustomApiJsonValue => {
    if (typeof value === "string") {
      if (written.has(key(path))) return value;
      const text = render(value);
      rendered += utf8ByteLength(text);
      if (rendered > CUSTOM_API_BODY_LIMITS.renderedBytes) throw tooLarge();
      return text;
    }
    if (Array.isArray(value))
      return value.map((item, index) => clone(item, [...path, index]));
    if (value !== null && typeof value === "object") {
      const out: Record<string, CustomApiJsonValue> = Object.create(null);
      for (const name of Object.keys(value))
        out[name] = clone(value[name]!, [...path, name]);
      return out;
    }
    return value;
  };
  const root: CustomApiJsonValue =
    body.kind === "json"
      ? clone(body.value, [])
      : { query: body.query, variables: clone(body.variables, ["variables"]) };
  for (const write of writes) {
    if (customApiBodyPathProblem(body, write.path, { omit: "omit" in write }))
      throw new CustomApiBodyError(
        "A body path does not name a leaf of the body",
      );
    let parent: unknown = root;
    for (const segment of write.path.slice(0, -1))
      parent =
        "index" in segment
          ? (parent as CustomApiJsonValue[])[segment.index]
          : (parent as Record<string, CustomApiJsonValue>)[segment.key];
    const last = write.path[write.path.length - 1]!;
    if ("index" in last)
      (parent as CustomApiJsonValue[])[last.index] =
        "omit" in write ? null : write.value;
    else if ("omit" in write)
      delete (parent as Record<string, CustomApiJsonValue>)[last.key];
    else (parent as Record<string, CustomApiJsonValue>)[last.key] = write.value;
  }
  const text = JSON.stringify(root);
  if (utf8ByteLength(text) > CUSTOM_API_BODY_LIMITS.renderedBytes)
    throw tooLarge();
  return text;
}

const tooLarge = () =>
  new CustomApiBodyError(
    `The request body is larger than ${CUSTOM_API_BODY_LIMITS.renderedBytes / 1024} KiB once its values are filled in`,
  );

/** Placeholder names a template uses; none for one with a syntax error. */
export function customApiTemplateNames(template: string): string[] {
  try {
    return parsePlaceholders(template).map((ref) => ref.name);
  } catch (error) {
    if (error instanceof PlaceholderSyntaxError) return [];
    throw error;
  }
}

/** A body that cannot be sent as rendered. A fixed message, never a value. */
export class CustomApiBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomApiBodyError";
  }
}
