// The custom API builder's state (milestone 13, #807): what the six steps
// edit, and the pure conversions between it and the definition document.
// The builder never holds a secret value here: secrets are sent to the
// draft connection once and only their names come back (`secretsSet`).

import {
  CUSTOM_API_CREDENTIAL_NAMES,
  CUSTOM_API_FORBIDDEN_HEADERS,
  CUSTOM_API_LIMITS,
  CUSTOM_API_SCHEMA_VERSION,
  checkCustomApiStreamRequest,
  customApiAuthSchema,
  customApiBodySchema,
  customApiBodyStringLeaves,
  customApiDefinitionSchema,
  customApiGraphqlProblem,
  customApiEnvironmentSchema,
  customApiIssues,
  customApiPagePlaceholders,
  customApiPaginationSchema,
  customApiStreamSchema,
  customApiWindowSchema,
  formatDataPath,
  PAGE_PLACEHOLDERS,
  parseDataPath,
  parsePlaceholders,
  readDataPath,
  WINDOW_PLACEHOLDERS,
  type CustomApiAuth,
  type CustomApiBody,
  type CustomApiDefinition,
  type CustomApiDraftDefinition,
  type CustomApiField,
  type CustomApiFieldSuggestion,
  type CustomApiImages,
  type CustomApiIssueCode,
  type DataPathSegment,
  type CustomApiPagination,
  type CustomApiStream,
  type CustomApiTestResponse,
  type CustomApiWindow,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

export type BuilderStep =
  "basics" | "login" | "request" | "response" | "paging" | "review";

export const BUILDER_STEPS: readonly BuilderStep[] = [
  "basics",
  "login",
  "request",
  "response",
  "paging",
  "review",
];

export interface KeyValue {
  key: string;
  value: string;
}

export interface BuilderVariable {
  id: string;
  label: string;
  secret: boolean;
  /** The value for test requests; always "" for secret variables. */
  value: string;
}

export type StreamMode = CustomApiStream["mode"];
export type RequestMethod = "GET" | "POST";
export type BodyKind = CustomApiBody["kind"];

/**
 * A POST stream's body as typed (ADR 0030): the JSON body, or the GraphQL
 * query and its variables. Both kinds are kept while the author switches
 * between them; only the chosen one is sent. A GET stream keeps them too
 * (hidden, never sent), so switching back to POST restores them.
 */
export interface BodyEditor {
  kind: BodyKind;
  /** The JSON body, as JSON text. */
  json: string;
  /** The GraphQL query, sent as written. */
  query: string;
  /** The GraphQL variables, as JSON text of an object. */
  variables: string;
}

export const EMPTY_BODY: BodyEditor = {
  kind: "json",
  json: "{}",
  query: "",
  variables: "{}",
};
export type FieldType = CustomApiField["type"];

export interface BuilderState {
  name: string;
  projectId: string | null;
  environments: { id: string; name: string; baseUrl: string }[];
  environmentId: string;
  auth: CustomApiAuth;
  /** Names of secrets stored on the draft, never their values. */
  secretsSet: string[];
  variables: BuilderVariable[];
  stream: {
    key: string;
    name: string;
    /** GET, or POST with `body` (ADR 0030). */
    method: RequestMethod;
    body: BodyEditor;
    path: string;
    query: KeyValue[];
    headers: KeyValue[];
    records: string | null;
    fields: CustomApiField[];
    keyFields: string[];
    mode: StreamMode;
    reportingField: string | null;
    pagination: CustomApiPagination;
    window: CustomApiWindow;
  };
  defaults: { refreshMinutes: number; timeZone: string };
  /**
   * The hosts images may be copied from (#834); null: only the
   * environment host, as a definition without an `images` block.
   */
  images: CustomApiImages | null;
  lastTest: CustomApiTestResponse | null;
  /**
   * "This request only reads data" (ADR 0030 §2), per JSON-body stream
   * key: the fingerprint of the exact request its author confirmed (or the
   * loaded version carried). It counts only while the request is the same;
   * any request-shaping change drops it (withReadOnlyChecked), and
   * changing it back does not bring it back.
   */
  readOnly: Record<string, string>;
  /** The user picked the key or time field: no more automatic defaults. */
  keyChosen: boolean;
  /**
   * Fields whose "may be empty" the user set by hand, or that a saved
   * definition set: never changed automatically (#834 review).
   */
  nullableChosen: string[];
}

/** The window a request gets when it first uses `{{window.start}}`/`{{window.end}}`. */
export const DEFAULT_WINDOW: CustomApiWindow = {
  type: "date",
  stepDays: 7,
  lookbackDays: 0,
  backfillDays: 30,
  paramFormat: "date",
  endInclusive: false,
};

const ENVIRONMENT_NAME: Record<Locale, string> = {
  en: "Production",
  de: "Produktion",
};
const STREAM_NAME: Record<Locale, string> = { en: "Records", de: "Einträge" };

export function emptyBuilderState(
  locale: Locale,
  timeZone: string,
): BuilderState {
  return {
    name: "",
    projectId: null,
    environments: [
      { id: "production", name: ENVIRONMENT_NAME[locale], baseUrl: "" },
    ],
    environmentId: "production",
    auth: { type: "none" },
    secretsSet: [],
    variables: [],
    stream: {
      key: "records",
      name: STREAM_NAME[locale],
      method: "GET",
      body: { ...EMPTY_BODY },
      path: "",
      query: [],
      headers: [],
      records: null,
      fields: [],
      keyFields: [],
      mode: "upsert",
      reportingField: null,
      pagination: { type: "none" },
      window: { type: "none" },
    },
    defaults: {
      refreshMinutes: CUSTOM_API_LIMITS.refreshMinutesDefault,
      timeZone,
    },
    images: null,
    lastTest: null,
    readOnly: {},
    keyChosen: false,
    nullableChosen: [],
  };
}

/** A saved body in the editor: JSON indented, the other kind empty. */
export function bodyEditorOf(body: CustomApiBody | undefined): BodyEditor {
  if (!body) return { ...EMPTY_BODY };
  return body.kind === "json"
    ? { ...EMPTY_BODY, kind: "json", json: JSON.stringify(body.value, null, 2) }
    : {
        ...EMPTY_BODY,
        kind: "graphql",
        query: body.query,
        variables: JSON.stringify(body.variables, null, 2),
      };
}

const rows = (record: Readonly<Record<string, string>>): KeyValue[] =>
  Object.entries(record).map(([key, value]) => ({ key, value }));

/** Rows with a name, later duplicates winning (as the browser would type them). */
function recordOf(entries: readonly KeyValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of entries) {
    const name = key.trim();
    if (name) out[name] = value;
  }
  return out;
}

