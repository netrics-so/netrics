# 0027 — The custom API connector

Status: accepted (2026-11-20; [#804](https://github.com/netrics-so/netrics/issues/804),
milestone 13). Builds on ADR 0022 (typed datasets), ADR 0026 (dataset
contract v1) and the egress hardening of #814. Section 6 (custom OAuth) was
added with [#805](https://github.com/netrics-so/netrics/issues/805).

## Context

A workspace member describes a JSON HTTP API in a definition document
(schema version 1, `@netrics/connector-sdk/custom-api`) and connects it
several times. One bundled connector, `custom-api`, runs every definition.
Unlike a bundled connector its manifest is not fixed: datasets, refresh
interval, configuration and allowed hosts come from the definition version
and the environment a connection pins. The definition is user data, so it
must not be able to send credentials elsewhere or reach the private network.

## Decision

### 1. A manifest per connection, not a registry entry

`custom-api` is not registered in the `ConnectorRegistry`. Migration 0085
inserts only its catalog row (the connections foreign key needs it). The
server resolves every connection-scoped connector through
`connectorFor(registry, connection)` (`apps/server/src/custom-api/connectors.ts`):
bundled connectors come from the registry, a custom-api connection gets a
connector built from its pinned version and environment
(`createCustomApiConnector`, validated with `assertManifestCompatible`),
cached per version and environment (versions are immutable). A call site
that still asks `registry.get("custom-api")` gets nothing and fails as "no
connector registered", instead of running with a wrong manifest.

The effective manifest (`customApiManifest`): version `1.0.<definition
version>`, one dataset per stream with the version's dataset version,
`minRefreshIntervalSeconds` from the definition, `backfillDays` the largest
window backfill, `outboundDomains` the environment host, the OAuth token and
revoke hosts and the image hosts, and the non-secret variables as the
configuration schema. Generic connection routes refuse `custom-api`
(`custom_api_requires_definition`); connections are created from a
definition, which pins the version and environment.

### 2. Credentials are bound to the environment host

The credential envelope is `{ host, …credentials, variables }`: `host` is
the environment's host when the credentials were entered. The connector
refuses to send them when the pinned environment's host differs
(`hostChanged`), so changing a connection's environment needs every secret
again: the credentials and every secret variable, checked against the new
environment before the pin changes. Nothing stored is carried to another
host. Auth is applied only to URLs on the environment host
(`applyCustomApiAuth`); a next page link on another host fails the run
before any request goes there. Secret variables are usable only in the
definition's auth headers.

The same rule holds for bundled connectors whose manifest names
`configuredHosts` (SDK 0.2.20, the PostHog connector's self-hosted host,
#884 review): the envelope records the configured hosts the credentials
were entered for (`$configuredHosts`), the runtime refuses a call whose
configuration names other hosts while it carries credentials, and the
server keeps a connection's configured hosts fixed, so another host is a
new connection with credentials entered for it. It is this decision
applied to configuration-named hosts, so it needs no ADR of its own.

A connector whose every auth strategy is `none` carries nothing a host
could receive, so its configured hosts may change (SDK 0.2.21, #874): the
HTTP check connector's URLs (`configuredHosts: ["checks[].url"]`, a URL in
each item of the `checks` list) are edited like any setting. Should it gain
credentials, its hosts become fixed by this rule again.

### 3. Egress

The server sets the custom API egress values in one place
(`customApiEgress`): redirects only to the same scheme, host and port
(`redirects: "same-host"`; an allow-list hop would keep custom headers such
as an API key on another origin), 10 MiB per response, 50 MiB decompressed,
30 s per request, DNS pinning, and the self-host private hosts
(`NETRICS_CUSTOM_API_PRIVATE_HOSTS`). Only the custom-api connector gets the
private hosts; `callOptionsFor` strips them from bundled connectors' calls.
The executor refuses to run `custom-api` without these options (same-host
redirects and a redaction set), so a call site that forgot `callOptionsFor`
fails loudly.

The HTTP check connector (#874) requests URLs a user entered too, so it
gets its own values from the same place (`httpCheckEgress`): same-host
redirects (the runtime also forces them for every `<key>[].<item>`
configured URL), 1 MiB per body (decoded too), 10 s per request (a check's
own limit only lowers it), and the same self-host private hosts
(`NETRICS_CUSTOM_API_PRIVATE_HOSTS`). On the hosted service, where that
list is empty, a check reaches public addresses only.

Amendment (#892): bundled connectors with `configuredHosts` (a self-hosted
PostHog) get a separate self-host list, `NETRICS_CONNECTOR_PRIVATE_HOSTS`,
with the same entries and checks. `callOptionsFor` passes it as
`connectorPrivateHosts` to those connectors only (never to `custom-api` or
`http-check`, never from a caller's base options), and the runtime applies
it only to the hosts the connection's configuration names, never to the
manifest's `outboundDomains`. The address check still runs on every
resolved address (metadata never, DNS pinning unchanged), and §2 holds:
credentials stay bound to their configured host, so a listed host never
receives credentials entered for another. The hosted service never sets it.

### 4. Redaction

The runtime redacts the connection's credential values from errors, check
messages and connector logs. Values derived from them that the connector
sends (the basic-auth base64, `"<prefix> <token>"`, rendered auth headers)
are added through `ExecuteOptions.redactValues`. Connector errors carry a
status, the stream key and a redacted URL (API key and cursor values
replaced), never a response body or header value.

### 5. Runs, limits and failures

Each sync call sends one request and returns that page's dataset pages; the
opaque cursor (`cav1.` + base64url JSON) carries stream, chunk, page and the
run's counters. A run reads at most 200 pages and 100,000 records in 30
minutes: reaching one throws `CustomApiLimitError`, which the engine records
as error class `budget` (what earlier pages committed stays; a snapshot
refresh that did not complete replaces nothing). A cursor of an earlier run
(another sync window) starts over from the first stream with fresh
counters, so no run reports a stream done that it did not read for its
window. Next page URLs are stored in the cursor without the API key query
parameter or any other secret value; auth is applied again per request. `401`/`403`
throw `CustomApiAuthError` (error class `auth`, the connection needs
attention); a `429` with `Retry-After` is a `RateLimitedError`. The engine
recognises the custom errors by name, which the runtime's redaction keeps.

### 6. Custom OAuth

ADR 0012 treats OAuth providers as trusted host code: endpoints in the
server, the client ID and secret in instance configuration, and on the
hosted service an OAuth app that netrics owns. That rule cannot apply to a
custom API: netrics cannot own apps for APIs it does not know. The user
registers their own OAuth app at their provider and enters its redirect URI
(`<WEB_ORIGIN>/oauth/custom/callback`, `GET …/custom-api/oauth`), and the
builder says so.

- **Endpoints are connection data.** Custom OAuth reuses ADR 0012's tables,
  token service and callback route under the provider id `custom`. The
  provider is built per call from the connection's definition, read through
  `loadConnectionCustomApiDefinition` (the pinned version, or a builder
  draft's unsaved one), and from its envelope: authorize, token and revoke
  URL, scopes, PKCE (S256, on by default), extra authorize parameters (never
  templated) and the client authentication (form body or HTTP basic). The
  URLs are https and canonical (C-G1); token and revoke calls go through the
  custom API egress to those hosts only, with no redirect, and with the
  self-host private hosts. The browser, not the server, visits the
  authorize URL.
- **Client ID and secret live in the envelope**, next to the refresh token:
  `{ host, hosts, clientId, clientSecret, refreshToken }`, bound to the
  connection like every envelope. `host` and `hosts` record the API host
  (with port) and every credential host (API, token and revoke hosts) they
  were entered for. Every use checks them against the connection's current
  definition: when a later version (or a draft edit) names other hosts,
  nothing is sent, not the client secret, a refresh token or a cached
  access token; the connection is `auth_failed` ("…entered for another API
  host…") until the client is entered again, which seals it for the new
  hosts. The access token is cached in `connection_oauth` as
  for Google. A draft's secrets follow the draft rule: they and the grant
  carry over while the hosts (environment, token, revoke), the login method
  and the client stay the same; any change drops the grant (revoked at the
  provider when it had a refresh token). An active connection keeps its
  environment, but its client can be replaced (PATCH `credentials:
{ clientId, clientSecret }`): client credentials request a token with the
  new client first and keep the old one when it is refused; an
  authorization-code secret rotation with the same client ID keeps the
  refresh token (providers keep grants across secret rotation); a new
  client ID revokes the old grant (best effort) and asks for a new sign-in
  (`needs_reauthorization`), keeping the connection's id, history and
  bindings. A sign-in is bound to the token endpoint and client ID it
  started with (a hash in the state row's otherwise unused nonce); a code
  is never exchanged with another client.
- **Client credentials.** A connection requests a token at creation (a
  refused client is refused with "The token endpoint refused the client ID
  or client secret…", and nothing is stored), runs the connector check with
  it and stores the grant with the connection. A draft mints its first
  token on its first test request. An expired token is replaced by a new
  `client_credentials` request under the grant's row lock; a token endpoint
  that refuses the client marks the connection `auth_failed` with that
  message, since only new client credentials help. A client-credentials
  token without the definition's scopes is refused the same way ("…did not
  grant every scope…"), never as a reauthorization, which such a client
  cannot do.
- **Provider tolerance.** Custom providers vary: granted scopes are split on
  spaces and commas (GitHub, Slack), and a missing or non-bearer
  `token_type` (Slack: `bot`) is accepted, since netrics always sends the
  token as a bearer token. Google keeps the strict checks.
- **Authorization code and the `authorize` purpose.** The connection (or
  draft) exists before its first grant because it holds the client
  credentials, which neither `connect` (no connection yet) nor
  `reauthorize` (a grant exists) describes: `oauth_authorizations.purpose`
  gains `authorize` (migration 0089). The callback reads the connection's
  current definition and envelope again, exchanges the code (with the PKCE
  verifier when PKCE is on), and stores the grant; an active connection then
  finishes its setup and starts its backfill in the same transaction, a
  draft stores the grant only and the browser returns to the builder
  (`?draft=<id>`). A grant without a refresh token ends with its access
  token (`needs_reauthorization`, `invalid_grant`).
- **The account id is generated** (`custom:<uuid>`): a custom provider has
  no OpenID account endpoint in general. No ID token is verified and no
  nonce is sent; the account is unique to the grant and kept across
  reauthorizations, so ADR 0012's shared-grant rules never find another
  holder and the grant-liveness refresh is not needed.
- **Revocation.** Deleting a connection revokes its refresh token at the
  definition's revoke URL after commit (RFC 7009, best effort); without a
  revoke URL nothing is sent and the answer points at the authorize URL's
  origin. A client-credentials grant has nothing to revoke. A builder draft
  is revoked before it is deleted; an expired draft with a grant is left to
  a worker job (`custom_api.draft_expired`, queued by the scheduler) that
  revokes and then deletes it, because the scheduler holds no credential
  keyring. The plain prune removes such a draft only when it is twice as
  old.

## Consequences

- Every connection-scoped lookup in the server goes through `connectorFor`;
  new code that reads a connection's manifest must too.
- A definition version that a later, stricter schema refuses leaves its
  connections without a connector ("no connector registered") until they are
  moved to a valid version.
- The SDK's connector contract tests accept connectors with datasets only
  and opaque cursors (`cursorOrder: "changing"`).
