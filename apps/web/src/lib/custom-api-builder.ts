// The custom API builder's state (milestone 13, #807): what the six steps
// edit, and the pure conversions between it and the definition document.
// The builder never holds a secret value here: secrets are sent to the
// draft connection once and only their names come back (`secretsSet`).

import {
  CUSTOM_API_CREDENTIAL_NAMES,
  CUSTOM_API_FORBIDDEN_HEADERS,
  CUSTOM_API_LIMITS,
  CUSTOM_API_SCHEMA_VERSION,
  customApiAuthSchema,
  customApiDefinitionSchema,
  customApiEnvironmentSchema,
  customApiIssues,
  customApiPagePlaceholders,
  customApiPaginationSchema,
  customApiStreamSchema,
  customApiWindowSchema,
  PAGE_PLACEHOLDERS,
  parsePlaceholders,
  WINDOW_PLACEHOLDERS,
  type CustomApiAuth,
  type CustomApiDefinition,
  type CustomApiDraftDefinition,
  type CustomApiField,
  type CustomApiFieldSuggestion,
  type CustomApiIssueCode,
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
  lastTest: CustomApiTestResponse | null;
  /** The user picked the key or time field: no more automatic defaults. */
  keyChosen: boolean;
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
    lastTest: null,
    keyChosen: false,
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
    lastTest: null,
    keyChosen: true,
  };
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

function requestOf(state: BuilderState) {
  return {
    path: state.stream.path.trim() || "/",
    query: recordOf(state.stream.query),
    headers: recordOf(state.stream.headers),
  };
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

/** The definition to save; the other streams (and images) of `original` are kept. */
export function definitionOf(
  state: BuilderState,
  original?: CustomApiDefinition,
): CustomApiDefinition {
  const previous = original?.streams.find((s) => s.key === state.stream.key);
  const stream: CustomApiStream = {
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
  const streams = original
    ? previous
      ? original.streams.map((s) => (s.key === stream.key ? stream : s))
      : [...original.streams, stream]
    : [stream];
  return {
    schemaVersion: CUSTOM_API_SCHEMA_VERSION,
    name: state.name.trim(),
    environments: environmentsOf(state),
    variables: variablesOf(state),
    auth: state.auth,
    defaults: { ...state.defaults },
    ...(original?.images ? { images: original.images } : {}),
    streams,
  };
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

/** The request's templates: path, query values and header values. */
function templatesOf(state: BuilderState): string[] {
  return [
    state.stream.path,
    ...state.stream.query.map((row) => row.value),
    ...state.stream.headers.map((row) => row.value),
  ];
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

/** The request uses `{{window.start}}` or `{{window.end}}`. */
export function usesWindow(state: BuilderState): boolean {
  return templatesOf(state).some((template) =>
    (placeholderNames(template) ?? []).some((name) => WINDOW_NAMES.has(name)),
  );
}

/**
 * Applies a request change; a request that starts using the window gets
 * the default date window (the Paging step can change it).
 */
export function withRequest(
  state: BuilderState,
  patch: Partial<Pick<BuilderState["stream"], "path" | "query" | "headers">>,
): BuilderState {
  const next = { ...state, stream: { ...state.stream, ...patch } };
  if (next.stream.window.type === "none" && usesWindow(next))
    next.stream = { ...next.stream, window: DEFAULT_WINDOW };
  return next;
}

/** The placeholders the request may use: values, the window, the paging value. */
export function availablePlaceholders(state: BuilderState): string[] {
  return [
    ...state.variables.filter((v) => v.id && !v.secret).map((v) => v.id),
    ...WINDOW_PLACEHOLDERS,
    ...customApiPagePlaceholders(state.stream.pagination),
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

/** Key and time fields can't be empty: they are kept non-null. */
function withRequiredFields(state: BuilderState): BuilderState {
  const required = new Set(state.stream.keyFields);
  if (state.stream.reportingField) required.add(state.stream.reportingField);
  return {
    ...state,
    stream: {
      ...state.stream,
      fields: state.stream.fields.map((f) =>
        required.has(f.id) && f.nullable ? { ...f, nullable: false } : f,
      ),
    },
  };
}

/** Until the user picks them: the first time field reports, and keys the stream. */
function withKeyDefaults(state: BuilderState): BuilderState {
  if (state.keyChosen) return withRequiredFields(state);
  const time = state.stream.fields.find(isTime);
  const next: BuilderState = {
    ...state,
    stream: { ...state.stream, reportingField: time?.id ?? null },
  };
  next.stream.keyFields = defaultKeyFields(next);
  return withRequiredFields(next);
}

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
  const field: CustomApiField = {
    id: uniqueFieldId(suggestion.id, new Set(fields.map((f) => f.id))),
    name: suggestion.name,
    path: suggestion.path,
    type: suggestion.role === "image" ? "string" : suggestion.type,
    nullable: suggestion.nullable,
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
  return [...issues];
}

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
  return issues;
}

function reviewIssues(state: BuilderState): string[] {
  const minutes = state.defaults.refreshMinutes;
  const issues: string[] = [];
  if (
    !Number.isInteger(minutes) ||
    minutes < CUSTOM_API_LIMITS.refreshMinutesMin ||
    minutes > CUSTOM_API_LIMITS.refreshMinutesMax
  )
    issues.push("issues.refreshRange");
  if (definitionIssues(state).length > 0)
    issues.push("issues.definitionInvalid");
  return issues;
}

/** Message keys (namespace `customApi`) of what keeps a step from being complete; [] = complete. */
export function stepIssues(
  state: BuilderState,
  step: BuilderStep,
  options: { editing?: boolean } = {},
): string[] {
  const all = allStepIssues(state, step);
  return options.editing ? all.filter((key) => !SECRET_HINTS.has(key)) : all;
}

/**
 * Editing a saved definition needs no credentials: saving does not test.
 * There the missing-secret checks are hints, not gates.
 */
const SECRET_HINTS = new Set([
  "issues.secretMissing",
  "issues.secretValueMissing",
]);

/** The secret checks a step shows as hints while editing (they don't block). */
export function stepHints(
  state: BuilderState,
  step: BuilderStep,
  options: { editing?: boolean } = {},
): string[] {
  return options.editing
    ? allStepIssues(state, step).filter((key) => SECRET_HINTS.has(key))
    : [];
}

function allStepIssues(state: BuilderState, step: BuilderStep): string[] {
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
      return reviewIssues(state);
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
  if (parts[0] === "defaults" || parts[0] === "images") return "review";
  if (parts[0] === "streams") {
    const property = parts[2];
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
