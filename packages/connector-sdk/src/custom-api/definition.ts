// Custom API definition document, schema version 1 (milestone 13, ADR 0027).
//
// Internal to netrics: reached through the `@netrics/connector-sdk/custom-api`
// subpath, not re-exported from the SDK's index and not part of the SDK
// published in milestone 12. The document is portable JSON and holds no
// secrets: connections hold credentials and secret variable values.
//
// Sub-schemas are strict objects without object-level refinements, so the
// builder's draft schema can `.extend()` them; every rule that relates two
// properties lives in the document's superRefine.

import { z } from "zod";

import {
  DATASET_LIMITS,
  datasetFieldSchema,
  datasetFieldTypeSchema,
} from "../datasets.js";
import { utf8ByteLength } from "../utf8.js";
import { DATA_PATH_MAX_LENGTH, DataPathError, parseDataPath } from "./path.js";
import {
  PAGE_PLACEHOLDERS,
  PlaceholderSyntaxError,
  VARIABLE_ID,
  WINDOW_PLACEHOLDERS,
  parsePlaceholders,
  type PagePlaceholder,
} from "./placeholders.js";

export * from "./path.js";
export * from "./placeholders.js";

export const CUSTOM_API_SCHEMA_VERSION = 1;

export const CUSTOM_API_LIMITS = {
  documentBytes: 262_144,
  nameLength: 100,
  environments: 10,
  variables: 20,
  streams: 20 /* = DATASET_LIMITS.datasets */,
  fieldsPerStream: 100 /* = DATASET_LIMITS.fields */,
  queryParams: 30,
  headers: 20,
  templateLength: 2_000,
  imageHosts: 10,
  stepDaysMax: 366,
  lookbackDaysMax: 90,
  backfillDaysMax: 3_650,
  refreshMinutesMin: 1,
  refreshMinutesMax: 10_080,
  refreshMinutesDefault: 60,
  responseBytes: 10_485_760,
  decompressedBytes: 52_428_800,
  requestTimeoutMs: 30_000,
  pagesPerRun: 200,
  recordsPerRun: 100_000,
  runDurationMs: 1_800_000,
  jsonDepth: 64,
  nextUrlLength: 2_048,
  imageItemsDefault: 12,
  imageItemsMax: 50,
} as const satisfies Record<string, number> & {
  streams: typeof DATASET_LIMITS.datasets;
  fieldsPerStream: typeof DATASET_LIMITS.fields;
};

export const CUSTOM_API_ISSUE_CODES = [
  "placeholder_syntax",
  "placeholder_unknown",
  "placeholder_secret_outside_auth",
  "placeholder_page_without_pagination",
  "placeholder_window_without_window",
  "path_syntax",
  "environment_url",
  "duplicate_id",
  "header_forbidden",
  "header_name",
  "oauth_param_reserved",
  "oauth_secret_variable",
  "field_unknown",
  "field_role_type",
  "field_format_type",
  "key_field_invalid",
  "reporting_field_invalid",
  "mode_window",
  "money_field",
  "scale_type",
  "personal_retention",
  "pagination_param_clash",
  "document_too_large",
  "image_stream_needs_reporting_field",
  "variable_reserved",
] as const;
export type CustomApiIssueCode = (typeof CUSTOM_API_ISSUE_CODES)[number];

/**
 * Names a connection's credential envelope uses for the login method's
 * credentials and its own bookkeeping. A secret variable may not take one:
 * the builder's draft keeps credentials and secret variables in one map by
 * name, so `token` could be either.
 */
export const CUSTOM_API_CREDENTIAL_NAMES = [
  "apiKey",
  "token",
  "username",
  "password",
  "clientId",
  "clientSecret",
  "accessToken",
  "refreshToken",
  "host",
  "variables",
] as const;
const CREDENTIAL_NAMES = new Set<string>(CUSTOM_API_CREDENTIAL_NAMES);

/** True when a secret variable may not use this id (a credential name). */
export function customApiReservedVariableId(id: string): boolean {
  return CREDENTIAL_NAMES.has(id);
}

/** Header names a definition may never set (case-insensitive). */
export const CUSTOM_API_FORBIDDEN_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
] as const;

/** Authorize parameters netrics sets itself. */
export const CUSTOM_API_RESERVED_AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "nonce",
] as const;