/** The builder state of one stream (default: the first) of a saved definition. */
export function stateFromDefinition(
  definition: CustomApiDefinition,
  streamKey?: string,
): BuilderState {
  const stream =
    definition.streams.find((entry) => entry.key === streamKey) ??
    definition.streams[0]!;
  return {
    name: definition.name,
    projectId: null,
    environments: definition.environments.map((e) => ({ ...e })),
    environmentId: definition.environments[0]!.id,
    auth: definition.auth,
    secretsSet: [],
    variables: definition.variables.map((v) => ({ ...v, value: "" })),
    stream: {
      key: stream.key,
      name: stream.name,
      method: stream.request.method === "POST" ? "POST" : "GET",
      body: bodyEditorOf(stream.request.body),
      path: stream.request.path,
      query: rows(stream.request.query),
      headers: rows(stream.request.headers),
      records: stream.records,
      fields: stream.fields.map((field) => ({ ...field })),
      keyFields: [...stream.keyFields],
      mode: stream.mode,
      reportingField: stream.reportingField ?? null,
      pagination: stream.pagination,
      window: stream.window,
    },
    defaults: { ...definition.defaults },
    images: definition.images
      ? { ...definition.images, hosts: [...definition.images.hosts] }
      : null,
    lastTest: null,
    readOnly: confirmedOf(definition),
    keyChosen: true,
    nullableChosen: stream.fields.map((field) => field.id),
  };
}

/** The fingerprints of the JSON-body streams a saved definition confirmed. */
function confirmedOf(definition: CustomApiDefinition): Record<string, string> {
  const scope = scopeOfDefinition(definition);
  const out: Record<string, string> = {};
  for (const stream of definition.streams) {
    const body = stream.request.body;
    if (body?.kind !== "json" || body.readOnlyConfirmed !== true) continue;
    const fingerprint = readOnlyFingerprint(scope, stream);
    if (fingerprint !== null) out[stream.key] = fingerprint;
  }
  return out;
}

function environmentsOf(state: BuilderState) {
  return state.environments.map((e) => ({
    id: e.id,
    name: e.name.trim() || e.id,
    baseUrl: e.baseUrl.trim(),
  }));
}

function variablesOf(state: BuilderState) {
  return state.variables
    .filter((v) => v.id !== "")
    .map((v) => ({
      id: v.id,
      label: v.label.trim() || v.id,
      secret: v.secret,
    }));
}

