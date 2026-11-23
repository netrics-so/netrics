// Builds one custom API request: URL from the environment's base URL and the
// stream's templates, pagination parameters, headers, and the auth of the
// definition. Credentials only ever go to the environment host.

import {
  isCustomApiGraphqlReservedParam,
  parsePlaceholders,
  renderCustomApiBody,
  renderTemplate,
  type CustomApiBodyWrite,
  type CustomApiDefinition,
  type CustomApiEnvironment,
  type CustomApiStream,
} from "@netrics/connector-sdk/custom-api";

import type { CustomApiCredentials } from "./credentials.js";
import {
  CustomApiAuthError,
  CustomApiConfigError,
  CustomApiResponseError,
} from "./errors.js";
import { customApiEnvironmentHost } from "./manifest.js";
import { CUSTOM_API_MESSAGES } from "./messages.js";
import { firstPageParams } from "./pagination.js";

export interface BuiltRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  /** POST: the rendered JSON body. Redacted like rendered headers (ADR 0030 §4). */
  body?: string;
  /** The URL with the API key and cursor values (every query value of a next URL) replaced. */
  redactedUrl: string;
}

const REDACTED = "[redacted]";

/** Fixed messages of requests a POST or GraphQL stream refuses to send. */
export const POST_FIXED_ENDPOINT =
  "A POST request stays on the endpoint its definition names: it takes no next page URL";
export const GRAPHQL_URL_PARAM =
  "A GraphQL request cannot carry the URL parameters query, operationName, variables or extensions";

type AuthInput = Pick<CustomApiDefinition, "auth" | "variables">;

function stringValues(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record))
    if (typeof value === "string") out[key] = value;
  return out;
}

function secretVariables(
  credentials: CustomApiCredentials,
): Record<string, string> {
  return "variables" in credentials && credentials.variables
    ? stringValues(credentials.variables)
    : {};
}

/** Header values never carry CR, LF or NUL (header injection). */
function checkHeaderValue(value: string): string {
  if (/[\r\n\0]/.test(value))
    throw new CustomApiConfigError(
      "A request header value contains a line break",
    );
  return value;
}

/** Rendered auth.headers of the definition (connection variables, secret or not). */
function authHeaders(
  definition: AuthInput,
  credentials: CustomApiCredentials,
  config: Record<string, unknown>,
): Record<string, string> {
  const values = { ...stringValues(config), ...secretVariables(credentials) };
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(definition.auth.headers ?? {}))
    headers[name.toLowerCase()] = checkHeaderValue(
      renderTemplate(template, values, (value) => value),
    );
  return headers;
}

function checkBinding(
  environment: CustomApiEnvironment,
  credentials: CustomApiCredentials,
): void {
  if (
    "host" in credentials &&
    credentials.host !== customApiEnvironmentHost(environment)
  )
    throw new CustomApiAuthError(CUSTOM_API_MESSAGES.hostChanged);
}

/**
 * Adds the auth of `definition.auth` to a request on the environment host:
 * headers (incl. rendered auth.headers) and, for an API key placed in the
 * query, the query parameter. Throws CustomApiAuthError(hostChanged) when
 * the credentials were entered for another host, and refuses a URL on
 * another host than the environment's.
 */
export function applyCustomApiAuth(
  request: { url: URL; headers: Record<string, string> },
  definition: AuthInput,
  environment: CustomApiEnvironment,
  credentials: CustomApiCredentials,
  config: Record<string, unknown> = {},
): void {
  const base = new URL(environment.baseUrl);
  if (request.url.protocol !== base.protocol || request.url.host !== base.host)
    throw new CustomApiConfigError(
      "Credentials are only sent to the environment host",
    );
  checkBinding(environment, credentials);
  Object.assign(request.headers, authHeaders(definition, credentials, config));
  const auth = definition.auth;
  switch (auth.type) {
    case "api_key":
      if ("apiKey" in credentials) {
        if (auth.placement === "header")
          request.headers[auth.name.toLowerCase()] = credentials.apiKey;
        else request.url.searchParams.set(auth.name, credentials.apiKey);
      }
      return;
    case "bearer":
      if ("token" in credentials)
        request.headers[auth.headerName.toLowerCase()] = auth.prefix
          ? `${auth.prefix} ${credentials.token}`
          : credentials.token;
      return;
    case "basic":
      if ("username" in credentials)
        request.headers.authorization = `Basic ${basicValue(credentials)}`;
      return;
    case "oauth_client_credentials":
    case "oauth_authorization_code":
      if ("accessToken" in credentials)
        request.headers.authorization = `Bearer ${credentials.accessToken}`;
      return;
    case "none":
      return;
  }
}