const FORBIDDEN_HEADERS = new Set<string>(CUSTOM_API_FORBIDDEN_HEADERS);
const RESERVED_AUTHORIZE_PARAMS = new Set<string>(
  CUSTOM_API_RESERVED_AUTHORIZE_PARAMS,
);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const issue = (code: CustomApiIssueCode, message: string) => ({
  message,
  params: { code },
});

// ---------------------------------------------------------------- primitives

const datasetId = datasetFieldSchema.shape.id;
const name = z.string().min(1).max(CUSTOM_API_LIMITS.nameLength);

/** A `{{ placeholder }}` template; which names it may use is a document rule. */
/** No control characters (C0, DEL): rules out CR/LF header and request-line injection. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const template = z
  .string()
  .max(CUSTOM_API_LIMITS.templateLength)
  .refine((value) => !hasControlCharacter(value), {
    message: "Control characters are not allowed",
  })
  .refine(
    (value) => {
      try {
        parsePlaceholders(value);
        return true;
      } catch (error) {
        if (error instanceof PlaceholderSyntaxError) return false;
        throw error;
      }
    },
    issue("placeholder_syntax", "Invalid placeholder syntax"),
  );

const dataPath = z
  .string()
  .max(DATA_PATH_MAX_LENGTH)
  .refine(
    (value) => {
      try {
        parseDataPath(value);
        return true;
      } catch (error) {
        if (error instanceof DataPathError) return false;
        throw error;
      }
    },
    issue("path_syntax", "Invalid data path"),
  );

/**
 * Parses an https URL only when it is canonical: no backslash, whitespace or
 * control character anywhere, no credentials or fragment, and `URL.href`
 * reproduces the input (the WHATWG parser's implicit "/" path aside). So the
 * host a person reads in the definition is the host requests go to;
 * `https://evil.example\@api.example.com` or a newline inside the host
 * cannot be accepted.
 */
function canonicalHttpsUrl(value: string): URL | undefined {
  if (hasControlCharacter(value) || /[\s\\]/.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    value.includes("#")
  )
    return undefined;
  const implicitRoot =
    url.pathname === "/" && value === `${url.origin}${url.search}`;
  return url.href === value || implicitRoot ? url : undefined;
}

/** An https URL without credentials or fragment (OAuth endpoints may carry a query). */
const httpsUrl = z
  .string()
  .max(CUSTOM_API_LIMITS.nextUrlLength)
  .refine((value) => canonicalHttpsUrl(value) !== undefined, {
    message: "Expected a canonical https URL without credentials or fragment",
  });

const baseUrl = z
  .string()
  .max(CUSTOM_API_LIMITS.nextUrlLength)
  .refine(
    (value) => {
      const url = canonicalHttpsUrl(value);
      return (
        url !== undefined &&
        !value.includes("?") &&
        !value.includes("#") &&
        !value.endsWith("/")
      );
    },
    issue(
      "environment_url",
      "Base URL must be a canonical https URL, without credentials, query, fragment or trailing slash",
    ),
  );

const paramName = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) => [...value].every((char) => char >= " " && char !== "\u007f"),
    {
      message: "Parameter names cannot contain control characters",
    },
  );

const timeZone = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Unknown time zone" },
  );

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const IMAGE_HOST = new RegExp(
  `^(?:\\*\\.${HOST_LABEL}(?:\\.${HOST_LABEL})+|${HOST_LABEL}(?:\\.${HOST_LABEL})*)$`,
);
const imageHost = z
  .string()
  .max(253)
  .refine((value) => IMAGE_HOST.test(value), {
    message: 'Expected a lower-case host name or "*.example.com"',
  });

/**
 * Own-key record bounded in size; keys that could reach a prototype are
 * refused with an issue. zod's record skips an own `__proto__` key (as
 * `JSON.parse` creates it) without a word, so the raw keys are checked
 * before the record parses.
 */
function boundedRecord<V extends z.ZodType>(
  key: z.ZodString,
  value: V,
  max: number,
) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
      for (const k of Object.keys(raw))
        if (UNSAFE_KEYS.has(k))
          ctx.addIssue({ code: "custom", path: [k], message: "Reserved key" });
    })
    .pipe(
      z
        .record(
          key.refine((k) => !UNSAFE_KEYS.has(k), { message: "Reserved key" }),
          value,
        )
        .refine((record) => Object.keys(record).length <= max, {
          message: `At most ${max} entries`,
        }),
    );
}