/** What is wrong with the typed body, by editor field ({} when it is fine). */
export interface BodyProblems {
  json?: "syntax" | "limits";
  query?: "empty" | "limits";
  variables?: "syntax" | "object" | "limits";
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * The body the editor sends, or null with the problems that keep it from
 * being one. The limits are the SDK's body schema, not a copy of them.
 */
export function bodyOf(editor: BodyEditor): {
  body: CustomApiBody | null;
  problems: BodyProblems;
} {
  if (editor.kind === "json") {
    const parsed = parseJson(editor.json);
    if (!parsed.ok) return { body: null, problems: { json: "syntax" } };
    const body = customApiBodySchema.safeParse({
      kind: "json",
      value: parsed.value,
    });
    return body.success
      ? { body: body.data, problems: {} }
      : { body: null, problems: { json: "limits" } };
  }
  const problems: BodyProblems = {};
  if (editor.query.trim() === "") problems.query = "empty";
  const parsed = parseJson(editor.variables);
  if (!parsed.ok) problems.variables = "syntax";
  else if (
    parsed.value === null ||
    typeof parsed.value !== "object" ||
    Array.isArray(parsed.value)
  )
    problems.variables = "object";
  if (!parsed.ok || Object.keys(problems).length > 0)
    return { body: null, problems };
  const body = customApiBodySchema.safeParse({
    kind: "graphql",
    query: editor.query,
    variables: parsed.value,
  });
  if (body.success) return { body: body.data, problems: {} };
  const queryTooLong = body.error.issues.some((i) => i.path[0] === "query");
  return {
    body: null,
    problems: queryTooLong ? { query: "limits" } : { variables: "limits" },
  };
}

/** The problems of a POST stream's typed body; {} for a GET stream. */
export function bodyProblems(state: BuilderState): BodyProblems {
  return state.stream.method === "POST"
    ? bodyOf(state.stream.body).problems
    : {};
}

function requestOf(state: BuilderState): CustomApiStream["request"] {
  const base = {
    path: state.stream.path.trim() || "/",
    query: recordOf(state.stream.query),
    headers: recordOf(state.stream.headers),
  };
  if (state.stream.method !== "POST") return base;
  // A body that doesn't parse is left out: the request checks say so, and
  // a draft test is not sent (draftReady).
  const { body } = bodyOf(state.stream.body);
  return { method: "POST", ...base, ...(body ? { body } : {}) };
}

/** JSON with object keys sorted: equal values compare equal in any order. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, (entry as Record<string, unknown>)[key]]),
        )
      : entry,
  );
}

// ------------------------------------------------------- read-only (ADR 0030)

/** What a stream's request reads from the rest of the definition. */
interface RequestScope {
  environments: readonly { id: string; baseUrl: string }[];
  auth: CustomApiAuth;
  variables: readonly { id: string; secret: boolean }[];
}

type RequestStream = Pick<
  CustomApiStream,
  "key" | "request" | "pagination" | "window"
>;

function scopeOfDefinition(definition: CustomApiDefinition): RequestScope {
  return {
    environments: definition.environments,
    auth: definition.auth,
    variables: definition.variables,
  };
}

function scopeOf(state: BuilderState): RequestScope {
  return {
    environments: environmentsOf(state),
    auth: state.auth,
    variables: variablesOf(state),
  };
}

/**
 * The fingerprint of everything that shapes a JSON-body POST request (ADR
 * 0030 §2), for its saved "only reads data" confirmation: every
 * environment's base URL, the method, path, query parameters, header
 * templates, body template, pagination and window, the login's settings
 * (type and placement; the state never holds a credential) and the
 * connection values the request uses. Null for any other request: GET or
 * GraphQL needs no confirmation.
 */
export function readOnlyFingerprint(
  scope: RequestScope,
  stream: Pick<CustomApiStream, "request" | "pagination" | "window">,
): string | null {
  const { request } = stream;
  const body = request.body;
  if (request.method !== "POST" || body?.kind !== "json") return null;
  const templates = [
    request.path,
    ...Object.values(request.query),
    ...Object.values(request.headers),
    ...Object.values(scope.auth.headers ?? {}),
    ...customApiBodyStringLeaves(body).map((leaf) => leaf.value),
  ];
  const used = new Set(templates.flatMap((t) => placeholderNames(t) ?? []));
  return sortedJson({
    baseUrls: scope.environments.map((e) => [e.id, e.baseUrl]),
    auth: scope.auth,
    variables: scope.variables
      .filter((v) => used.has(v.id))
      .map((v) => [v.id, v.secret]),
    method: request.method,
    path: request.path,
    query: request.query,
    headers: request.headers,
    body: body.value,
    pagination: stream.pagination,
    window: stream.window,
  });
}

function withoutConfirmation<T extends RequestStream>(stream: T): T {
  const body = stream.request.body;
  if (body?.kind !== "json" || body.readOnlyConfirmed === undefined)
    return stream;
  const { readOnlyConfirmed: _dropped, ...rest } = body;
  return { ...stream, request: { ...stream.request, body: rest } };
}

/** The edited stream as the request sends it (no confirmation yet). */
function editedStream(
  state: BuilderState,
  previous: CustomApiStream | undefined,
): CustomApiStream {
  return {
    key: state.stream.key,
    name: state.stream.name,
    request: requestOf(state),
    pagination: state.stream.pagination,
    records: state.stream.records ?? "",
    fields: state.stream.fields,
    keyFields: state.stream.keyFields,
    mode: state.stream.mode,
    ...(state.stream.reportingField
      ? { reportingField: state.stream.reportingField }
      : {}),
    window: state.stream.window,
    retentionDays: previous?.retentionDays ?? null,
  };
}

/** Every stream the save sends, unconfirmed: the edited one and the others of `original`. */
function streamsOf(
  state: BuilderState,
  original: CustomApiDefinition | undefined,
): CustomApiStream[] {
  const previous = original?.streams.find((s) => s.key === state.stream.key);
  const edited = editedStream(state, previous);
  const streams = original
    ? previous
      ? original.streams.map((s) => (s.key === edited.key ? edited : s))
      : [...original.streams, edited]
    : [edited];
  return streams.map(withoutConfirmation);
}

/** The stream with its confirmation when the state holds one for exactly this request. */
function confirmed(
  stream: CustomApiStream,
  scope: RequestScope,
  readOnly: Readonly<Record<string, string>>,
): CustomApiStream {
  const fingerprint = readOnlyFingerprint(scope, stream);
  const body = stream.request.body;
  if (
    fingerprint === null ||
    body?.kind !== "json" ||
    readOnly[stream.key] !== fingerprint
  )
    return stream;
  return {
    ...stream,
    request: { ...stream.request, body: { ...body, readOnlyConfirmed: true } },
  };
}

/**
 * Drops every read-only confirmation whose request changed (ADR 0030 §2):
 * a base URL, the login settings, a connection value the request uses, or
 * the stream's method, path, query, headers, body, pagination or window.
 * Applied after every edit, so a confirmation never comes back by
 * changing a setting back.
 */
export function withReadOnlyChecked(
  state: BuilderState,
  original?: CustomApiDefinition,
): BuilderState {
  const keys = Object.keys(state.readOnly);
  if (keys.length === 0) return state;
  const scope = scopeOf(state);
  const streams = new Map(streamsOf(state, original).map((s) => [s.key, s]));
  const next: Record<string, string> = {};
  for (const key of keys) {
    const stream = streams.get(key);
    const fingerprint = stream ? readOnlyFingerprint(scope, stream) : null;
    if (fingerprint !== null && fingerprint === state.readOnly[key])
      next[key] = fingerprint;
  }
  return Object.keys(next).length === keys.length
    ? state
    : { ...state, readOnly: next };
}

/** The author confirms (or takes back) that a stream's exact request only reads data. */
export function confirmReadOnly(
  state: BuilderState,
  streamKey: string,
  on: boolean,
  original?: CustomApiDefinition,
): BuilderState {
  const { [streamKey]: _old, ...rest } = state.readOnly;
  if (!on) return { ...state, readOnly: rest };
  const stream = streamsOf(state, original).find((s) => s.key === streamKey);
  const fingerprint = stream
    ? readOnlyFingerprint(scopeOf(state), stream)
    : null;
  return fingerprint === null
    ? { ...state, readOnly: rest }
    : { ...state, readOnly: { ...rest, [streamKey]: fingerprint } };
}

/** A JSON-body stream the save asks about, with the request it would save. */
export interface ReadOnlyRequest {
  stream: CustomApiStream;
  confirmed: boolean;
}

/** Every JSON-body POST stream of the document the save sends (ADR 0030 §2). */
export function readOnlyRequests(
  state: BuilderState,
  original?: CustomApiDefinition,
): ReadOnlyRequest[] {
  const scope = scopeOf(state);
  return streamsOf(state, original)
    .filter((s) => readOnlyFingerprint(scope, s) !== null)
    .map((s) => {
      const stream = confirmed(s, scope, state.readOnly);
      const body = stream.request.body;
      return {
        stream,
        confirmed: body?.kind === "json" && body.readOnlyConfirmed === true,
      };
    });
}

/**
 * What a draft test's read-only challenge was asked for (ADR 0030 §2): the
 * request as the server hashes it, with the test environment and the test
 * values. A pending challenge holds only while this is unchanged.
 */
export function draftTestFingerprint(state: BuilderState): string {
  const draft = draftDefinitionOf(state);
  return sortedJson({
    environments: draft.environments,
    environmentId: state.environmentId,
    auth: draft.auth,
    variables: draft.variables,
    values: state.variables
      .filter((v) => !v.secret && v.id)
      .map((v) => [v.id, v.value]),
    timeZone: draft.defaults.timeZone,
    request: draft.stream.request,
    pagination: draft.stream.pagination,
    window: draft.stream.window,
  });
}

/** The unsaved definition a draft stores and a test request runs. */
export function draftDefinitionOf(
  state: BuilderState,
): CustomApiDraftDefinition {
  const name = state.name.trim();
  return {
    ...(name ? { name } : {}),
    environments: environmentsOf(state),
    variables: variablesOf(state),
    auth: state.auth,
    defaults: { ...state.defaults },
    stream: {
      key: state.stream.key,
      name: state.stream.name,
      request: requestOf(state),
      pagination: state.stream.pagination,
      records: state.stream.records ?? "",
      fields: state.stream.fields,
      ...(state.stream.keyFields.length
        ? { keyFields: state.stream.keyFields }
        : {}),
      mode: state.stream.mode,
      ...(state.stream.reportingField
        ? { reportingField: state.stream.reportingField }
        : {}),
      window: state.stream.window,
      retentionDays: null,
    },
  };
}

/**
 * The definition to save; the other streams of `original` are kept. A
 * JSON-body stream carries "only reads data" only when the state holds
 * the author's confirmation of exactly the request it saves.
 */
export function definitionOf(
  state: BuilderState,
  original?: CustomApiDefinition,
): CustomApiDefinition {
  const scope = scopeOf(state);
  return {
    schemaVersion: CUSTOM_API_SCHEMA_VERSION,
    name: state.name.trim(),
    environments: environmentsOf(state),
    variables: variablesOf(state),
    auth: state.auth,
    defaults: { ...state.defaults },
    ...(state.images?.hosts.length ? { images: state.images } : {}),
    streams: streamsOf(state, original).map((s) =>
      confirmed(s, scope, state.readOnly),
    ),
  };
}

// --------------------------------------------------- method, body, paging

/**
 * Switches the method. POST takes no next-link paging (it stays on its
 * endpoint); GET sends no body, so page values written into the body go
 * back to URL parameters. The typed body is kept either way.
 */
export function setMethod(
  state: BuilderState,
  method: RequestMethod,
): BuilderState {
  if (state.stream.method === method) return state;
  let pagination = state.stream.pagination;
  if (method === "POST" && pagination.type === "next_url")
    pagination = { type: "none" };
  if (method === "GET") pagination = withoutBodyPaths(pagination, true);
  return withWindowDefault({
    ...state,
    stream: { ...state.stream, method, pagination },
  });
}

/**
 * Switches between a JSON body and GraphQL. Both texts are kept; body
 * paths pointed into the other body, so they are cleared and the Paging
 * step asks where the page values go.
 */
export function setBodyKind(state: BuilderState, kind: BodyKind): BuilderState {
  if (state.stream.body.kind === kind) return state;
  return withWindowDefault({
    ...state,
    stream: {
      ...state.stream,
      body: { ...state.stream.body, kind },
      pagination: withoutBodyPaths(state.stream.pagination, false),
    },
  });
}

/** Edits the typed body (JSON text, GraphQL query or variables). */
export function withBody(
  state: BuilderState,
  patch: Partial<Omit<BodyEditor, "kind">>,
): BuilderState {
  return withWindowDefault({
    ...state,
    stream: { ...state.stream, body: { ...state.stream.body, ...patch } },
  });
}

/** Page values that went into the body: removed; `toParams` puts them back in URL parameters. */
function withoutBodyPaths(
  pagination: CustomApiPagination,
  toParams: boolean,
): CustomApiPagination {
  if (pagination.type === "cursor" && pagination.bodyPath !== undefined) {
    const { bodyPath: _path, firstPage: _first, ...rest } = pagination;
    return toParams && rest.param === undefined
      ? { ...rest, param: "cursor" }
      : rest;
  }
  if (pagination.type === "offset") {
    let next = pagination;
    for (const value of ["offset", "limit"] as const) {
      const { param, bodyPath } = PAGE_VALUE_KEYS[value];
      if (next[bodyPath] === undefined) continue;
      const { [bodyPath]: _path, ...rest } = next;
      next =
        toParams && rest[param] === undefined
          ? { ...rest, [param]: value }
          : rest;
    }
    return next;
  }
  return pagination;
}

/** A page value: the cursor, or the offset and limit of offset paging. */
export type PageValue = "cursor" | "offset" | "limit";

const PAGE_VALUE_KEYS = {
  cursor: { param: "param", bodyPath: "bodyPath" },
  offset: { param: "offsetParam", bodyPath: "offsetBodyPath" },
  limit: { param: "limitParam", bodyPath: "limitBodyPath" },
} as const;

type Placeable = Extract<CustomApiPagination, { type: "cursor" | "offset" }>;

function pageValueOwner(
  pagination: CustomApiPagination,
  value: PageValue,
): Placeable | null {
  if (value === "cursor")
    return pagination.type === "cursor" ? pagination : null;
  return pagination.type === "offset" ? pagination : null;
}

/** Where a page value goes now: a URL parameter, a body path, or not set yet. */
export function pageValuePlacement(
  pagination: CustomApiPagination,
  value: PageValue,
): "url" | "body" | null {
  const owner = pageValueOwner(pagination, value) as Record<
    string,
    unknown
  > | null;
  if (!owner) return null;
  const keys = PAGE_VALUE_KEYS[value];
  if (owner[keys.bodyPath] !== undefined) return "body";
  if (owner[keys.param] !== undefined) return "url";
  return null;
}

/**
 * Puts a page value in a URL parameter or in the body; the two exclude
 * each other (ADR 0030 §3). URL starts with the usual parameter name;
 * body with `bodyPath` when given, else unset until a value is picked.
 */
export function placePageValue(
  pagination: CustomApiPagination,
  value: PageValue,
  placement: "url" | "body",
  bodyPath?: string,
): CustomApiPagination {
  const owner = pageValueOwner(pagination, value);
  if (!owner) return pagination;
  const keys = PAGE_VALUE_KEYS[value];
  const next = { ...owner } as Record<string, unknown>;
  delete next[keys.param];
  delete next[keys.bodyPath];
  if (value === "cursor") delete next.firstPage;
  if (placement === "url") next[keys.param] = value;
  else if (bodyPath) next[keys.bodyPath] = bodyPath;
  return next as CustomApiPagination;
}

/** Sets the URL parameter of a page value; empty removes it, never "". */
export function setPageParam(
  pagination: CustomApiPagination,
  value: PageValue,
  param: string,
): CustomApiPagination {
  const owner = pageValueOwner(pagination, value);
  if (!owner) return pagination;
  const key = PAGE_VALUE_KEYS[value].param;
  const next = { ...owner } as Record<string, unknown>;
  if (param.trim()) next[key] = param.trim();
  else delete next[key];
  return next as CustomApiPagination;
}

/** Sets the body path of a page value; empty removes it (and the cursor's first page). */
export function setPageBodyPath(
  pagination: CustomApiPagination,
  value: PageValue,
  path: string,
): CustomApiPagination {
  const owner = pageValueOwner(pagination, value);
  if (!owner) return pagination;
  const key = PAGE_VALUE_KEYS[value].bodyPath;
  const next = { ...owner } as Record<string, unknown>;
  if (path) next[key] = path;
  else {
    delete next[key];
    if (value === "cursor") delete next.firstPage;
  }
  return next as CustomApiPagination;
}

/** What the first request sends at the cursor's body path: null (the default, not written) or nothing. */
export function setFirstPage(
  pagination: CustomApiPagination,
  firstPage: "null" | "omit",
): CustomApiPagination {
  if (pagination.type !== "cursor" || pagination.bodyPath === undefined)
    return pagination;
  const { firstPage: _old, ...rest } = pagination;
  return firstPage === "omit" ? { ...rest, firstPage } : rest;
}

/** Whether a body path ends at an array element (which "omit" can't leave out). */
export function endsAtArrayElement(path: string): boolean {
  try {
    const segments = parseDataPath(path);
    return segments.length > 0 && "index" in segments[segments.length - 1]!;
  } catch {
    return false;
  }
}

/**
 * The values of the typed body a page value can be written to (ADR 0030
 * §3): every leaf (no list or object), for GraphQL only under `variables`.
 */
export function bodyLeafPaths(state: BuilderState): string[] {
  const { body } = bodyOf(state.stream.body);
  if (!body) return [];
  const root: { value: unknown; path: DataPathSegment[] } =
    body.kind === "json"
      ? { value: body.value, path: [] }
      : { value: body.variables, path: [{ key: "variables" }] };
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const { value, path } = stack.pop()!;
    if (Array.isArray(value))
      for (let i = value.length - 1; i >= 0; i--)
        stack.push({ value: value[i], path: [...path, { index: i }] });
    else if (value !== null && typeof value === "object")
      for (const key of Object.keys(value).reverse())
        stack.push({
          value: (value as Record<string, unknown>)[key],
          path: [...path, { key }],
        });
    else if (path.length > 0) out.push(formatDataPath(path));
  }
  return out;
}

