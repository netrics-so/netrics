# Custom API connector

Reads a JSON HTTP API that netrics has no bundled connector for, from a
**custom API definition** a workspace member writes: environments (named
base URLs), the login method, connection variables, and one stream per
request pattern, each with pagination, record selection, typed fields and an
optional time window. Every stream becomes a typed source dataset (dataset
contract v1, [ADR 0026](../decisions/0026-dataset-contract-v1.md)) like the
datasets of bundled connectors. Design: [ADR 0027](../decisions/0027-custom-api-connector.md).

> Status: milestone 13. Definitions, their versions and connections with the
> login methods none, API key, bearer token and HTTP basic work through the
> API. OAuth (client credentials, authorization code), the builder UI and
> images follow.

## Definitions and connections

A definition holds no secrets. Every change saves a new version; a
connection pins one version and one of the definition's environments, and
holds:

- the values of the definition's connection variables (`variables`), stored
  as the connection's configuration;
- the values of its secret variables (`secretVariables`), which only the
  definition's auth headers may use;
- the credentials of its login method: `apiKey`, `token`, or `username` and
  `password`.

Secret variables and credentials are stored encrypted with the connection
and never returned. They are bound to the environment's host: changing a
connection's environment (`PATCH …/connections/:id` with
`customApiEnvironmentId`) needs the credentials again, unless the login
method is none and the definition has no secret variables.

Create a connection with
`POST /v1/workspaces/:workspaceId/custom-api/definitions/:definitionId/connections`
(`connections:create`). netrics checks the credentials with one request
before it stores anything, then queues the connection's backfill. The
generic connection routes refuse `custom-api` with
`custom_api_requires_definition`.

## What is supported

- **Login**: none; API key in a header or query parameter; bearer token
  (header name and prefix configurable, default `Authorization: Bearer`);
  HTTP basic. A `401` or `403` marks the connection "needs attention" with a
  message that says what to do.
- **Pagination**: none; page number; offset and limit; cursor from a body
  path; next URL from a body path or the `Link` header. A next URL must stay
  on the API host. A stream ends on an empty page, a page shorter than the
  page size, a missing or repeated cursor, or a missing next URL.
- **Records**: a dotted path (`data`, `meta.items`, `items[0].rows`) to a
  list or a single object.
- **Fields**: every dataset type. A value that does not fit its field's type
  becomes empty in a nullable field and skips the record otherwise; the run
  goes on, and its log counts skipped records and emptied values per field.
- **Windows**: date or timestamp windows with a step, a lookback for
  incremental runs and a backfill depth, in the definition's time zone.

## Bounds

Each request may answer at most 10 MiB (50 MiB once decompressed) within
30 seconds. A run reads at most 200 pages and 100,000 records in at most
30 minutes; a run that reaches one of these ends as incomplete (error class
`budget`): what earlier pages stored stays, and the next run starts the
stream again. JSON nested deeper than 64 levels is refused.

Requests go out only through the egress guard: https only, public addresses
only, redirects only to the same host (with credentials never sent to
another host), and the DNS answer checked once is the one connected to.

## Instance settings

| Setting                                  | Default | Meaning                                                |
| ---------------------------------------- | ------- | ------------------------------------------------------ |
| `NETRICS_CUSTOM_API_MAX_DEFINITIONS`     | 50      | definitions per workspace (archived ones don't count)  |
| `NETRICS_CUSTOM_API_MAX_STREAMS`         | 20      | streams per definition (never above 20)                |
| `NETRICS_CUSTOM_API_MAX_CONNECTIONS`     | 100     | custom API connections per workspace                   |
| `NETRICS_CUSTOM_API_MIN_REFRESH_MINUTES` | 15      | the shortest refresh interval a connection may request |

Self-hosted only: `NETRICS_CUSTOM_API_PRIVATE_HOSTS` lets custom APIs reach
named hosts or address ranges on your own network (never metadata
addresses). It is off by default and never set on the hosted service; only
the custom API connector receives it, bundled connectors never do. See
[deploy/compose/README.md](../../deploy/compose/README.md).