/** Header map: RFC 7230 token names, none of the forbidden headers. */
function headerRecord() {
  return boundedRecord(
    z.string().max(100),
    template,
    CUSTOM_API_LIMITS.headers,
  ).superRefine((headers, ctx) => {
    const seen = new Set<string>();
    for (const header of Object.keys(headers)) {
      const lower = header.toLowerCase();
      if (seen.has(lower))
        ctx.addIssue({
          code: "custom",
          path: [header],
          ...issue("duplicate_id", "Header names are case-insensitive"),
        });
      seen.add(lower);
      if (!HEADER_TOKEN.test(header))
        ctx.addIssue({
          code: "custom",
          path: [header],
          ...issue("header_name", "Invalid header name"),
        });
      else if (FORBIDDEN_HEADERS.has(header.toLowerCase()))
        ctx.addIssue({
          code: "custom",
          path: [header],
          ...issue("header_forbidden", "This header cannot be set"),
        });
    }
  });
}

// ---------------------------------------------------------------- sub-schemas

export const customApiEnvironmentSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  name,
  baseUrl,
});

export const customApiVariableSchema = z.strictObject({
  id: z.string().regex(VARIABLE_ID),
  label: name,
  secret: z.boolean().default(false),
});

const authHeaders = { headers: headerRecord().optional() };
const scopes = z
  .array(
    z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/),
  )
  .max(50);
const clientAuth = z.enum(["body", "basic"]).default("body");

export const customApiAuthSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none"), ...authHeaders }),
  z.strictObject({
    type: z.literal("api_key"),
    placement: z.enum(["header", "query"]),
    name: paramName,
    ...authHeaders,
  }),
  z.strictObject({
    type: z.literal("bearer"),
    headerName: z.string().min(1).max(100).default("Authorization"),
    prefix: z.string().max(100).default("Bearer"),
    ...authHeaders,
  }),
  z.strictObject({ type: z.literal("basic"), ...authHeaders }),
  z.strictObject({
    type: z.literal("oauth_client_credentials"),
    tokenUrl: httpsUrl,
    scopes,
    clientAuth,
    ...authHeaders,
  }),
  z.strictObject({
    type: z.literal("oauth_authorization_code"),
    authorizeUrl: httpsUrl,
    tokenUrl: httpsUrl,
    revokeUrl: httpsUrl.optional(),
    scopes,
    pkce: z.boolean().default(true),
    clientAuth,
    authorizeParams: boundedRecord(paramName, z.string().max(500), 10)
      .superRefine((params, ctx) => {
        for (const key of Object.keys(params))
          if (RESERVED_AUTHORIZE_PARAMS.has(key))
            ctx.addIssue({
              code: "custom",
              path: [key],
              ...issue(
                "oauth_param_reserved",
                "netrics sets this authorize parameter itself",
              ),
            });
      })
      .default({}),
    ...authHeaders,
  }),
]);

export const CUSTOM_API_FIELD_FORMATS = [
  "iso",
  "unix_seconds",
  "unix_millis",
  "yyyy-MM-dd",
  "dd.MM.yyyy",
  "MM/dd/yyyy",
  "dd/MM/yyyy",
  "yyyyMMdd",
] as const;
/** Formats that carry a calendar date only; allowed on `date` fields. */
const CALENDAR_FORMATS = new Set<string>(CUSTOM_API_FIELD_FORMATS.slice(3));

export const customApiFieldSchema = z.strictObject({
  id: datasetId,
  name,
  path: dataPath,
  type: datasetFieldTypeSchema,
  nullable: z.boolean().default(true),
  classification: z
    .enum(["public", "internal", "personal"])
    .default("internal"),
  unit: z.string().min(1).max(100).optional(),
  currencyField: datasetId.optional(),
  scale: z.number().int().min(0).max(18).optional(),
  retentionDays: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  format: z.enum(CUSTOM_API_FIELD_FORMATS).optional(),
  role: z.literal("image").optional(),
});

const pageSize = z.number().int().min(1).max(1_000);
export const customApiPaginationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({
    type: z.literal("page_number"),
    param: paramName,
    start: z.union([z.literal(0), z.literal(1)]).default(1),
    sizeParam: paramName.optional(),
    size: pageSize.optional(),
  }),
  z.strictObject({
    type: z.literal("offset"),
    offsetParam: paramName,
    limitParam: paramName,
    limit: pageSize,
  }),
  z.strictObject({
    type: z.literal("cursor"),
    cursorPath: dataPath.min(1),
    param: paramName,
  }),
  z.discriminatedUnion("source", [
    z.strictObject({
      type: z.literal("next_url"),
      source: z.literal("body"),
      path: dataPath.min(1),
    }),
    z.strictObject({
      type: z.literal("next_url"),
      source: z.literal("link_header"),
    }),
  ]),
]);