function basicValue(credentials: { username: string; password: string }) {
  return Buffer.from(
    `${credentials.username}:${credentials.password}`,
    "utf8",
  ).toString("base64");
}

/**
 * A value placed into the request path is encoded once; one that would form
 * or cross a path segment by itself ("." / "..", or a "/" or "\") is refused
 * rather than encoded, so a connection value cannot walk the path.
 */
function pathSegmentValue(value: string): string {
  if (value === "." || value === ".." || /[/\\]/.test(value))
    throw new CustomApiConfigError(
      "A connection value used in the request path cannot be a dot segment or contain a slash",
    );
  return encodeURIComponent(value);
}

export function buildRequest(input: {
  definition: AuthInput;
  stream: Pick<CustomApiStream, "request">;
  environment: CustomApiEnvironment;
  config: Record<string, unknown>;
  credentials: CustomApiCredentials;
  /** window.* and page.* */
  placeholders: Readonly<Record<string, string>>;
  /** Added by the pagination type. */
  pageParams: Readonly<Record<string, string>>;
  /** Page values the pagination type writes into a POST body. */
  bodyWrites?: readonly CustomApiBodyWrite[];
  /** next_url pages: used as is after the host check. */
  nextUrl?: string;
}): BuiltRequest {
  const { definition, stream, environment, credentials } = input;
  checkBinding(environment, credentials);
  const method = stream.request.method ?? "GET";
  const requestBody = stream.request.body;
  // A POST stream stays on the endpoint its definition names (ADR 0030 §2).
  if (method === "POST" && input.nextUrl !== undefined)
    throw new CustomApiConfigError(POST_FIXED_ENDPOINT);
  if ((method === "POST") !== (requestBody !== undefined))
    throw new CustomApiConfigError(
      "A POST request needs a body, and only a POST request sends one",
    );
  const base = new URL(environment.baseUrl);
  const values = { ...stringValues(input.config), ...input.placeholders };
  let url: URL;
  if (input.nextUrl !== undefined) {
    try {
      url = new URL(input.nextUrl);
    } catch {
      throw new CustomApiResponseError(CUSTOM_API_MESSAGES.nextUrlOffHost);
    }
    if (url.protocol !== base.protocol || url.host !== base.host)
      throw new CustomApiResponseError(CUSTOM_API_MESSAGES.nextUrlOffHost);
    url.hash = "";
  } else {
    const path = renderTemplate(stream.request.path, values, pathSegmentValue);
    url = new URL(`${environment.baseUrl}${path}`);
    if (url.host !== base.host)
      throw new CustomApiConfigError("The request left the environment host");
    for (const [name, template] of Object.entries(stream.request.query))
      url.searchParams.set(
        name,
        renderTemplate(template, values, (value) => value),
      );
    for (const [name, value] of Object.entries(input.pageParams))
      url.searchParams.set(name, value);
  }
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [name, template] of Object.entries(stream.request.headers))
    headers[name.toLowerCase()] = checkHeaderValue(
      renderTemplate(template, values, (value) => value),
    );
  applyCustomApiAuth(
    { url, headers },
    definition,
    environment,
    credentials,
    input.config,
  );
  let body: string | undefined;
  if (requestBody !== undefined) {
    // Checked on every request, whatever the definition check found:
    // some servers let URL parameters override a GraphQL body.
    if (requestBody.kind === "graphql")
      for (const name of url.searchParams.keys())
        if (isCustomApiGraphqlReservedParam(name))
          throw new CustomApiConfigError(GRAPHQL_URL_PARAM);
    body = renderCustomApiBody(
      requestBody,
      (template) => renderTemplate(template, values, (value) => value),
      input.bodyWrites ?? [],
    );
    headers["content-type"] = "application/json; charset=utf-8";
  }

  const redacted = new URL(url.href);
  const auth = definition.auth;
  const cursor = input.placeholders["page.cursor"];
  for (const [name, value] of [...redacted.searchParams]) {
    if (
      input.nextUrl !== undefined ||
      (auth.type === "api_key" &&
        auth.placement === "query" &&
        name === auth.name) ||
      (cursor !== undefined && value === cursor)
    )
      redacted.searchParams.set(name, REDACTED);
  }
  return {
    method,
    url: url.href,
    headers,
    ...(body !== undefined ? { body } : {}),
    redactedUrl: `${redacted.origin}${redacted.pathname}${redacted.search.replaceAll("%5Bredacted%5D", REDACTED)}`,
  };
}