// ------------------------------------------------------- the shared checks

export interface RequestCheckIssue {
  path: (string | number)[];
  code: CustomApiIssueCode | "invalid";
}

/**
 * The SDK's request rules (checkCustomApiStreamRequest, ADR 0030) on the
 * stream as the draft test sends it: the same implementation the server
 * runs on a draft test and on a saved definition, never a copy. Paths are
 * relative to the stream ("request.body.query") or the auth ("auth.name").
 * A POST body that doesn't parse yet is reported by bodyProblems instead.
 */
export function requestCheckIssues(state: BuilderState): RequestCheckIssue[] {
  const draft = draftDefinitionOf(state);
  const issues: RequestCheckIssue[] = [];
  checkCustomApiStreamRequest(
    draft.stream,
    draft,
    (path, code) => {
      if (code === "method_body" && state.stream.method === "POST") return;
      issues.push({ path, code: code ?? "invalid" });
    },
    { paths: { stream: [], auth: ["auth"] }, confirmation: "draft" },
  );
  return issues;
}

export type GraphqlCheck =
  | { ok: true }
  | {
      ok: false;
      problem: "syntax" | "not_query" | "several_definitions" | "placeholder";
    };

/**
 * The GraphQL read-only guard on the typed query (ADR 0030 §2), from the
 * SDK's shared check: exactly one `query` operation, no placeholder in the
 * query. Null when the stream sends no GraphQL query yet.
 */