export const customApiWindowSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({
    type: z.enum(["date", "timestamp"]),
    stepDays: z.number().int().min(1).max(CUSTOM_API_LIMITS.stepDaysMax),
    lookbackDays: z
      .number()
      .int()
      .min(0)
      .max(CUSTOM_API_LIMITS.lookbackDaysMax)
      .default(0),
    backfillDays: z
      .number()
      .int()
      .min(1)
      .max(CUSTOM_API_LIMITS.backfillDaysMax),
    paramFormat: z.enum(["date", "timestamp", "unix_seconds", "unix_millis"]),
    endInclusive: z.boolean().default(false),
  }),
]);

const DOT_SEGMENTS = new Set([".", "..", "%2e", "%2e%2e", ".%2e", "%2e."]);

/** A request path stays below the base URL: no "//", backslash (literal or %5c), encoded "/" (%2f) or dot segments. */
function requestPathOk(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !value.includes("\\") &&
    !value.includes("//") &&
    !/%(?:2f|5c)/i.test(value) &&
    !value.split("/").some((segment) => DOT_SEGMENTS.has(segment.toLowerCase()))
  );
}

export const customApiStreamSchema = z.strictObject({
  key: datasetId,
  name,
  request: z.strictObject({
    path: template.refine(requestPathOk, {
      message:
        'The path starts with "/" and has no query, fragment, backslash, empty or dot segments',
    }),
    query: boundedRecord(
      paramName,
      template,
      CUSTOM_API_LIMITS.queryParams,
    ).default({}),
    headers: headerRecord().default({}),
  }),
  pagination: customApiPaginationSchema.default({ type: "none" }),
  records: dataPath.default(""),
  fields: z
    .array(customApiFieldSchema)
    .min(1)
    .max(CUSTOM_API_LIMITS.fieldsPerStream),
  keyFields: z.array(datasetId).min(1).max(10),
  mode: z.enum(["upsert", "append", "replace_window", "snapshot"]),
  reportingField: datasetId.optional(),
  window: customApiWindowSchema.default({ type: "none" }),
  retentionDays: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .default(null),
});

const defaultsSchema = z.strictObject({
  refreshMinutes: z
    .number()
    .int()
    .min(CUSTOM_API_LIMITS.refreshMinutesMin)
    .max(CUSTOM_API_LIMITS.refreshMinutesMax)
    .default(CUSTOM_API_LIMITS.refreshMinutesDefault),
  timeZone: timeZone.default("UTC"),
});

const imagesSchema = z.strictObject({
  hosts: z.array(imageHost).min(1).max(CUSTOM_API_LIMITS.imageHosts),
  newestItems: z
    .number()
    .int()
    .min(1)
    .max(CUSTOM_API_LIMITS.imageItemsMax)
    .default(CUSTOM_API_LIMITS.imageItemsDefault),
});

const documentSchema = z.strictObject({
  schemaVersion: z.literal(CUSTOM_API_SCHEMA_VERSION),
  name,
  environments: z
    .array(customApiEnvironmentSchema)
    .min(1)
    .max(CUSTOM_API_LIMITS.environments),
  variables: z
    .array(customApiVariableSchema)
    .max(CUSTOM_API_LIMITS.variables)
    .default([]),
  auth: customApiAuthSchema,
  defaults: defaultsSchema.prefault({}),
  images: imagesSchema.optional(),
  streams: z.array(customApiStreamSchema).min(1).max(CUSTOM_API_LIMITS.streams),
});

export type CustomApiEnvironment = z.output<typeof customApiEnvironmentSchema>;
export type CustomApiVariable = z.output<typeof customApiVariableSchema>;
export type CustomApiAuth = z.output<typeof customApiAuthSchema>;
export type CustomApiField = z.output<typeof customApiFieldSchema>;
export type CustomApiFieldFormat = (typeof CUSTOM_API_FIELD_FORMATS)[number];
export type CustomApiPagination = z.output<typeof customApiPaginationSchema>;
export type CustomApiWindow = z.output<typeof customApiWindowSchema>;
export type CustomApiStream = z.output<typeof customApiStreamSchema>;
export type CustomApiImages = z.output<typeof imagesSchema>;
export type CustomApiDefinition = z.output<typeof documentSchema>;

