# 0027 — The custom API connector

Status: accepted (2026-11-20; [#804](https://github.com/netrics-so/netrics/issues/804),
milestone 13). Builds on ADR 0022 (typed datasets), ADR 0026 (dataset
contract v1) and the egress hardening of #814. The OAuth section follows with
custom OAuth (milestone 13, group C-G4).

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
(`hostChanged`), so changing a connection's environment needs the
credentials again (checked against the new environment before the pin
changes). Auth is applied only to URLs on the environment host
(`applyCustomApiAuth`); a next page link on another host fails the run
before any request goes there. Secret variables are usable only in the
definition's auth headers.

### 3. Egress

The server sets the custom API egress values in one place
(`customApiEgress`): redirects only to the same scheme, host and port
(`redirects: "same-host"`; an allow-list hop would keep custom headers such
as an API key on another origin), 10 MiB per response, 50 MiB decompressed,
30 s per request, DNS pinning, and the self-host private hosts
(`NETRICS_CUSTOM_API_PRIVATE_HOSTS`). Only the custom-api connector gets the
private hosts; `callOptionsFor` strips them from bundled connectors' calls.

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
(another sync window) restarts its stream with fresh counters. `401`/`403`
throw `CustomApiAuthError` (error class `auth`, the connection needs
attention); a `429` with `Retry-After` is a `RateLimitedError`. The engine
recognises the custom errors by name, which the runtime's redaction keeps.

## Consequences

- Every connection-scoped lookup in the server goes through `connectorFor`;
  new code that reads a connection's manifest must too.
- A definition version that a later, stricter schema refuses leaves its
  connections without a connector ("no connector registered") until they are
  moved to a valid version.
- The SDK's connector contract tests accept connectors with datasets only
  and opaque cursors (`cursorOrder: "changing"`).