export function graphqlCheck(state: BuilderState): GraphqlCheck | null {
  const editor = state.stream.body;
  if (
    state.stream.method !== "POST" ||
    editor.kind !== "graphql" ||
    editor.query.trim() === ""
  )
    return null;
  // Variables that don't parse yet: the query is still checked, alone.
  const probe = bodyOf(editor).body
    ? state
    : {
        ...state,
        stream: { ...state.stream, body: { ...editor, variables: "{}" } },
      };
  const { body } = bodyOf(probe.stream.body);
  if (!body || body.kind !== "graphql") return null;
  const issues = requestCheckIssues(probe).filter(
    (issue) => issue.path.join(".") === "request.body.query",
  );
  if (issues.some((i) => i.code === "graphql_query_placeholder"))
    return { ok: false, problem: "placeholder" };
  if (issues.some((i) => i.code === "graphql_operation")) {
    const problem = customApiGraphqlProblem(body.query);
    return { ok: false, problem: problem ?? "syntax" };
  }
  return { ok: true };
}

// ------------------------------------------------------------------ secrets

/** The secret names a login method needs (secret variables aside). */
export function credentialNames(auth: Pick<CustomApiAuth, "type">): string[] {
  switch (auth.type) {
    case "api_key":
      return ["apiKey"];
    case "bearer":
      return ["token"];
    case "basic":
      return ["username", "password"];
    case "oauth_client_credentials":
    case "oauth_authorization_code":
      return ["clientId", "clientSecret"];
    case "none":
      return [];
  }
}

/** Every secret the draft needs before a test: credentials and secret variables. */
export function requiredSecrets(state: BuilderState): string[] {
  return [
    ...credentialNames(state.auth),
    ...state.variables.filter((v) => v.secret && v.id).map((v) => v.id),
  ];
}

/** The host (with port) a base URL sends to, or null when it is not a URL. */
export function hostOf(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    return url.host || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- variables

/** A connection value's placeholder name from its label: `Account ID` → `account_id`. */
export function variableIdFromLabel(
  label: string,
  taken: ReadonlySet<string>,
): string {
  let base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base && !/^[a-z]/.test(base)) base = `v_${base}`;
  base = base.slice(0, 36).replace(/_+$/, "");
  if (!base) return "";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** An environment id from its name: `Staging EU` → `staging-eu`, unique. */
export function environmentIdFromName(
  name: string,
  taken: ReadonlySet<string>,
): string {
  let base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(base)) base = base ? `env-${base}` : "env";
  base = base.slice(0, 36).replace(/-+$/, "");
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ----------------------------------------------------------------- requests

/** The request's URL templates: path, query values and header values. */
function templatesOf(state: BuilderState): string[] {
  return [
    state.stream.path,
    ...state.stream.query.map((row) => row.value),
    ...state.stream.headers.map((row) => row.value),
  ];
}

/** A POST stream's body strings placeholders may fill (none while it doesn't parse). */
function bodyTemplatesOf(state: BuilderState): string[] {
  if (state.stream.method !== "POST") return [];
  const { body } = bodyOf(state.stream.body);
  return body ? customApiBodyStringLeaves(body).map((leaf) => leaf.value) : [];
}

function placeholderNames(template: string): string[] | null {
  try {
    return parsePlaceholders(template).map((ref) => ref.name);
  } catch {
    return null;
  }
}

const WINDOW_NAMES = new Set<string>(WINDOW_PLACEHOLDERS);
const PAGE_NAMES = new Set<string>(PAGE_PLACEHOLDERS);

/** The request (URL or body) uses `{{window.start}}` or `{{window.end}}`. */
export function usesWindow(state: BuilderState): boolean {
  return [...templatesOf(state), ...bodyTemplatesOf(state)].some((template) =>
    (placeholderNames(template) ?? []).some((name) => WINDOW_NAMES.has(name)),
  );
}

/** A request that starts using the window gets the default date window. */
function withWindowDefault(state: BuilderState): BuilderState {
  if (state.stream.window.type === "none" && usesWindow(state))
    return { ...state, stream: { ...state.stream, window: DEFAULT_WINDOW } };
  return state;
}

/**
 * Applies a request change; a request that starts using the window gets
 * the default date window (the Paging step can change it).
 */
export function withRequest(
  state: BuilderState,
  patch: Partial<Pick<BuilderState["stream"], "path" | "query" | "headers">>,
): BuilderState {
  return withWindowDefault({ ...state, stream: { ...state.stream, ...patch } });
}

/** The placeholders the request's URL may use: values, the window, the paging value. */
export function availablePlaceholders(state: BuilderState): string[] {
  return [
    ...bodyPlaceholders(state),
    ...customApiPagePlaceholders(state.stream.pagination),
  ];
}

/**
 * The placeholders a body may use: connection values and the window.
 * Never page values: those reach a body only through the Paging step's
 * body paths (ADR 0030 §1).
 */
export function bodyPlaceholders(state: BuilderState): string[] {
  return [
    ...state.variables.filter((v) => v.id && !v.secret).map((v) => v.id),
    ...WINDOW_PLACEHOLDERS,
  ];
}

// ------------------------------------------------------------------- fields

function uniqueFieldId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) {
    const candidate = `${id}_${n}`.slice(0, 100);
    if (!taken.has(candidate)) return candidate;
  }
}

const isTime = (field: CustomApiField) =>
  field.type === "date" || field.type === "timestamp";

/** The date/timestamp reporting field if ticked, else the first ticked field. */
export function defaultKeyFields(state: BuilderState): string[] {
  const fields = state.stream.fields;
  const reporting =
    fields.find((f) => f.id === state.stream.reportingField && isTime(f)) ??
    fields.find(isTime);
  if (reporting) return [reporting.id];
  return fields[0] ? [fields[0].id] : [];
}