// ---------------------------------------------------------- document rules

// The document rules also run when a property refinement failed (zod keeps
// going after non-fatal issues); a template with a syntax error is already
// reported, so it contributes no placeholders here.
function placeholdersOf(value: string) {
  try {
    return parsePlaceholders(value);
  } catch {
    return [];
  }
}

type Path = (string | number)[];

/** The page placeholders a pagination type provides. */
export function customApiPagePlaceholders(
  pagination: CustomApiPagination,
): ReadonlySet<PagePlaceholder> {
  switch (pagination.type) {
    case "page_number":
      return new Set<PagePlaceholder>(
        pagination.size === undefined
          ? ["page.number"]
          : ["page.number", "page.offset", "page.size"],
      );
    case "offset":
      return new Set<PagePlaceholder>(["page.offset", "page.size"]);
    case "cursor":
      return new Set<PagePlaceholder>(["page.cursor"]);
    default:
      return new Set();
  }
}

/** Query parameter names a pagination type sets, with the property naming each. */
function paginationParams(
  pagination: CustomApiPagination,
): [property: string, param: string][] {
  switch (pagination.type) {
    case "page_number":
      return pagination.sizeParam === undefined
        ? [["param", pagination.param]]
        : [
            ["param", pagination.param],
            ["sizeParam", pagination.sizeParam],
          ];
    case "offset":
      return [
        ["offsetParam", pagination.offsetParam],
        ["limitParam", pagination.limitParam],
      ];
    case "cursor":
      return [["param", pagination.param]];
    default:
      return [];
  }
}

const WINDOW_NAMES = new Set<string>(WINDOW_PLACEHOLDERS);
const PAGE_NAMES = new Set<string>(PAGE_PLACEHOLDERS);