/**
 * Values the host adds to its redaction set besides the stored credential
 * values: the basic "user:pass" base64 and "Basic <b64>", "<prefix> <token>",
 * rendered auth.headers values, secret variable values, and the rendered
 * bodies of `streams` (ADR 0030 §4).
 */
export function customApiSecretValues(
  definition: AuthInput,
  credentials: CustomApiCredentials,
  config: Record<string, unknown> = {},
  streams: readonly Pick<CustomApiStream, "request" | "pagination">[] = [],
): string[] {
  const values: string[] = [];
  const auth = definition.auth;
  if ("apiKey" in credentials) values.push(credentials.apiKey);
  if ("token" in credentials) {
    values.push(credentials.token);
    if (auth.type === "bearer" && auth.prefix)
      values.push(`${auth.prefix} ${credentials.token}`);
  }
  if ("username" in credentials) {
    const b64 = basicValue(credentials);
    values.push(credentials.password, b64, `Basic ${b64}`);
  }
  if ("accessToken" in credentials)
    values.push(credentials.accessToken, `Bearer ${credentials.accessToken}`);
  values.push(...Object.values(secretVariables(credentials)));
  try {
    values.push(...Object.values(authHeaders(definition, credentials, config)));
  } catch {
    // A header that does not render is not sent either.
  }
  values.push(...renderedBodies(streams, config));
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * The first-page bodies of POST streams as they are sent (ADR 0030 §4),
 * for streams whose body renders from the connection's values alone. A
 * body with window values differs per chunk: the connector redacts each
 * rendered body from its own errors (redactRenderedBody).
 */
function renderedBodies(
  streams: readonly Pick<CustomApiStream, "request" | "pagination">[],
  config: Record<string, unknown>,
): string[] {
  const values = stringValues(config);
  const bodies: string[] = [];
  for (const stream of streams) {
    const body = stream.request.body;
    if (body === undefined) continue;
    try {
      bodies.push(
        renderCustomApiBody(
          body,
          (template) => renderTemplate(template, values, (value) => value),
          firstPageParams(stream.pagination).bodyWrites,
        ),
      );
    } catch {
      // Needs window values: redacted per request by the connector.
    }
  }
  return bodies;
}

/** `text` without the rendered body of `built` (ADR 0030 §4). */
export function redactRenderedBody(text: string, built: BuiltRequest): string {
  return built.body !== undefined && built.body.length >= 4
    ? text.split(built.body).join(REDACTED)
    : text;
}

/**
 * Shortest secret value a next link loses an unrelated parameter for. By
 * name, a parameter that carries a secret is always stripped (below); by
 * value only from 8 characters, so a short secret ("10", "2024") does not
 * strip `after=10` or `year=2024`.
 */
const STRIPPED_SECRET_MIN_LENGTH = 8;

/** Query parameter names a stream's template fills from a secret variable. */
function secretQueryNames(
  definition: AuthInput,
  stream: Pick<CustomApiStream, "request"> | undefined,
): string[] {
  const secret = new Set(
    definition.variables.filter((v) => v.secret).map((v) => v.id),
  );
  if (!stream || secret.size === 0) return [];
  return Object.entries(stream.request.query ?? {})
    .filter(([, template]) => {
      try {
        return parsePlaceholders(template).some((ref) => secret.has(ref.name));
      } catch {
        return false;
      }
    })
    .map(([name]) => name);
}

/**
 * A next-page URL as it may be stored in a cursor (APIs that build next
 * links from the request echo what it carried). Stripped by name, whatever
 * the value: the API key query parameter and any query parameter the
 * stream fills from a secret variable. Stripped by value: any parameter
 * whose value is a secret of at least 8 characters. For a next_url page,
 * buildRequest uses the stored URL as is (the stream's query is not added
 * again) and adds the auth again, an API key query parameter included.
 */
export function stripCustomApiSecrets(
  url: string,
  definition: AuthInput,
  credentials: CustomApiCredentials,
  config: Record<string, unknown> = {},
  stream?: Pick<CustomApiStream, "request">,
): string {
  const parsed = new URL(url);
  const auth = definition.auth;
  if (auth.type === "api_key" && auth.placement === "query")
    parsed.searchParams.delete(auth.name);
  for (const name of secretQueryNames(definition, stream))
    parsed.searchParams.delete(name);
  const secrets = new Set(
    customApiSecretValues(definition, credentials, config).filter(
      (value) => value.length >= STRIPPED_SECRET_MIN_LENGTH,
    ),
  );
  for (const [name, value] of [...parsed.searchParams])
    if (secrets.has(value)) parsed.searchParams.delete(name, value);
  return parsed.href;
}