/**
 * Key, time and currency fields can't be empty: they are kept non-null. A
 * text or JSON field that no longer has such a role may be empty again
 * (its default, #834 review), unless the user or the saved definition set
 * it.
 */
function withRequiredFields(state: BuilderState): BuilderState {
  const required = new Set(state.stream.keyFields);
  if (state.stream.reportingField) required.add(state.stream.reportingField);
  for (const field of state.stream.fields)
    if (field.currencyField) required.add(field.currencyField);
  const chosen = new Set(state.nullableChosen);
  return {
    ...state,
    stream: {
      ...state.stream,
      fields: state.stream.fields.map((f) =>
        required.has(f.id)
          ? f.nullable
            ? { ...f, nullable: false }
            : f
          : !f.nullable && !chosen.has(f.id) && NULLABLE_BY_DEFAULT.has(f.type)
            ? { ...f, nullable: true }
            : f,
      ),
    },
  };
}

/** The user sets whether a field may be empty: kept from then on. */
export function setNullable(
  state: BuilderState,
  fieldId: string,
  nullable: boolean,
): BuilderState {
  return updateField(
    {
      ...state,
      nullableChosen: [...new Set([...state.nullableChosen, fieldId])],
    },
    fieldId,
    { nullable },
  );
}

/**
 * Until the user picks them: the first time field reports, and the first
 * ticked field (a time field if one is ticked by then) keys the stream. A
 * key that is still ticked stays (#834): ticking a time field later never
 * moves it; the Response step offers the time field as key instead.
 */
function withKeyDefaults(state: BuilderState): BuilderState {
  if (state.keyChosen) return withRequiredFields(state);
  const time = state.stream.fields.find(isTime);
  const next: BuilderState = {
    ...state,
    stream: { ...state.stream, reportingField: time?.id ?? null },
  };
  const ids = new Set(next.stream.fields.map((f) => f.id));
  if (!next.stream.keyFields.some((key) => ids.has(key)))
    next.stream.keyFields = defaultKeyFields(next);
  return withRequiredFields(next);
}

/**
 * Key names that identify a record: `id`, `user_id`, `orderId`, `uuid`,
 * `slug`… Not `code`: `country_code` names a category (#834 re-review).
 */
const ID_NAME = /(^|[_.-])(id|uuid|guid|key|slug)$/i;
const ID_CAMEL = /[a-z0-9](Id|ID|Uuid|UUID|Key)$/;

/** The key's last path key, lower-cased boundaries kept ("user.id" → "id"). */
function lastKeyOf(path: string): string {
  const match = /([^.[\]]+)(?:\[\d+\])*$/.exec(path);
  return match?.[1] ?? path;
}

/**
 * Whether a field is a sensible key on its own (#834 review): text (not an
 * image), or any field whose name says it identifies the record (`id`,
 * `user_id`, `orderId`, `uuid`, `slug`). A count, an amount, a code or a
 * yes/no is not: records with equal values would merge.
 */
export function sensibleKey(field: CustomApiField): boolean {
  if (field.type === "string" && !field.role) return true;
  const name = lastKeyOf(field.path);
  return ID_NAME.test(name) || ID_CAMEL.test(name) || ID_NAME.test(field.id);
}

/**
 * The warning about a key the user did not pick (#834): it is no time
 * field and no sensible key, so records with equal values merge. `time` is
 * the reporting field to offer as key instead, when there is one. Null
 * once the user picked a key, or for a time or sensible key.
 */
export function keyHint(
  state: BuilderState,
): { field: string; time: string | null } | null {
  if (state.keyChosen) return null;
  const fields = state.stream.fields;
  const key = fields.find((f) => f.id === state.stream.keyFields[0]);
  if (!key || isTime(key) || sensibleKey(key)) return null;
  const time = fields.find(
    (f) => f.id === state.stream.reportingField && isTime(f),
  );
  return { field: key.id, time: time?.id ?? null };
}

const NULLABLE_BY_DEFAULT = new Set<FieldType>(["string", "json"]);

/** Ticks or unticks a field the test response suggested (by its path). */
export function toggleField(
  state: BuilderState,
  suggestion: CustomApiFieldSuggestion,
  on: boolean,
): BuilderState {
  const fields = state.stream.fields;
  const existing = fields.find((f) => f.path === suggestion.path);
  if (on === Boolean(existing)) return state;
  if (!on) {
    const id = existing!.id;
    return withKeyDefaults({
      ...state,
      stream: {
        ...state.stream,
        fields: fields.filter((f) => f.id !== id),
        keyFields: state.stream.keyFields.filter((key) => key !== id),
        reportingField:
          state.stream.reportingField === id
            ? null
            : state.stream.reportingField,
      },
    });
  }
  const type = suggestion.role === "image" ? "string" : suggestion.type;
  const field: CustomApiField = {
    id: uniqueFieldId(suggestion.id, new Set(fields.map((f) => f.id))),
    name: suggestion.name,
    path: suggestion.path,
    type,
    // Text may be empty by default (#834): suggestions see only the first
    // records, and a null in a field that may not be empty skips the
    // whole record. Key and time fields are kept non-null below.
    nullable: suggestion.nullable || NULLABLE_BY_DEFAULT.has(type),
    classification: "internal",
    ...(suggestion.format ? { format: suggestion.format } : {}),
    ...(suggestion.role === "image" ? { role: "image" as const } : {}),
  };
  return withKeyDefaults({
    ...state,
    stream: { ...state.stream, fields: [...fields, field] },
  });
}

const NUMERIC = new Set<FieldType>(["integer", "number", "decimal"]);
const MONEY = new Set<FieldType>(["integer", "decimal"]);

/** Changes a field's type; "image" maps a string with the image role. */
export function setFieldType(
  state: BuilderState,
  fieldId: string,
  type: FieldType | "image",
): BuilderState {
  return withKeyDefaults({
    ...state,
    stream: {
      ...state.stream,
      fields: state.stream.fields.map((field) => {
        if (field.id !== fieldId) return field;
        const {
          role: _role,
          format,
          unit,
          currencyField,
          scale,
          ...rest
        } = field;
        const next: CustomApiField =
          type === "image"
            ? { ...rest, type: "string", role: "image" }
            : { ...rest, type };
        const keepFormat =
          format !== undefined &&
          (next.type === "timestamp" ||
            (next.type === "date" &&
              !["iso", "unix_seconds", "unix_millis"].includes(format)));
        if (keepFormat) next.format = format;
        if (unit !== undefined && NUMERIC.has(next.type)) next.unit = unit;
        if (currencyField !== undefined && MONEY.has(next.type))
          next.currencyField = currencyField;
        if (scale !== undefined && MONEY.has(next.type)) next.scale = scale;
        return next;
      }),
    },
  });
}