function checkDocument(doc: CustomApiDefinition, ctx: z.RefinementCtx): void {
  const add = (path: Path, code: CustomApiIssueCode, message: string) =>
    ctx.addIssue({ code: "custom", path, ...issue(code, message) });

  const unique = (ids: string[], path: (index: number) => Path) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) add(path(index), "duplicate_id", "Duplicate ID");
      seen.add(id);
    });
  };
  unique(
    doc.environments.map((e) => e.id),
    (i) => ["environments", i, "id"],
  );
  unique(
    doc.variables.map((v) => v.id),
    (i) => ["variables", i, "id"],
  );
  unique(
    doc.streams.map((s) => s.key),
    (i) => ["streams", i, "key"],
  );

  doc.variables.forEach((variable, index) => {
    if (variable.secret && customApiReservedVariableId(variable.id))
      add(
        ["variables", index, "id"],
        "variable_reserved",
        "A secret connection value cannot use the name of a login credential",
      );
  });

  const variables = new Map(doc.variables.map((v) => [v.id, v]));
  const auth = doc.auth;
  const oauth =
    auth.type === "oauth_client_credentials" ||
    auth.type === "oauth_authorization_code";

  // Auth: header names that carry the credential, and auth headers.
  if (auth.type === "api_key" && auth.placement === "header") {
    if (!HEADER_TOKEN.test(auth.name))
      add(["auth", "name"], "header_name", "Invalid header name");
    else if (FORBIDDEN_HEADERS.has(auth.name.toLowerCase()))
      add(["auth", "name"], "header_forbidden", "This header cannot be set");
  }
  if (auth.type === "bearer") {
    if (!HEADER_TOKEN.test(auth.headerName))
      add(["auth", "headerName"], "header_name", "Invalid header name");
    else if (
      auth.headerName.toLowerCase() !== "authorization" &&
      FORBIDDEN_HEADERS.has(auth.headerName.toLowerCase())
    )
      add(
        ["auth", "headerName"],
        "header_forbidden",
        "This header cannot be set",
      );
  }
  if (auth.headers !== undefined && oauth && Object.keys(auth.headers).length)
    add(
      ["auth", "headers"],
      "oauth_secret_variable",
      "OAuth methods cannot add auth headers",
    );
  for (const [header, value] of Object.entries(auth.headers ?? {}))
    for (const ref of placeholdersOf(value))
      if (!variables.has(ref.name))
        add(
          ["auth", "headers", header],
          "placeholder_unknown",
          "Auth headers may use connection variables only",
        );

  const apiKeyQuery =
    auth.type === "api_key" && auth.placement === "query"
      ? auth.name
      : undefined;

  doc.streams.forEach((stream, s) => {
    const at = (...path: Path): Path => ["streams", s, ...path];
    const pages = customApiPagePlaceholders(stream.pagination);

    const checkTemplate = (value: string, path: Path) => {
      for (const ref of placeholdersOf(value)) {
        if (WINDOW_NAMES.has(ref.name)) {
          if (stream.window.type === "none")
            add(
              path,
              "placeholder_window_without_window",
              "Window placeholders need a window",
            );
        } else if (PAGE_NAMES.has(ref.name)) {
          if (!pages.has(ref.name as PagePlaceholder))
            add(
              path,
              "placeholder_page_without_pagination",
              "This page placeholder needs a matching pagination type",
            );
        } else {
          const variable = variables.get(ref.name);
          if (!variable)
            add(path, "placeholder_unknown", "Unknown placeholder");
          else if (variable.secret)
            add(
              path,
              "placeholder_secret_outside_auth",
              "Secret variables can only be used in auth headers",
            );
        }
      }
    };
    checkTemplate(stream.request.path, at("request", "path"));
    for (const [key, value] of Object.entries(stream.request.query))
      checkTemplate(value, at("request", "query", key));
    for (const [key, value] of Object.entries(stream.request.headers))
      checkTemplate(value, at("request", "headers", key));

    // Query parameter clashes.
    if (
      apiKeyQuery !== undefined &&
      Object.hasOwn(stream.request.query, apiKeyQuery)
    )
      add(
        at("request", "query", apiKeyQuery),
        "pagination_param_clash",
        "The API key query parameter is set by the auth method",
      );
    const taken = new Set(Object.keys(stream.request.query));
    if (apiKeyQuery !== undefined) taken.add(apiKeyQuery);
    for (const [property, param] of paginationParams(stream.pagination)) {
      if (taken.has(param))
        add(
          at("pagination", property),
          "pagination_param_clash",
          "This parameter is already used by the request or auth",
        );
      taken.add(param);
    }
    if (
      stream.pagination.type === "page_number" &&
      stream.pagination.sizeParam !== undefined &&
      stream.pagination.size === undefined
    )
      ctx.addIssue({
        code: "custom",
        path: at("pagination", "size"),
        message: "A page size parameter needs a page size",
      });

    // Fields: mirrors of sourceDatasetSchema, plus role and format.
    const fields = new Map<string, CustomApiField>();
    stream.fields.forEach((field, f) => {
      if (fields.has(field.id))
        add(at("fields", f, "id"), "duplicate_id", "Duplicate field ID");
      else fields.set(field.id, field);
    });
    stream.fields.forEach((field, f) => {
      const fieldAt = (property: string) => at("fields", f, property);
      const money =
        field.currencyField !== undefined ||
        field.unit === "currency" ||
        field.unit === "currency_minor";
      if (money) {
        const currency =
          field.currencyField === undefined
            ? undefined
            : fields.get(field.currencyField);
        if (field.currencyField !== undefined && !currency)
          add(fieldAt("currencyField"), "field_unknown", "Unknown field");
        else if (
          !["decimal", "integer"].includes(field.type) ||
          !currency ||
          currency.type !== "string" ||
          currency.nullable
        )
          add(
            fieldAt(
              field.currencyField === undefined ? "unit" : "currencyField",
            ),
            "money_field",
            "Money requires exact numeric values and a non-null currency field",
          );
      }
      if (
        field.scale !== undefined &&
        !["decimal", "integer"].includes(field.type)
      )
        add(
          fieldAt("scale"),
          "scale_type",
          "Scale requires an exact numeric field",
        );
      if (
        field.classification === "personal" &&
        field.retentionDays === undefined
      )
        add(
          fieldAt("retentionDays"),
          "personal_retention",
          "Personal fields require an explicit retention policy",
        );
      if (field.role === "image" && field.type !== "string")
        add(fieldAt("role"), "field_role_type", "Images need a string field");
      if (
        field.format !== undefined &&
        (field.type === "date"
          ? false
          : field.type !== "timestamp" || CALENDAR_FORMATS.has(field.format))
      )
        add(
          fieldAt("format"),
          "field_format_type",
          "This format does not fit the field type",
        );
    });

    const keys = new Set<string>();
    for (const key of stream.keyFields) {
      const field = fields.get(key);
      if (keys.has(key) || !field || field.nullable || field.type === "json") {
        add(
          at("keyFields"),
          "key_field_invalid",
          "Key fields must be unique, non-null, non-JSON fields",
        );
        break;
      }
      keys.add(key);
    }

    if (stream.reportingField !== undefined) {
      const field = fields.get(stream.reportingField);
      if (
        !field ||
        field.nullable ||
        (field.type !== "date" && field.type !== "timestamp")
      )
        add(
          at("reportingField"),
          "reporting_field_invalid",
          "The reporting field must be a non-null date or timestamp field",
        );
    } else if (stream.fields.some((field) => field.role === "image"))
      add(
        at("reportingField"),
        "image_stream_needs_reporting_field",
        "A stream with images needs a reporting field to find the newest items",
      );

    if (
      stream.mode === "replace_window" &&
      (stream.reportingField === undefined || stream.window.type === "none")
    )
      add(
        at("mode"),
        "mode_window",
        "Window replacement needs a reporting field and a window",
      );
    if (stream.mode === "snapshot" && stream.window.type !== "none")
      add(at("mode"), "mode_window", "A snapshot stream has no window");
  });

  if (utf8ByteLength(JSON.stringify(doc)) > CUSTOM_API_LIMITS.documentBytes)
    add([], "document_too_large", "The definition is too large");
}

