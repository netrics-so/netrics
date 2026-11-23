// The read-only confirmation of a draft test request (ADR 0030 §2). A JSON
// body has no operation guard: before the builder's test sends one, its
// author confirms "this request only reads data" for exactly that request.
// The confirmation is a hash of everything that shapes the request, computed
// here on the server; a test whose confirmation does not match is refused
// before anything is sent. Changing any part changes the hash, which clears
// the confirmation.

import type { CustomApiDraftDefinition } from "@netrics/contracts";
import {
  customApiBodyStringLeaves,
  parsePlaceholders,
} from "@netrics/connector-sdk/custom-api";

import { canonicalSha256 } from "./canonical-json.js";

function placeholderNames(template: string): string[] {
  try {
    return parsePlaceholders(template).map((ref) => ref.name);
  } catch {
    return [];
  }
}

/**
 * The confirmation a draft test of `definition`'s stream needs, or null
 * when it needs none (GET, or a GraphQL body: the operation guard holds).
 * Covers the environment's base URL, the stream's method, path, query
 * parameters, header templates, body template and pagination rule, the
 * auth configuration (type and placement, never a credential value) and
 * the values of the non-secret variables the request uses. Secret values
 * are never part of it.
 */
export function draftReadOnlyConfirmation(
  definition: CustomApiDraftDefinition,
  environmentId: string,
  values: Readonly<Record<string, string>>,
): string | null {
  const { request, pagination } = definition.stream;
  const body = request.body;
  if (request.method !== "POST" || body?.kind !== "json") return null;
  const environment = definition.environments.find(
    (entry) => entry.id === environmentId,
  );
  const plain = new Set(
    definition.variables.filter((v) => !v.secret).map((v) => v.id),
  );
  const templates = [
    request.path,
    ...Object.values(request.query),
    ...Object.values(request.headers),
    ...Object.values(definition.auth.headers ?? {}),
    ...customApiBodyStringLeaves(body).map((leaf) => leaf.value),
  ];
  const used = [
    ...new Set(templates.flatMap(placeholderNames).filter((n) => plain.has(n))),
  ].sort();
  return canonicalSha256({
    confirmation: "custom-api-read-only/1",
    baseUrl: environment?.baseUrl ?? null,
    method: request.method,
    path: request.path,
    query: request.query,
    headers: request.headers,
    body: body.value,
    pagination,
    auth: definition.auth,
    variables: Object.fromEntries(
      used.map((name) => [
        name,
        Object.hasOwn(values, name) ? values[name]! : null,
      ]),
    ),
  });
}