/** Changes other properties of one field (name, nullable, unit, classification…). */
export function updateField(
  state: BuilderState,
  fieldId: string,
  patch: Partial<Omit<CustomApiField, "id" | "path" | "type" | "role">>,
): BuilderState {
  return withKeyDefaults({
    ...state,
    stream: {
      ...state.stream,
      fields: state.stream.fields.map((field) => {
        if (field.id !== fieldId) return field;
        const next = { ...field, ...patch };
        for (const key of Object.keys(patch) as (keyof typeof patch)[])
          if (patch[key] === undefined) delete next[key];
        return next;
      }),
    },
  });
}

/** The user picks the key field (null: back to the default) and the time field. */
export function chooseKey(
  state: BuilderState,
  choice: { keyField?: string | null; reportingField?: string | null },
): BuilderState {
  const stream = { ...state.stream };
  if (choice.keyField !== undefined)
    stream.keyFields = choice.keyField ? [choice.keyField] : [];
  if (choice.reportingField !== undefined)
    stream.reportingField = choice.reportingField;
  return withKeyDefaults({ ...state, stream, keyChosen: true });
}

/** Picks the record list; picking another one drops the fields of the old one. */
export function pickRecords(state: BuilderState, path: string): BuilderState {
  if (state.stream.records === path) return state;
  return {
    ...state,
    keyChosen: false,
    nullableChosen: [],
    stream: {
      ...state.stream,
      records: path,
      fields: [],
      keyFields: [],
      reportingField: null,
    },
  };
}

// ------------------------------------------------------------------- issues

const FORBIDDEN_HEADERS = new Set<string>(CUSTOM_API_FORBIDDEN_HEADERS);
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CREDENTIAL_NAMES = new Set<string>(CUSTOM_API_CREDENTIAL_NAMES);

function basicsIssues(state: BuilderState): string[] {
  const issues: string[] = [];
  if (!state.name.trim()) issues.push("issues.nameRequired");
  const ids = new Set<string>();
  for (const environment of state.environments) {
    const url = environment.baseUrl.trim();
    const host = /^https:\/\//i.test(url) ? hostOf(url) : null;
    if (!host) issues.push("issues.baseUrlHttps");
    else if (!customApiEnvironmentSchema.shape.baseUrl.safeParse(url).success)
      issues.push("issues.baseUrlInvalid");
    if (!environment.name.trim()) issues.push("issues.environmentName");
    if (ids.has(environment.id)) issues.push("issues.environmentDuplicate");
    ids.add(environment.id);
  }
  return [...new Set(issues)];
}

function loginIssues(state: BuilderState): string[] {
  const issues: string[] = [];
  if (!customApiAuthSchema.safeParse(state.auth).success)
    issues.push("issues.loginSettings");
  const stored = new Set(state.secretsSet);
  if (credentialNames(state.auth).some((name) => !stored.has(name)))
    issues.push("issues.secretMissing");
  return issues;
}

function requestIssues(state: BuilderState): string[] {
  const issues = new Set<string>();
  const path = state.stream.path.trim();
  if (!path.startsWith("/")) issues.add("issues.pathSlash");
  else if (
    !customApiStreamSchema.shape.request.shape.path.safeParse(path).success &&
    placeholderNames(path) !== null
  )
    issues.add("issues.pathInvalid");

  const variables = new Map(state.variables.map((v) => [v.id, v]));
  const pages = customApiPagePlaceholders(state.stream.pagination);
  for (const template of templatesOf(state)) {
    const names = placeholderNames(template);
    if (names === null) {
      issues.add("issues.placeholderSyntax");
      continue;
    }
    for (const name of names) {
      if (WINDOW_NAMES.has(name)) continue;
      if (PAGE_NAMES.has(name)) {
        if (!pages.has(name as never)) issues.add("issues.pagePlaceholder");
        continue;
      }
      const variable = variables.get(name);
      if (!variable) issues.add("issues.unknownPlaceholder");
      else if (variable.secret) issues.add("issues.secretOutsideAuth");
    }
  }

  for (const { key } of state.stream.query)
    if (!key.trim()) issues.add("issues.rowName");
  for (const { key } of state.stream.headers) {
    const name = key.trim();
    if (!name) issues.add("issues.rowName");
    else if (name.toLowerCase() === "authorization")
      issues.add("issues.authHeader");
    else if (
      !HEADER_TOKEN.test(name) ||
      FORBIDDEN_HEADERS.has(name.toLowerCase())
    )
      issues.add("issues.headerInvalid");
  }

  const ids = new Set<string>();
  const stored = new Set(state.secretsSet);
  for (const variable of state.variables) {
    if (!variable.label.trim() || !variable.id)
      issues.add("issues.variableLabel");
    else if (ids.has(variable.id)) issues.add("issues.variableDuplicate");
    ids.add(variable.id);
    if (variable.secret && CREDENTIAL_NAMES.has(variable.id))
      issues.add("issues.reservedVariable");
    if (variable.secret && variable.id && !stored.has(variable.id))
      issues.add("issues.secretValueMissing");
    if (!variable.secret && variable.id && !variable.value.trim())
      issues.add("issues.variableValue");
  }

  // A POST body (ADR 0030): typed JSON first, then the SDK's request rules.
  const problems = bodyProblems(state);
  if (problems.json === "syntax") issues.add("issues.bodyJson");
  if (problems.query === "empty") issues.add("issues.graphqlQuery");
  if (problems.variables === "syntax" || problems.variables === "object")
    issues.add("issues.graphqlVariables");
  if (
    problems.json === "limits" ||
    problems.query === "limits" ||
    problems.variables === "limits"
  )
    issues.add("issues.bodyLimits");
  if (state.stream.method === "POST")
    for (const issue of requestCheckIssues(state)) {
      const [first, second] = issue.path;
      if (
        first === "auth" ||
        (first === "request" &&
          (second === "body" ||
            issue.code === "placeholder_page_in_post_path" ||
            issue.code === "graphql_param_reserved"))
      )
        issues.add(`issues.codes.${issue.code}`);
    }
  return [...issues];
}

/** The SDK's paging rules a step can show: placement, body paths, POST paging. */
const PAGING_CODES = new Set<string>([
  "pagination_placement",
  "body_path_invalid",
  "post_next_url",
  "graphql_param_reserved",
]);

function responseIssues(state: BuilderState): string[] {
  const issues: string[] = [];
  if (state.stream.records === null) issues.push("issues.recordsMissing");
  else if (state.stream.fields.length === 0)
    issues.push("issues.fieldsMissing");
  else if (state.stream.keyFields.length === 0)
    issues.push("issues.keyMissing");
  return issues;
}

function pagingIssues(state: BuilderState): string[] {
  const issues: string[] = [];
  if (!customApiPaginationSchema.safeParse(state.stream.pagination).success)
    issues.push("issues.pagingSettings");
  if (!customApiWindowSchema.safeParse(state.stream.window).success)
    issues.push("issues.windowSettings");
  if (state.stream.window.type === "none" && usesWindow(state))
    issues.push("issues.windowNeeded");
  for (const issue of requestCheckIssues(state))
    if (issue.path[0] === "pagination" && PAGING_CODES.has(issue.code))
      issues.push(`issues.codes.${issue.code}`);
  return [...new Set(issues)];
}