export const customApiDefinitionSchema =
  documentSchema.superRefine(checkDocument);

/**
 * The document's shape without the cross-field rules (placeholders,
 * references, reserved names, size). Only for reading back a stored
 * version that a later, stricter rule rejects: it stays readable (history,
 * export, the API response) while saving, restoring and importing it
 * answer the issues. Never use it to accept input.
 */
export const customApiStoredDefinitionSchema = documentSchema;

// ------------------------------------------------------------------- issues

export interface CustomApiIssue {
  path: string;
  code: CustomApiIssueCode | "invalid";
  message: string;
}

const ISSUE_CODES = new Set<string>(CUSTOM_API_ISSUE_CODES);
export const CUSTOM_API_MAX_ISSUES = 20;

/** Longest key name an issue repeats; longer ones are cut with "…". */
const ISSUE_KEY_LENGTH = 64;

/** A key name from the input, cut and with control characters escaped. */
function issueKey(key: PropertyKey): string {
  const text = typeof key === "symbol" ? "symbol" : String(key);
  const cut =
    text.length > ISSUE_KEY_LENGTH
      ? `${text.slice(0, ISSUE_KEY_LENGTH - 1)}…`
      : text;
  // JSON escaping, without the quotes: control characters, `"` and `\`.
  return JSON.stringify(cut).slice(1, -1);
}

/**
 * First 20 issues; path joined with "." ("streams.0.fields.2.path"); zod
 * built-ins get code "invalid". Never includes input values. Key names from
 * the input (record keys in a path, unknown properties) are cut to 64
 * characters and escaped.
 */
export function customApiIssues(error: z.ZodError): CustomApiIssue[] {
  return error.issues.slice(0, CUSTOM_API_MAX_ISSUES).map((entry) => {
    const code =
      entry.code === "custom" &&
      typeof entry.params?.code === "string" &&
      ISSUE_CODES.has(entry.params.code)
        ? (entry.params.code as CustomApiIssueCode)
        : "invalid";
    return {
      path: entry.path.map(issueKey).join("."),
      code,
      // zod's built-in messages describe the expectation, never the input,
      // except the unknown-key message, which repeats the keys whole; it is
      // rebuilt with cut keys. Custom messages here are fixed sentences.
      message:
        entry.code === "unrecognized_keys"
          ? unknownKeysMessage(entry.keys)
          : entry.message,
    };
  });
}

function unknownKeysMessage(keys: readonly string[]): string {
  const shown = keys.slice(0, 3).map((key) => `"${issueKey(key)}"`);
  const more = keys.length > 3 ? ` and ${keys.length - 3} more` : "";
  return `Unknown ${keys.length === 1 ? "property" : "properties"}: ${shown.join(", ")}${more}`;
}

// ------------------------------------------------------------------ upgrade

export type CustomApiDefinitionErrorCode =
  "not_an_object" | "unsupported_schema_version" | "invalid";

const ERROR_MESSAGES: Record<CustomApiDefinitionErrorCode, string> = {
  not_an_object: "A custom API definition is a JSON object",
  unsupported_schema_version:
    "This custom API definition uses a schema version this netrics does not support",
  invalid: "The custom API definition is invalid",
};

