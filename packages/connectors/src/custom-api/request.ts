// Builds one custom API request: URL from the environment's base URL and the
// stream's templates, pagination parameters, headers, and the auth of the
// definition. Credentials only ever go to the environment host.

import {
  renderTemplate,
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

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  /** The URL with the API key and cursor values (every query value of a next URL) replaced. */
  redactedUrl: string;
}

const REDACTED = "[redacted]";

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
  /** next_url pages: used as is after the host check. */
  nextUrl?: string;
}): BuiltRequest {
  const { definition, stream, environment, credentials } = input;
  checkBinding(environment, credentials);
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
    url: url.href,
    headers,
    redactedUrl: `${redacted.origin}${redacted.pathname}${redacted.search.replaceAll("%5Bredacted%5D", REDACTED)}`,
  };
}

/**
 * Values the host adds to its redaction set besides the stored credential
 * values: the basic "user:pass" base64 and "Basic <b64>", "<prefix> <token>",
 * rendered auth.headers values, secret variable values.
 */
export function customApiSecretValues(
  definition: AuthInput,
  credentials: CustomApiCredentials,
  config: Record<string, unknown> = {},
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
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * Shortest secret value a next link loses a parameter for, as the runtime's
 * redaction: a secret variable such as "10" must not strip `after=10`, and
 * values this short are never redacted anywhere either.
 */
const STRIPPED_SECRET_MIN_LENGTH = 4;

/**
 * A next-page URL as it may be stored in a cursor: without the API key
 * query parameter and without any parameter whose value is a secret of at
 * least 4 characters (APIs that build next links from the request echo
 * them). buildRequest adds the auth again on every request.
 */
export function stripCustomApiSecrets(
  url: string,
  definition: AuthInput,
  credentials: CustomApiCredentials,
  config: Record<string, unknown> = {},
): string {
  const parsed = new URL(url);
  const auth = definition.auth;
  if (auth.type === "api_key" && auth.placement === "query")
    parsed.searchParams.delete(auth.name);
  const secrets = new Set(
    customApiSecretValues(definition, credentials, config).filter(
      (value) => value.length >= STRIPPED_SECRET_MIN_LENGTH,
    ),
  );
  for (const [name, value] of [...parsed.searchParams])
    if (secrets.has(value)) parsed.searchParams.delete(name, value);
  return parsed.href;
}