function reviewIssues(
  state: BuilderState,
  original: CustomApiDefinition | undefined,
): string[] {
  const minutes = state.defaults.refreshMinutes;
  const issues: string[] = [];
  if (
    !Number.isInteger(minutes) ||
    minutes < CUSTOM_API_LIMITS.refreshMinutesMin ||
    minutes > CUSTOM_API_LIMITS.refreshMinutesMax
  )
    issues.push("issues.refreshRange");
  const definition = definitionIssues(state, original);
  if (definition.some((issue) => issue.code === "read_only_unconfirmed"))
    issues.push("issues.readOnlyUnconfirmed");
  if (definition.some((issue) => issue.code !== "read_only_unconfirmed"))
    issues.push("issues.definitionInvalid");
  return issues;
}

/**
 * How the steps are checked: `editing` a saved definition, whose
 * document is `original`. The review checks the document saveAndConnect
 * saves, `definitionOf(state, original)`, so a JSON body's read-only
 * confirmation counts as it will be saved (ADR 0030).
 */
export interface StepOptions {
  editing?: boolean;
  original?: CustomApiDefinition;
}

/** Message keys (namespace `customApi`) of what keeps a step from being complete; [] = complete. */
export function stepIssues(
  state: BuilderState,
  step: BuilderStep,
  options: StepOptions = {},
): string[] {
  const all = allStepIssues(state, step, options.original);
  return options.editing ? all.filter((key) => !EDIT_HINTS.has(key)) : all;
}

/**
 * Editing a saved definition needs no credentials or test values: saving
 * does not test. There those checks are hints, not gates, so every step
 * can be opened directly (#834).
 */
const EDIT_HINTS = new Set([
  "issues.secretMissing",
  "issues.secretValueMissing",
  "issues.variableValue",
]);

/** The test-only checks a step shows as hints while editing (they don't block). */
export function stepHints(
  state: BuilderState,
  step: BuilderStep,
  options: StepOptions = {},
): string[] {
  return options.editing
    ? allStepIssues(state, step, options.original).filter((key) =>
        EDIT_HINTS.has(key),
      )
    : [];
}

function allStepIssues(
  state: BuilderState,
  step: BuilderStep,
  original: CustomApiDefinition | undefined,
): string[] {
  switch (step) {
    case "basics":
      return basicsIssues(state);
    case "login":
      return loginIssues(state);
    case "request":
      return requestIssues(state);
    case "response":
      return responseIssues(state);
    case "paging":
      return pagingIssues(state);
    case "review":
      return reviewIssues(state, original);
  }
}

export interface BuilderDefinitionIssue {
  step: BuilderStep;
  code: CustomApiIssueCode | "invalid";
  path: string;
}

/** Which step edits a document path ("streams.0.fields.2.type" → response). */
export function stepOfPath(path: string): BuilderStep {
  const parts = path.split(".");
  if (parts[0] === "name" || parts[0] === "environments") return "basics";
  if (parts[0] === "auth") return "login";
  if (parts[0] === "variables") return "request";
  if (parts[0] === "images") return "response";
  if (parts[0] === "defaults") return "review";
  if (parts[0] === "streams") {
    const property = parts[2];
    // The read-only confirmation is given where the save happens.
    if (parts.slice(3).join(".") === "body.readOnlyConfirmed") return "review";
    if (property === "request") return "request";
    if (property === "pagination" || property === "window") return "paging";
    if (property === "mode") return "review";
    return "response";
  }
  return "review";
}

/** What the saved definition would be refused for, by step. */
export function definitionIssues(
  state: BuilderState,
  original?: CustomApiDefinition,
): BuilderDefinitionIssue[] {
  const parsed = customApiDefinitionSchema.safeParse(
    definitionOf(state, original),
  );
  if (parsed.success) return [];
  return customApiIssues(parsed.error).map((issue) => ({
    step: stepOfPath(issue.path),
    code: issue.code,
    path: issue.path,
  }));
}

// ------------------------------------------------------------------- images

/** The hosts of a stream's image fields in the last test's records (#834). */
export function imageHostsSeen(state: BuilderState): string[] {
  const test = state.lastTest;
  const records = state.stream.records;
  const paths = state.stream.fields
    .filter((f) => f.role === "image")
    .map((f) => f.path);
  if (!test?.response || records === null || paths.length === 0) return [];
  let list: unknown;
  try {
    list = readDataPath(test.response.body, parseDataPath(records));
  } catch {
    return [];
  }
  const items = Array.isArray(list) ? list : [list];
  const hosts = new Set<string>();
  for (const item of items)
    for (const path of paths) {
      let value: unknown;
      try {
        value = readDataPath(item, parseDataPath(path));
      } catch {
        continue;
      }
      if (typeof value !== "string") continue;
      try {
        const url = new URL(value);
        if (url.protocol === "https:")
          hosts.add(url.hostname.toLowerCase().replace(/\.$/, ""));
      } catch {
        // Not a URL: skipped when the connection syncs.
      }
    }
  return [...hosts].slice(0, CUSTOM_API_LIMITS.imageHosts);
}

/**
 * An image host as typed or pasted (#834 review): a URL keeps only its host
 * name; a port, path, trailing dot and capitals are dropped. "*.example.com"
 * stays a pattern. Empty when nothing is left.
 */
export function normalizeImageHost(text: string): string {
  let host = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      // Not a URL after all: cut it below like a bare host.
    }
  }
  host = host.split(/[/?#]/)[0]!.replace(/:\d*$/, "");
  return host.toLowerCase().replace(/\.+$/, "");
}

/**
 * Sets the image hosts, normalised, without duplicates and at most
 * CUSTOM_API_LIMITS.imageHosts; an empty list goes back to the
 * environment host only.
 */
export function withImageHosts(
  state: BuilderState,
  hosts: readonly string[],
): BuilderState {
  const clean = [
    ...new Set(hosts.map(normalizeImageHost).filter(Boolean)),
  ].slice(0, CUSTOM_API_LIMITS.imageHosts);
  return {
    ...state,
    images: clean.length
      ? {
          hosts: clean,
          newestItems:
            state.images?.newestItems ?? CUSTOM_API_LIMITS.imageItemsDefault,
        }
      : null,
  };
}

/** The hosts a saved definition may send requests (and the login) to. */
export function definitionHosts(state: BuilderState): string[] {
  const hosts = new Set<string>();
  for (const environment of state.environments) {
    const host = hostOf(environment.baseUrl);
    if (host) hosts.add(host);
  }
  if (
    state.auth.type === "oauth_client_credentials" ||
    state.auth.type === "oauth_authorization_code"
  ) {
    const urls = [state.auth.tokenUrl];
    if (state.auth.type === "oauth_authorization_code") {
      urls.push(state.auth.authorizeUrl);
      if (state.auth.revokeUrl) urls.push(state.auth.revokeUrl);
    }
    for (const url of urls) {
      const host = hostOf(url);
      if (host) hosts.add(host);
    }
  }
  return [...hosts];
}