/** The one issue a whole-document error carries, so callers always mark something. */
const DOCUMENT_ISSUES: Record<
  Exclude<CustomApiDefinitionErrorCode, "invalid">,
  CustomApiIssue
> = {
  not_an_object: {
    path: "",
    code: "invalid",
    message: ERROR_MESSAGES.not_an_object,
  },
  unsupported_schema_version: {
    path: "schemaVersion",
    code: "invalid",
    message: ERROR_MESSAGES.unsupported_schema_version,
  },
};

export class CustomApiDefinitionError extends Error {
  readonly issues: CustomApiIssue[];
  constructor(
    readonly code: CustomApiDefinitionErrorCode,
    issues: CustomApiIssue[],
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "CustomApiDefinitionError";
    this.issues =
      issues.length === 0 && code !== "invalid"
        ? [{ ...DOCUMENT_ISSUES[code] }]
        : issues;
  }
}

/**
 * Compact JSON size of an input document, or Infinity when it does not
 * serialize. Every property of the input survives the strict parse, so an
 * input over the limit is over it after the parse too: checking it first
 * spares parsing an oversized document.
 */
function inputBytes(raw: unknown): number {
  try {
    const text = JSON.stringify(raw);
    return text === undefined ? 0 : utf8ByteLength(text);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Upgrade steps by source version: UPGRADES[n] turns a version-n document into
 * n+1. Empty while only v1 exists. Every step needs fixtures/v<n>-*.json.
 */
export const CUSTOM_API_UPGRADES: Readonly<
  Record<number, (doc: Record<string, unknown>) => Record<string, unknown>>
> = Object.freeze({});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Validates any stored or imported document: upgrades older versions step by step, then parses with the current schema. */
export function upgradeCustomApiDefinition(raw: unknown): CustomApiDefinition {
  if (!isPlainObject(raw))
    throw new CustomApiDefinitionError("not_an_object", []);
  let doc = raw;
  for (;;) {
    const version = doc.schemaVersion;
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > CUSTOM_API_SCHEMA_VERSION
    )
      throw new CustomApiDefinitionError("unsupported_schema_version", []);
    if (version === CUSTOM_API_SCHEMA_VERSION) break;
    const step = Object.hasOwn(CUSTOM_API_UPGRADES, version)
      ? CUSTOM_API_UPGRADES[version]
      : undefined;
    if (!step)
      throw new CustomApiDefinitionError("unsupported_schema_version", []);
    const next = step(doc);
    if (!isPlainObject(next) || next.schemaVersion !== version + 1)
      throw new Error(`Custom API upgrade from version ${version} is broken`);
    doc = next;
  }
  if (inputBytes(doc) > CUSTOM_API_LIMITS.documentBytes)
    throw new CustomApiDefinitionError("invalid", [
      {
        path: "",
        code: "document_too_large",
        message: "The definition is too large",
      },
    ]);
  const parsed = customApiDefinitionSchema.safeParse(doc);
  if (!parsed.success)
    throw new CustomApiDefinitionError(
      "invalid",
      customApiIssues(parsed.error),
    );
  return parsed.data;
}

/**
 * Reads a stored version back. Stored documents passed validation when
 * they were saved; a later, stricter rule (a reserved name, a new
 * placeholder check) may reject one now. Such a document still reads
 * (upgraded, with its shape checked), so history, export and the API keep
 * working, while saving, restoring and importing it answer the issues.
 * Throws CustomApiDefinitionError only when even the shape does not hold.
 */
export function readStoredCustomApiDefinition(
  raw: unknown,
): CustomApiDefinition {
  try {
    return upgradeCustomApiDefinition(raw);
  } catch (error) {
    if (
      !(error instanceof CustomApiDefinitionError) ||
      error.code !== "invalid"
    )
      throw error;
    // The upgrade ran; only the current schema refused. Upgrade again
    // without the cross-field rules.
    let doc = raw as Record<string, unknown>;
    while (
      typeof doc.schemaVersion === "number" &&
      doc.schemaVersion < CUSTOM_API_SCHEMA_VERSION
    )
      doc = CUSTOM_API_UPGRADES[doc.schemaVersion]!(doc);
    const shape = customApiStoredDefinitionSchema.safeParse(doc);
    if (!shape.success) throw error;
    return shape.data;
  }
}
