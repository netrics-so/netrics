# 0030 — Read-only POST and GraphQL in the custom API connector

Status: accepted (2026-11-23, milestone 13.1; owner go on 2026-11-23). Revises the "no POST" line
of milestone 13's out-of-scope list. Builds on ADR 0027 (the custom API
connector) and leaves its credential, egress and redaction rules unchanged.

## Context

Milestone 13 shipped a custom API connector that sends GET requests only.
Several APIs a developer wants on a dashboard read data through POST:

- GraphQL APIs take every query, reads included, as a POST body (Railway,
  GitHub's GraphQL API, many internal services).
- Query APIs take the query in the body (PostHog's query endpoint, search
  and reporting APIs).

GET-only keeps these out of reach unless netrics ships a native connector
for each. Native connectors remain the better product for common sources
(milestone 13.1 adds them for Railway and PostHog), but the long tail of
internal and niche APIs needs the generic path.

The risk of POST is that a definition could change state at the provider:
create, delete or pay for something on each sync. netrics cannot tell a
read from a write by looking at a request, so the rule must come from what
a definition may express and from what the person connecting confirms.

## Decision

### 1. A stream may send a fixed JSON body with POST

A stream's request gains `method: "GET" | "POST"` (default `GET`) and, for
POST, `body`: a JSON value of bounded size and depth. String leaves may hold
the same `{{ placeholder }}` names a query parameter may hold (variables,
window dates, page values), under the same document rules: secrets only in
auth headers, page placeholders only with a matching pagination type,
window placeholders only with a window. Placeholders fill whole string
leaves or parts of them; they never add keys, change structure or produce
numbers or booleans from text. The body is sent as
`application/json; charset=utf-8`. No other method and no other content
type is accepted.

### 2. GraphQL is a body shape, with a read-only guard

`body.kind: "graphql"` holds `query` and `variables`. The definition check
parses the query with a GraphQL parser and refuses it unless it is exactly
one `query` operation: no `mutation`, no `subscription`, no second
operation. Variables follow rule 1. Errors in the response's `errors`
array fail the run like an HTTP error, with the message redacted as in
ADR 0027 §4.

The checked operation is the one sent, on every request:

- `query` is a literal: it may hold no placeholder, and nothing (pagination
  included) writes into it. Substitutions in a GraphQL body reach only
  leaves under `variables`.
- The body has exactly the keys `query` and `variables`; no
  `operationName` or `extensions`.
- A GraphQL stream may not set the URL query parameters `query`,
  `operationName`, `variables` or `extensions`, by itself, by its auth
  method or by pagination, because some servers let URL parameters override
  the body.

A plain JSON body (`body.kind: "json"`) has no such guard. The builder
requires the definition's author to confirm "this request only reads data",
stores that confirmation with the version, and shows the method and body on
the connection page to everyone who can see the connection. The
documentation says plainly that netrics cannot verify it.

The confirmation is checked by the server before any JSON-body POST leaves
it, not only when a version is saved: the builder's test request for an
unsaved draft carries the confirmation for that exact request (a hash of
method, path, query and body template), and the server refuses to send a
draft request whose hash does not match. Editing the request clears the
confirmation.

### 3. Pagination through the body

The existing pagination types work unchanged where they set query
parameters. Two additions place page values in the body instead:
`cursor` pagination may name a body path for the next cursor (GraphQL
`after` variables), and `offset` pagination may name body paths for offset
and limit. A body path must point at an existing leaf of the template (in a
GraphQL body, under `variables`); the leaf's template value is replaced, not
templated, so its type follows the page value.

The first page often needs no cursor. A cursor body path therefore names
what the first request sends: `firstPage: "null"` (the leaf is JSON
`null`, the default) or `firstPage: "omit"` (the key is removed). Later
pages write the cursor the previous response returned. An empty string is
never sent as a cursor.

### 4. Everything else stays as in ADR 0027

Credentials stay bound to the environment host, redirects stay same-host,
the response size, decompression and time limits stay, and redaction covers
the rendered body as it covers rendered headers. A redirect of a POST is
followed only for 307 and 308, keeping method and body, and only to the
same host; 301, 302 and 303 fail the run instead of turning into a GET.

### 5. Schema version 2

These fields need definition schema version 2. Version 1 documents upgrade
to version 2 by changing only the schema version: an absent `method` means
GET, and neither the upgrade nor the parser writes defaults into the stored
or normalized document, so an upgraded document is no larger than the
original apart from the version number and fits the same size limit. A
boundary-sized version 1 fixture proves it. A host that only knows
version 1 refuses a version 2 document as it refuses any unknown version.
The connector SDK exports both the parser and the upgrade.

## Consequences

- Railway, PostHog's query API and internal GraphQL services become
  connectable without code; native connectors still ship for the common
  ones.
- A JSON-body POST definition can, if its author lies or errs, call a
  writing endpoint on every sync. The confirmation, the visible request on
  the connection page and the workspace-member-only authoring limit the
  damage; it is not prevented.
- The builder gains a method choice, a body editor with placeholder hints,
  and a GraphQL mode with the read-only check.
- Contract tests cover the GraphQL guard (mutation, subscription, several
  operations, fragments, placeholders or pagination in `query`, overriding
  URL parameters), the confirmation check on draft test requests,
  placeholder rules in bodies, body pagination including the first page,
  the size of upgraded version 1 documents, and POST redirects.

## Alternatives considered

- **Keep GET-only, native connectors only.** Safe, but every internal or
  niche GraphQL API needs code in netrics.
- **Allow any method.** PUT, PATCH and DELETE have no read use that POST
  does not cover; refused.
- **Allowlist of known read endpoints per provider.** Unmaintainable for
  internal APIs, and a native connector is the better answer for known
  providers.
