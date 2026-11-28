# netrics — Architecture

> Status: agreed foundation. This document records the architecture to build,
> the public/private boundary, deployment model, and decisions that should stay
> stable while the first product is implemented. The build order and completion
> gates live in the [v1 milestone roadmap](./milestones/README.md).

## Guiding decisions

1. **Complete self-hosted product.** All user-facing product capabilities are
   public and run without a license key. SaaS sells operation and convenience.
2. **Public modular monolith.** The initial system lives in one public monorepo
   and produces a small number of independently scalable processes.
3. **Private cloud control plane.** Billing, provisioning, managed domains,
   support tooling, and marketing live in a separate private repository.
4. **Identical application images.** SaaS and self-hosted installations run the
   same versioned images published to GHCR.
5. **PostgreSQL first.** PostgreSQL is the only mandatory stateful dependency.
   Redis, TimescaleDB, Kafka, and Kubernetes require measured justification.
6. **Deployment-scoped connector code.** Connector implementations are installed
   and reviewed per deployment. Tenant connections hold configuration and
   credentials; tenants do not install arbitrary executable packages.
7. **Infrastructure and releases are code.** Pull requests show Terraform plans;
   merges apply infrastructure changes. Application merges publish immutable
   images and deploy them through a separate release workflow.

## Product boundaries

### Public core

The public system owns:

- Authentication integration, users, workspaces, memberships, and roles
- Projects
- Connector catalog and tenant connections
- Credential storage and OAuth callbacks
- Synchronization, normalization, and metric storage
- Derived metrics
- Dashboards, widgets, playlists, devices, and pairing
- Renderer and Apple TV support
- Alerts and notification channels
- Audit log and instance administration
- Public APIs, connector SDK, and Docker Compose deployment

### Private cloud control plane

The private system owns:

- SaaS workspace provisioning and lifecycle automation
- Stripe billing and subscription decisions
- Usage aggregation and hosted quota configuration
- Managed domains and certificates
- Managed OAuth application configuration
- Support tools and fleet health
- Marketing and campaign systems

Private services use versioned public administration APIs and lifecycle events.
They never access public-core database tables directly.

The core supports generic operator-configured limits. Self-hosting defaults to
unlimited; the hosted control plane sets limits derived from a subscription.

## Repositories

### Public `netrics` monorepo

```text
netrics/
  apps/
    web/                    Next.js product application
    server/                 API, worker, scheduler entry points
    renderer/               Playwright snapshot worker (not yet; see ADR 0007)
    netrics-tv/             Native SwiftUI app for Apple TV (netrics TV)
  packages/
    domain/                 Domain rules independent of transport/storage
    database/               PostgreSQL access and migrations
    contracts/              OpenAPI and shared transport schemas
    connector-sdk/          Public TypeScript connector contract
    connector-runtime/      Connector execution and credential boundary
    connectors/             First-party and reviewed community connectors
    notification-sdk/       Notification channel contract
    ui/                     Shared product UI
  deploy/
    compose/                Supported self-hosted deployment
  docs/
```

Use pnpm workspaces. Add a task runner only when build performance warrants it.
The monorepo produces separate images without requiring separate repositories.

### Private `netrics-cloud` repository

```text
netrics-cloud/
  apps/
    billing/
    operations/
    provisioning/
  infrastructure/
    terraform/
      railway/
      dns/
      object-storage/
      monitoring/
    railway/
      api.env.op
      web.env.op
      worker.env.op
      scheduler.env.op
      renderer.env.op
    scripts/
    release/
      production.yaml
  .github/workflows/
```

SaaS topology and credentials remain private. Generic deployment documentation
and Docker Compose remain public.

## Technology stack

| Concern        | Initial choice                               | Reason                                                     |
| -------------- | -------------------------------------------- | ---------------------------------------------------------- |
| Language       | TypeScript                                   | One language for product, SDK, and connectors              |
| Web            | Next.js + React                              | Product UI, dashboard editor, render routes                |
| API            | Fastify + schema-based OpenAPI               | Small, explicit, fast, and suitable for a solo team        |
| Validation     | JSON-compatible runtime schemas              | Shared contracts and future language-neutral runners       |
| Database       | PostgreSQL                                   | Tenant data, observations, jobs, rule state, and audit log |
| Queue          | PostgreSQL-backed durable jobs               | Avoid a mandatory Redis service initially                  |
| Authentication | Embedded Better Auth behind a narrow adapter | Simple self-hosting with a broad TypeScript feature set    |
| Renderer       | Playwright                                   | Reuse the real dashboard UI for device snapshots           |
| TV             | SwiftUI for tvOS                             | Native pairing, caching, playlist, and device lifecycle    |
| Object storage | Local volume or S3-compatible API            | Snapshots and future exports without provider coupling     |
| API style      | REST + OpenAPI; SSE where useful             | Public clients, devices, and generated SDKs                |
| Deployment     | Docker Compose and Railway                   | Simple self-hosting and managed SaaS                       |

Use the current active Node.js LTS at implementation time and pin all production
toolchain versions.

### Deferred infrastructure

- **TimescaleDB:** add or offer it when observation volume or aggregation cost
  demonstrates a need. Keep the initial schema compatible with partitioning.
- **Redis:** add for specialized distributed rate limiting or queue pressure.
- **ClickHouse:** consider only for genuinely large analytical workloads.
- **Kubernetes:** no supported deployment until customer demand justifies its
  operational and documentation cost.

## Runtime architecture

```text
 browsers ───────► netrics-web ───────► netrics-api ───────► PostgreSQL
                         │                    │                    ▲
                         │                    │ enqueue jobs       │
 devices / tvOS ─────────┘                    ▼                    │
                                      netrics-worker ─────────────┘
                                             │
                                             ▼
                                      connector runtime
                                             │
                                             ▼
                                      external APIs

 netrics-scheduler ─────► durable jobs and scheduled rule evaluation

 netrics-renderer ──────► protected web render route ─────► object storage
       ▲                                                        │
       └──────────────── device snapshot requests ◄─────────────┘

 private cloud ─────────► public admin API / lifecycle events only
```

### Deployable processes

- **web** — Next.js user interface and protected dashboard render routes
- **api** — REST API, authentication integration, pairing, and administration
- **worker** — connector syncs, backfills, ingestion, alert evaluation, and
  notification delivery; horizontally scalable
- **scheduler** — claims due connections and scheduled rules; exactly one
  active replica initially
- **renderer** — Playwright screenshot jobs; optional in self-hosted Compose.
  Parked until snapshots are scheduled (ADR 0007): no app, image or service
  exists today.

The API, worker, and scheduler may use one server image with different commands.
This reduces build and release coordination while preserving independent
scaling.

## Domain and tenancy

### Hierarchy

```text
installation
└── workspace (tenant/security/billing boundary)
    ├── memberships and roles
    ├── projects
    ├── connections
    ├── dashboards
    ├── alerts
    ├── playlists
    └── devices
```

A connection belongs to one workspace and may optionally belong to a project.
Dashboards can combine any connections visible within their workspace.

### PostgreSQL isolation

Tenant-owned tables carry `workspace_id`. PostgreSQL Row-Level Security is a
defense-in-depth boundary:

- The application role has neither superuser nor `BYPASSRLS` privileges.
- Tenant tables use `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
- Every request and job sets workspace context inside its transaction.
- Scheduler-wide queries use a separate, narrowly privileged role and emit jobs
  containing an explicit workspace ID.
- Integration tests attempt cross-workspace access through API and worker paths.
- Private cloud services cannot connect to this database.

RLS complements application authorization; it does not replace permission
checks for owner, admin, editor, and viewer actions.

Deleting a workspace ends all access in one transaction and removes the data
in a background job; every tenant transaction takes a shared lock that the
deletion takes exclusively, so no work crosses it (ADR 0029). What an
operator should know is in the self-hosting guide
(`deploy/compose/README.md`, "Deleting a workspace").

## Connector architecture

### Artifact versus connection

A **connector artifact** is reviewed and installed once in a deployment. A
**connection** is a workspace-scoped instance containing credentials,
configuration, selected resources, and synchronization state. Many connections
may use the same artifact.

The hosted marketplace presents installation as an immediate user action, but
reviewed connector code is already present in the deployed worker image. The
action creates a connection; it does not mutate the worker filesystem.

### Connector contract

The TypeScript SDK exposes a small versioned contract:

```ts
interface Connector {
  manifest: ConnectorManifest;
  check(context: ConnectionContext): Promise<CheckResult>;
  discover(context: ConnectionContext): Promise<Resource[]>;
  sync(context: SyncContext, request: SyncRequest): Promise<SyncResult>;
}
```

The manifest declares:

- Stable connector ID, version, and compatible SDK versions
- Marketplace metadata and documentation
- Authentication strategies and credential schemas
- Configuration schema
- Metrics, units, dimensions, and aggregation semantics
- Minimum refresh interval and backfill support
- Declared outbound domains
- Expected quota and rate-limit behavior
- Optionally, translations of its texts (SDK 0.2.6, see below)
- Optionally, a catalogue `category` (`seo`, `web`, `apps`, `ads`, `revenue`
  or `other`) and a `brandColor` (`#rrggbb`) for its icon tile (SDK 0.2.7)

`sync` receives a time range or cursor and returns normalized observations plus
the next cursor. Connectors receive no direct database, queue, or internal API
access.

The cursor is opaque to the platform. The host stores the `nextCursor` a
connector returns and hands it back unchanged as `cursor` in a later request;
it never rewrites, migrates or interprets its content. The connector owns its
shape and versioning: a connector that changes its format must still read, or
deliberately restart from, every shape it ever returned (a version prefix
helps), because a stored cursor survives connector upgrades. That includes
items a connector parks in its cursor, such as a report that is not published
yet. The host touches a cursor in one narrow way only: a non-final page whose
`nextCursor` equals the request's cursor is a contract violation. A final
result without a `nextCursor` clears the stored cursor.

The window is the host's, kept apart from the cursor (SDK 0.2.15, #758). An
incremental run's `from` is the `nextFrom` of the last successful run's final
result (`connection_state.next_from`); a final result without one makes the
next window start at its own `to`. Without a stored one the last success
stands in, and for a connection that never succeeded the last 24 hours. A connector that re-reads recent days returns
their start as `nextFrom` (App Store Connect sales, Apple Ads, Search Console
and Vercel return their lookback, the demo connector the day containing `to`).
`nextFrom` may lie before the request's `from`, by at most the manifest's
`backfillDays` (one day without them), and never after its `to`. It must be a
well-formed instant on every page, and is ignored on a non-final page: a retry
after a failed page continues the same window, and the connector its own
checkpoint, so a connector's lookback is never later than where a run started
reading. Until SDK 0.2.15 the host read a
stored cursor that `Date.parse` accepted as the next window start, which
misread opaque cursors (`Date.parse("x 2024")` is a date); migration 0081
moved the window start of every stored ISO 8601 cursor to `next_from` and left
the cursor itself as it was.

Connector code can explain what it skipped or parked through `runtime.log`
(SDK 0.2.14): `debug`, `info`, `warn` and `error`, each with a short message
and optional scalar fields (`runtime.log?.info("report not published yet",
{ app, day })`). The host writes the lines to its log attributed to the
connection, the job (the run) and the attempt, and keeps secrets out: it drops
fields that are not scalars, have malformed names or names that contain
credential material, replaces the value of
every field whose name looks secret-like (secret, token, password, credential,
key, auth, cookie, session, signature) with `[redacted]`, strips the
connection's credential values and anything that looks like a bearer value,
JWT or PEM block from messages and string fields, truncates long strings and
keeps at most 20 fields per line and 200 lines per call. Lines written after
the call ended are dropped, and logging never fails a call. Connectors still
log only ids, dates, counts and statuses, never personal data or provider
payloads. `recordingLogger()` in `@netrics/connector-sdk/testing` records the
lines in tests.

A failure with a known reason can carry a reason code next to its English
message (SDK 0.2.18, #795): a failed check returns `code`, and connector code
throws `ConnectorError(message, code)`. A code is a fixed word (lowercase
words joined by `_` or `.`, at most 64 characters, such as
`acme.key_revoked`), never a secret or a part of the provider's answer; the
runtime refuses anything else. The host stores it as `sync_runs.error_code`
and returns it with the message (`errorCode` on a sync run and on a refused
credential check). The web app shows its own text for a code it knows
(`PROVIDER_MESSAGE_CODES` in `@netrics/domain`, English and German) and the
recorded message otherwise, so rewording a message breaks no translation.
Signed-key providers name the codes of their refusals the same way. The code
is optional: connectors that set none keep working.

A connector that meets a provider's request limit with a known reset (a 429
with `Retry-After` or a reset header, a daily quota) throws
`RateLimitedError(message, retryAt)` (SDK 0.2.16, #781). The runtime keeps the
class and `retryAt` across the credential boundary (it redacts the message as
for every error). The host does not count it as a failure: the run is
recorded with the error class `rate_limited` and what earlier pages
committed, the connection's failure count stays, an `outage` auth state
becomes `ok` again (the provider answered), and
`connection_state.rate_limited_until` holds the reset, bounded to between 5
seconds and a day ahead, plus up to a minute of jitter (a tenth of the wait
when that is shorter). Every waiting job of the connection moves to that
time, and the job itself waits without consuming a retry: a backfill, and a
run that committed pages, keep their window as a continuation, so they
resume from their checkpoint and hold the connection until they are done. A
job that starts while the limit holds waits too, without calling the
connector. The next successful run clears it. Connectors pace themselves
where the provider reports what is left (Vercel and Apple Ads stop a few
requests before the window runs out). A rate limit whose reset the provider
does not name stays an ordinary thrown error, retried with the queue's
backoff (App Store Connect's rolling hourly limit, Google Cloud Storage's
429 for Play reports).

Use JSON-compatible transport objects even inside TypeScript. A future isolated
runner can then use the same contract over JSON-RPC or another process boundary.

Credentials of a connector with `configuredHosts` are bound to the hosts
they were entered for (#884 review, ADR 0027 §2 for every connector): the
server records the configured hosts in the credential envelope when
credentials are entered (`bindCredentialHosts`), refuses a preview or save
that names other configured hosts than the connection's
(`connection_host_fixed`; another host is a new connection with its own
credentials), and the runtime refuses any call whose configuration names
other hosts than the bound ones while it carries credentials
(`CredentialHostMismatchError`, `connection.credentials_host_changed`)
before the connector runs; the sync worker records it as an authentication
failure (`auth_failed`), not an outage, and does not retry it. The
connector never sees the binding.

Connector code reaches the network only through `runtime.fetch`. It allows
https hosts from `outboundDomains`, and since SDK 0.2.20 the host names the
connection's own configuration gives under the manifest's `configuredHosts`
(a self-hosted PostHog, #873: a bare public name, no IP literal, port or
path, for that connection only). Since SDK 0.2.21 an entry `<key>[].<item>`
names a URL in each item of a config array (the HTTP checks' URLs, #874:
https, a full domain name or an IP address, any port and path); such URLs
follow redirects to the same scheme, host and port only, whatever the call
site passed. It refuses private and metadata addresses,
re-checks redirects and buffers the whole body within a size cap (10 MiB by
default) before the connector sees it. The guard (`createEgressFetch`) also:

- checks every resolved address at connect time and pins the first accepted
  DNS answer for a name for the rest of the connector call, so a name cannot
  rebind to another address; an answer with any refused address is refused
  whole and not pinned. IPv4-mapped and IPv4-compatible IPv6 forms are
  judged by their IPv4 address; NAT64, 6to4, Teredo and site-local ranges
  are refused;
- follows redirects only to allowed hosts (`redirects: "allowlist"`, the
  default) or only to the first URL's scheme, host and port
  (`"same-host"`), and drops `authorization`, `proxy-authorization` and
  `cookie` on any hop to another origin;
- bounds the decoded bytes of a `gzip`, `deflate`, `br` or `zstd` body
  (`maxDecompressedBytes`, by default the response cap); a body under any
  other content coding counts against the response cap;
- bounds each request, every redirect hop and the whole body read included,
  by `requestTimeoutMs` (60 s by default, the connector call budget). A
  timeout is an `EgressTimeoutError`: a retryable provider failure, not a
  broken connector;
- lets a connector lower the time and size limits for one request
  (`timeoutMs`, `maxResponseBytes`), skip reading a body (`discardBody`) and
  send `HEAD` (SDK 0.2.21, #874); an `EgressDeniedError` names its `reason`
  (`address`, `size`, `redirect_host`, …), so connector code can tell why
  a request was refused without reading the message;
- lets a self-hosted instance name private hosts or ranges custom API
  definitions and HTTP checks may reach (`NETRICS_CUSTOM_API_PRIVATE_HOSTS`,
  off by default and never set on the hosted service). It never widens the allowed hosts,
  and metadata and link-local addresses stay refused even when listed;
- lets a self-hosted instance name private hosts or ranges a bundled
  connector's configured hosts may resolve to (`NETRICS_CONNECTOR_PRIVATE_HOSTS`,
  #892, a self-hosted PostHog): the same entries, applied to the hosts a
  connection's configuration names under `configuredHosts` only, never to
  a manifest's `outboundDomains`. Off by default and never set on the
  hosted service.

A `ConnectorResponse` offers the body three ways:

- `text()`: decoded as UTF-8;
- `json()`: parsed as JSON;
- `bytes()`: the exact bytes as a `Uint8Array`, a fresh copy per call, for
  binary payloads such as gzip report files (since SDK 0.2.2). Over a future
  process boundary they travel as base64.

The cap bounds the compressed bytes, not what a connector inflates from them,
so a connector that decompresses sets its own bound. Use `node:zlib`
`gunzipSync` with `maxOutputLength` and turn the overflow into an error, which
fails the call as a retryable provider error (ADR 0014 uses 64 MiB):

```ts
import { gunzipSync } from "node:zlib";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;

function inflateReport(bytes: Uint8Array): string {
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_REPORT_BYTES }).toString(
      "utf8",
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`report exceeds ${MAX_REPORT_BYTES} bytes inflated`);
    }
    throw error;
  }
}

const report = inflateReport((await runtime.fetch(url)).bytes());
```

The testing kit (`@netrics/connector-sdk/testing`) builds fixture responses:
`fixtureResponse(status, body, headers)` for text or bytes and
`gzipFixtureResponse(status, content, headers)` for a gzip file of `content`.

SDK versions are additive within 0.2: a connector that declares `^0.2.0`
keeps loading on every 0.2.x runtime.

| SDK    | Adds                                                                 |
| ------ | -------------------------------------------------------------------- |
| 0.2.0  | The contract above; `token` and `none` auth strategies               |
| 0.2.1  | The `oauth2` auth strategy (ADR 0012)                                |
| 0.2.2  | The `signed-key` auth strategy and `bytes()` (ADR 0014)              |
| 0.2.3  | The `currency_minor` unit with a `currency` dimension (ADR 0014)     |
| 0.2.4  | `resourceNoun`: what the connector calls its resources (#208)        |
| 0.2.5  | Optional `resourceIcons` capability (resource icons, #226)           |
| 0.2.6  | Optional `translations` of the manifest's texts (ADR 0016, #257)     |
| 0.2.7  | Optional `category` and `brandColor` for the catalogue (#306)        |
| 0.2.8  | Optional `reviews` and `reviewWindows` in `SyncResult` (ADR 0019)    |
| 0.2.9  | Optional typed source datasets and dataset pages (ADR 0022)          |
| 0.2.10 | Optional durable dataset staging (ADR 0023)                          |
| 0.2.11 | Optional incremental staging, `datasetStaging.begin` (ADR 0024)      |
| 0.2.12 | Optional `receivedDatasets` in a final `SyncResult` (#666)           |
| 0.2.13 | Optional `freshnessStreams` and a final `freshness` (ADR 0025)       |
| 0.2.14 | Optional `runtime.log`, a structured connector logger (#638)         |
| 0.2.15 | Optional final `nextFrom`, the next window start (#758)              |
| 0.2.16 | `RateLimitedError` with `retryAt`: wait for a known reset (#781)     |
| 0.2.17 | Optional dataset field role "image"; dataset contract v1 (ADR 0026)  |
| 0.2.18 | Optional reason codes: `CheckResult.code`, `ConnectorError` (#795)   |
| 0.2.19 | Optional `discoversBeforeFirstSync`: names before a first run (#782) |
| 0.2.20 | Optional `configuredHosts`: a host the configuration names (#873)    |
| 0.2.21 | `configuredHosts` item URLs, `HEAD`, per-request limits (#874)       |
| 0.2.22 | Optional `previousCursor`: a fresh backfill's stored cursor (#893)   |
| 0.2.23 | Optional final `skipped`; a body failure's egress error has `status` |
| 0.2.24 | Optional `configOptions`: a config field chosen in a picker (#891)   |

Since SDK 0.2.24 a manifest may name string config fields that are chosen
from lists instead of typed (`configOptions`, per resource, at most
`maxSelected` in all). The connector's optional `configOptions(context,
{ key, resourceId }, runtime)` lists one resource's choices with the draft
config (one listing, never a request per choice) and reads what the field
chooses now into option values; the field stores the chosen values
separated by spaces. The host serves it to the setup and edit forms
(`POST …/connections/config-options` with draft credentials, `POST
…/connections/{id}/config-options` with the stored ones), inside the same
boundary as discovery: egress allowlist, configured-host binding, time
budget and redacted errors.

Since SDK 0.2.13 a manifest may group its metrics and datasets into
`freshnessStreams` (periodic, with the provider's time zone, or continuous),
and a done `SyncResult` reports per stream, and optionally per resource,
the last complete provider day (`dataThrough`) and when the next period is
expected (`expectedFrom`, `nextExpectedAt`). The host stores it in
`connection_freshness` with the run's success, never moves `dataThrough`
back, and schedules the next sync earlier when a period is due
([ADR 0025](./decisions/0025-data-freshness.md)). `expectValidFreshness`
in `@netrics/connector-sdk/testing` checks a result in connector tests.

### Connector translations

A manifest is written in English. Since SDK 0.2.6 it may carry
`translations`, keyed by language subtag (`"de"`; not `"en"`, which is the
manifest itself). Every field is optional and falls back on its own to the
English value, so a partial translation still shows:

```ts
translations: {
  de: {
    name: "Acme Analytics",            // product names stay as they are
    description: "Besucher und Seitenaufrufe aus Acme, pro Website.",
    resourceNoun: { singular: "Website", plural: "Websites" },
    metrics: { "acme.visitors": { name: "Besucher", description: "…" } },
    dimensions: { territory: "Land" }, // a dimension of some metric
    config: { teamId: { title: "Team-ID", description: "…" } },
    credentials: { token: { title: "Zugriffstoken", description: "…" } },
    setupSteps: ["…", "…"],            // one per English setup step
  },
},
```

The schema rejects unknown fields and keys that name nothing in the manifest
(a metric, dimension, config or credential field it does not have, or a
different number of setup steps). The catalog stores translations with the
manifest; the API answers in the caller's language (a user's setting, a
screen's workspace language), through `localizedManifest`,
`localizedMetric`, `localizedResourceNoun` and `localizedDimensionName` in
`@netrics/domain`. Units are not translated; hosts format them. German copy
addresses the reader with "du".

### Authentication strategies

The runtime must support at least:

- Static API token or bearer token
- OAuth 2.0 authorization code with refresh token
- OAuth 2.0 client credentials
- Signed JWT client credentials
- Uploaded private key material

A manifest declares one or more of these strategies:

- `{ strategy: "token", credentialsSchema?, setup? }` or
  `{ strategy: "none" }`: the user pastes a token (or nothing), and the
  connector receives the stored credentials.
- `{ strategy: "oauth2", provider, scopes }` (ADR 0012): the user authorizes
  at the provider, and the connector receives `credentials: { accessToken }`
  and never the refresh token.
- `{ strategy: "signed-key", provider }` (ADR 0014, SDK 0.2.2): the user
  uploads key material, such as an App Store Connect API key, and the host
  signs a short-lived token with it for each call. The connector receives
  `credentials: { accessToken }` (`AccessTokenCredentials`) and never the key.
  The strategy takes no other fields: the credential fields, token claims
  and lifetime belong to the provider, which is trusted host code. A server
  without that provider lists the connector as unavailable
  (`signed_key_provider_unsupported`). The providers live in
  `apps/server/src/signed-keys/providers/`. Before a key is stored (create,
  preview, rotation through the credential update), the host checks the
  fields, parses the key as PEM PKCS#8 EC P-256, runs the provider's probes
  with a fresh token, and then the connector check. The catalog exposes the
  provider's field labels and setup steps for the wizard. A 401 or 403 from
  the provider during a connector call puts the connection in `auth_failed`
  with the provider's "upload a new key" message; there is nothing to
  refresh. A provider may also define optional additional keys (#190: App
  Store Connect's reviews key, stored as `reviews: { keyId, privateKey }`
  in the same envelope, issuer ID shared). Each is checked with its own
  probes, signed into its own token per call and handed to the connector in
  a provider-named credential field (`credentials.reviewsAccessToken`). A
  refusal of that token is the connector's to handle: it pauses what the
  key reads and never puts the connection in `auth_failed`. This needs no
  SDK change: `credentials` is an opaque record, and a connector on a host
  without the additional key simply gets no such field.

A provider id is lowercase words joined by hyphens (`google`,
`app-store-connect`). Connectors may name a provider but never define one.

The credential service owns encrypted storage, standard OAuth callbacks, token
refresh, and audit events. A connector receives only the credentials required
for its connection and job. Because executable connector code can see the token
it uses, review remains part of the security boundary.

SaaS uses centrally registered OAuth applications. Self-hosted administrators
can configure their own provider client IDs and secrets through instance
settings.

### Connector trust and distribution

Initial community workflow:

1. Start from the public TypeScript connector template.
2. Submit the connector to the public repository.
3. Run contract, dependency, permission, fixture, and pagination tests.
4. Review code and declared outbound domains manually.
5. Add the connector to the signed catalog and connector bundle.
6. Roll the bundle through the normal application release.

Self-hosters may build their own connector bundle and thereby trust that code as
the deployment operator.

Do not describe a Node.js process or worker thread as a security sandbox. If
hosted arbitrary-code connectors become a requirement, use signed OCI artifacts
with container-level isolation, restricted egress, read-only filesystems,
resource limits, and no database network route.

### Custom API connector

The custom API connector is declarative and uses the core HTTP runtime. Its
definition includes request, authentication, pagination, JSON extraction,
metric mapping, and restricted transformation rules. It never runs arbitrary
JavaScript.

Hosted execution must protect against server-side request forgery:

- Reject loopback, private, link-local, and metadata-service destinations
- Resolve and validate DNS for every request and redirect
- Limit redirect count, response size, duration, and decompression
- Restrict methods initially to GET
- Store credentials separately from exportable connector definitions

Private definitions may be exported or submitted for community review.

## Metrics and synchronization

### Core records

- `metric_definition` — connector key, name, description, gauge/delta/counter
  semantics, unit, dimensions, and allowed aggregations
- `observation` — workspace, connection, metric definition, source timestamp,
  value, dimensions, source identity, and ingestion timestamp
- `sync_run` — connection, requested window, cursor, attempt, status, timing,
  error classification, and quota metadata
- `connection_state` — last success, next due time, opaque cursor, next window
  start (`next_from`), auth state, and consecutive failures

Use a deterministic series identity derived from metric definition and
dimensions. Inserts are idempotent for a source identity or deterministic time
bucket. Historical backfills and current syncs can overlap safely.

A sync run ingests page by page: each page the connector returns commits in its
own short transaction together with its `nextCursor` as the connection's
checkpoint, so a run holds one page in memory and the cursor never passes data
that is not committed. The last page commits with the run's success. A failed
run keeps the pages it committed and reports them on its `sync_run`; the retry,
or the next run, continues from the checkpoint. A connector's non-final cursor
must therefore stay valid when sent back in a later run with a later `to`.

A backfill job reads the connector's whole backfill window. A new backfill job
ignores the stored cursor, which may be an incremental sync's position or the
checkpoint of an earlier backfill. Each of its checkpoints records the job's
id (`connection_state.backfill_job_id`), so a retried or reclaimed attempt of
the same job resumes from its own checkpoint instead of starting over. A
backfill is queued when a connection is created or its setup finished, and
when a config change alters what the connection collects (any config
property, compared with defaults applied). A newly requested backfill
supersedes one that is still waiting; a running one finishes first. Renames,
new credentials and reauthorization queue none: the next sync continues from
the cursor. Observations collected under an earlier config stay (their series
identity is their dimensions); they are not deleted.

A connector update can add a dataset or change a dataset's schema version
(#617). An existing connection would then fill that dataset only from
incremental runs, starting a few days before the deploy. To prevent this, the
backfill and sync jobs work as follows.

**Recording.** A backfill job takes its datasets (`{key: version}`) from
the connector when it starts and stores them next to its id
(`backfill_job_datasets`) with every checkpoint. An attempt that resumes the
job on another worker, e.g. after a deploy, keeps only the datasets its own
connector declares at the same version. On success the job merges exactly
these into `connection_state.backfilled_datasets`: never a dataset whose
earlier pages it did not read, and the other entries stay.

**Detection.** Detection lives in the sync engine, not in a startup sweep. The
worker is the only process that has both the connector registry and the
connection, and the scheduler role cannot read `connections`. After each
succeeded incremental run, the engine compares the record with the datasets
the running connector declares. A dataset that the connection stores and that
is missing from the record, or recorded at another version, gets one
`connection.backfill`. A dataset the connection has never stored (no
`data_datasets` row) waits until its first rows arrive (#634): the provider
may have nothing for the last days yet, or the connection may never write it,
e.g. an optional report that is turned off. It is audited as
`connection.backfill_requested` with `by: "system"` and the reason
`dataset_added` or `dataset_changed`.

**Idempotency.** The check takes a row lock on the state row, then a
transaction-scoped advisory lock of the workspace's backfills (also taken by
"Reload history"), so replicas decide one at a time. It queues nothing while
a backfill of the connection waits or runs. It records the datasets it queued
for, when, and how often (`backfill_requested_datasets`, `_at`, `_count`).
Restarts and replicas never queue the same datasets twice in a row; a set
whose backfill failed (or ran on a worker without the datasets) is queued
once more after 24 hours, then only "Reload history" or the operator queue
another.

**Pacing.** A deploy reaches every connection at once, so the checks spread
over each connection's own poll interval. At most one automatic backfill per
workspace waits or runs at a time, because connections in a workspace often
share a provider key and its hourly limit (ADR 0014). The others ask again on
their next run.

**Shared provider apps.** An OAuth app has one quota for every workspace that
connects through it, e.g. the hosted service's Google app (#635). The worker
therefore claims at most `WORKER_BACKFILLS_PER_APP` (default 4, `0` for no
cap) `connection.backfill` jobs of OAuth connections per connector and OAuth
provider at a time, across all workspaces. This covers first imports,
automatic backfills and "Reload history" alike. A backfill that hands over to
a continuation keeps its slot until it finishes; among continuing backfills
the older go first. The others wait in the queue and start as slots free up.
Incremental syncs are not capped, and connections with their own API keys are
limited per workspace only. The cap is part of `claim_jobs` (migration 0080),
which runs as the owner and reads only the connector and provider of the
connection. Set the same value on every worker.

**Connections from before #617.** These have no record yet, and the first check
derives one. A stored dataset counts as read if a succeeded backfill run
finished after its schema version was registered. If no backfill run is
retained, it counts as not read. A dataset that has never been stored is left
out of the record, so it is backfilled once it stores rows (#634). Only a completed job writes a succeeded backfill run: a segment that
hands over to a continuation writes `continued`, a failed attempt `failed`.

**Stored data.** Backfills keep stored data and replace or upsert it window by
window, as before.

**Visibility.** The connection page says when the history is still loading. It
names the stored datasets whose history is incomplete. Data page previews
(sources and preparations), model queries and dashboard tiles carry the
warning `source_history_incomplete` while a source dataset they read belongs
to a connection whose backfill waits or runs, or whose backfill record lacks
the dataset at the schema version of its stored rows (#635). The Data page,
dashboard tiles and paired screens show it as a short "History incomplete"
note. A connection without a record (a connector without backfills) shows no
note. A snapshot (pinned pages, the last valid result) records which of its
pinned sources were incomplete, so a read of a pinned generation keeps the
state it had when it was pinned, not the connection's state now.

**A backfill that did not finish.** A backfill whose retries are used up read
part of its window at most (#787). The sync engine records every failed
backfill attempt in `connection_state.backfill_failed_at` and clears it when a
backfill succeeds; jobs and sync runs are pruned, so they cannot say this
later. While it is set and no backfill waits or runs, the connection page says
the history is incomplete (`history.backfillFailed`) and points to "Reload
history", every stored dataset of the connection counts as incomplete, and
reads of them carry `source_history_incomplete`, whatever earlier backfills
read. A backfill job that died without a failed run (a worker that stopped
mid-run) counts the same while the job is kept and no history start is known.

**Reload history.** Members with `connections:update` can press "Reload
history" (`POST …/connections/{id}/backfill`). It is audited with the member,
refused while a backfill of the connection (`backfill_in_progress`) or of
another connection of the workspace (`workspace_backfill_in_progress`) waits
or runs, and limited to once per connection per 12 hours
(`HISTORY_RELOAD_INTERVAL_HOURS`).

Partition observations by time when necessary. Index workspace, metric, series,
and timestamp query paths. Retention and rollups run as ordinary maintenance
jobs until TimescaleDB or another analytical store becomes justified.

Retention defaults (`DEFAULT_RETENTION` in `packages/database/src/jobs.ts`,
applied hourly by the scheduler through the owner-role `prune_history`
function):

| Data                             | Kept                                                      |
| -------------------------------- | --------------------------------------------------------- |
| Succeeded jobs                   | 7 days after creation                                     |
| Failed and dead jobs             | 30 days (dead-letter inspection)                          |
| Sync runs (with redacted errors) | 90 days after finishing; each connection's latest is kept |
| Observations                     | Until the connection or workspace is deleted              |

Observations stay unpruned until rollups exist: dashboards read raw values, and
deleting them would change historical charts. Their retention is decided
together with rollups.

Security records hold IP addresses, browser user agents or hashes of them.
Their retention follows the privacy policy and is fixed in code
(`SECURITY_RETENTION` in `packages/database/src/security-retention.ts`), not
configuration; the same hourly maintenance applies it through the owner-role
`prune_security_records` function, at most one batch per table per run:

| Data                                                                                                      | Kept                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Audit events (workspace and `auth.login`)                                                                 | 12 months after creation                                                                    |
| Sign-in sessions                                                                                          | Until 24 hours after expiry; IP and browser cleared 12 months after sign-in                 |
| Auth rate-limit counters (keyed by client IP)                                                             | 24 hours after the last request                                                             |
| Device pairings (hashed client IP)                                                                        | 24 hours after expiry                                                                       |
| Removed screens (`devices` revoked: name, platform, last heartbeat, approving admin; with their pairings) | 90 days after removal (`REVOKED_DEVICE_RETENTION_DAYS`, owner-role `prune_revoked_devices`) |

App Store review text (ADR 0019 §11) holds reviewer nicknames and text
customers wrote. Its retention is fixed in code as well
(`APP_REVIEW_RETENTION` in `packages/database/src/app-reviews.ts`) and
applied by the same hourly maintenance through the owner-role
`prune_app_reviews` function:

| Data                                                         | Kept                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| App Store review text (`app_reviews`: nickname, title, text) | Newest 50 per connection and app, none older than 90 days; deleted with the reviews key, the connection or the workspace |

Process logs go to stdout and are not stored in the database; their retention
is set where they are collected (the hosting platform, or a self-hoster's log
driver).

### Derived metrics

The agreed product direction now includes reusable source datasets, data
preparation, relationships across systems, named measures and dashboard-wide
filtering. [ADR 0022](./decisions/0022-reusable-data-model-and-processing.md)
proposes the logical schema, execution model and compatibility path. The
dataset transport connectors use (fields, types, modes, keys, reporting field,
retention, versions, pages and checkpoints) is frozen as dataset contract v1
in [ADR 0026](./decisions/0026-dataset-contract-v1.md), with compatibility
fixtures in `packages/connector-sdk/src/contract/fixtures/v1/`. These
capabilities are not implemented by the current observation model; the numeric
observations and connector contract above describe the existing implementation.

In the proposal, row calculations and aggregate measures share a typed,
restricted expression engine. Prepared datasets and semantic models are
independent of dashboards. Widgets use model measures and shared dimensions;
the server resolves their filter context and validates units, currencies,
grain, missing values, time semantics and relationship cardinality. Editable
templates configure the same capabilities exposed to customers. Milestone 11
contains the proposed implementation gates.

## Jobs, events, and alerts

Use durable PostgreSQL-backed jobs for synchronization, backfills, maintenance,
rendering, alerts, and notifications. Required properties:

- Transactional enqueue where a domain write and job must stay consistent
- At-least-once execution with idempotent handlers
- Retry policy and dead-letter visibility
- Per-connection serialization where provider cursors require it
- Connector and provider rate limiting
- Explicit workspace context in every job

The core writes lifecycle and usage events through a transactional outbox.
Private cloud consumers receive them over a documented delivery mechanism and
must tolerate duplicates.

Alert rules form a state machine:

```text
healthy → pending → firing → recovering → healthy
```

Rules define a metric query, window, comparator, required duration, cooldown,
missing-data behavior, and recovery behavior. Notification channels are a
separate extension type from source connectors.

## Authentication and authorization

Use embedded authentication for the default deployment. Better Auth is the
initial implementation behind a small application adapter.

Keep authentication records separate from netrics domain records:

- Better Auth owns credentials, external identities, sessions, MFA, and
  protocol-specific state.
- Netrics owns users' domain identity, workspaces, memberships, and permissions.
- A stable mapping connects the two.

Capability rollout:

1. Password, social login, email verification, invitations, passkeys, and 2FA
2. Generic OIDC
3. SAML and SCIM

Security dependency updates are urgent operational work. Pin versions, automate
advisory detection, and support only maintained versions. The adapter preserves
the option to move to an external identity system later without moving tenant
authorization out of the core.

## Apple TV and rendering

> Update (2026-09): the MVP renders native SwiftUI tiles from a JSON device
> endpoint instead of snapshots; see
> [ADR 0007](./decisions/0007-native-tvos-tiles.md). The snapshot design below
> is deferred, not removed. Slides, widgets, themes and images on devices
> follow [ADR 0015](./decisions/0015-dashboard-studio.md).

The initial tvOS application is a thin native client:

1. Generate a short-lived pairing code and device nonce.
2. An authenticated workspace administrator approves the device in the web app.
3. Exchange approval for a scoped device credential with rotation and
   revocation.
4. Fetch a playlist manifest containing versioned snapshot references.
5. Cache and display snapshots full-screen, including the last known version
   while offline.
6. Send heartbeat and diagnostic state without exposing workspace credentials.

The renderer opens a protected dashboard route at a fixed TV viewport, captures
the output, and stores a versioned image. Rendering uses a short-lived token and
never a public dashboard link. Snapshot invalidation occurs after material data
or dashboard changes and on a periodic refresh. The initial refresh target is
30–60 seconds.

Object storage uses an S3-compatible interface in SaaS and may use a local
volume in small self-hosted installations.

## Deployment

### Self-hosted

The public repository provides a supported Docker Compose installation with:

- `web`
- `api`
- `worker`
- `scheduler`
- PostgreSQL
- Optional `renderer` profile
- Optional S3 configuration or a local snapshot volume
- SMTP and authentication configuration

Images are pinned to a tested netrics release. Setup generates an instance
encryption key, creates the first workspace and owner, applies migrations, and
performs health checks. Upgrades include documented backup and rollback steps.

### SaaS on Railway

One Railway project initially contains:

- `web`
- `api`
- `worker`
- `scheduler` with one active replica
- `renderer`
- PostgreSQL
- S3-compatible object storage configuration

Services communicate over Railway private networking. Only required HTTP
surfaces receive public domains. Web, worker, renderer, and scheduler scale
independently.

## Infrastructure and release automation

The implementation follows the proven Paperstand operating pattern while
separating infrastructure reconciliation from application rollout.

### Ownership

| Concern                                                                  | Owner                                       |
| ------------------------------------------------------------------------ | ------------------------------------------- |
| Railway projects, environments, services, domains, and durable resources | Terraform                                   |
| Service build/runtime settings and health checks                         | `railway.toml` or equivalent config-as-code |
| Runtime variables and secrets                                            | 1Password-backed Railway env templates      |
| Application image versions and rollout order                             | Release workflow                            |
| Self-hosted topology                                                     | Public Docker Compose                       |

Do not store resolved production secrets in Terraform state. GitHub Actions
stores only the 1Password service-account token; provider credentials and
runtime secrets resolve from committed `op://` references.

### CI behavior

| Change                         | Pull request                              | Merge to `main`                      |
| ------------------------------ | ----------------------------------------- | ------------------------------------ |
| Terraform root                 | Format, validate, plan, update PR comment | Automatic apply                      |
| Railway env template           | Validate references and report key names  | Sync changed services                |
| Application code               | Test and build images                     | Publish, migrate, deploy, smoke test |
| Permanent/destructive resource | Plan                                      | Manual workflow dispatch             |

Use separate Terraform roots for Railway, DNS, object storage, and monitoring.
Each root has an independent state key and workflow concurrency group. Remote
state uses a versioned S3-compatible bucket with state locking. Bootstrap the
state bucket manually so Terraform cannot destroy its own recovery path.

Add `prevent_destroy` to the production Railway project, database storage,
object storage, and other irreplaceable resources. Once another person receives
merge access, protect production applies with a GitHub Environment and required
reviewer.

### Railway provider policy

The Railway Terraform provider is community-maintained and must be pinned to an
exact tested version. Before adopting or upgrading it:

1. Apply the complete topology to a disposable Railway project.
2. Change each supported service field and inspect the plan and live result.
3. Confirm it does not reset settings that it does not model.
4. Import an existing service and repeat the update test.

Keep unsupported or unsafe service-instance settings in Railway's native
config-as-code or a narrowly scoped CLI script. Terraform still owns resource
existence and stable identifiers.

### Application release

On a successful merge to the public `netrics` main branch:

1. Run unit, integration, migration, connector-contract, and image smoke tests.
2. Build server and web images once (linux/amd64 and linux/arm64).
3. Push immutable commit tags to `ghcr.io/netrics-so/*` and record digests.
4. Sign images and generate software bills of materials.
5. Trigger the private cloud release workflow with the candidate digests.
6. Run database migrations with the exact candidate server image.
7. Deploy API and web, then worker and scheduler.
8. Require health checks and a small end-to-end smoke test.
9. Record the deployed digests in `release/production.yaml`.

Example release state:

```yaml
release: 0.1.0
commit: abc1234
images:
  server: ghcr.io/netrics-so/server@sha256:...
  web: ghcr.io/netrics-so/web@sha256:...
```

Terraform does not run for an ordinary application commit. The release workflow
updates Railway to exact image digests. Terraform must ignore the image-version
field that the release workflow owns, avoiding two controllers for the same
state.

Rollback redeploys the previous recorded digests. Database migrations follow an
expand/migrate/contract discipline so the previous application remains usable
during normal rollback windows.

### Drift and recovery

- Every workflow supports manual dispatch for a safe retry.
- A scheduled read-only plan reports infrastructure drift.
- Railway variable sync reports undeclared variables by key without printing
  values; deletion requires an explicit prune action.
- Apply operations are never automatically retried after they begin.
- Backup restore procedures are rehearsed and timed before paid launch.

## Observability and operations

- Structured JSON logs with workspace and connection identifiers, excluding
  credentials and raw payloads
- OpenTelemetry-compatible traces and metrics
- Error tracking separated by process role
- External uptime checks for public HTTP endpoints
- Push heartbeats for scheduler and worker liveness
- Connection-level health and quota visibility in the product
- PostgreSQL backups with point-in-time recovery for SaaS
- Versioned object storage and a second-copy strategy for critical assets

## Licensing and distribution

- Server and official web application: proposed AGPLv3
- Connector SDK and template: proposed Apache-2.0 or MIT
- Official images: public GHCR images pinned by digest
- Source tags correspond to every published release
- Image signatures, provenance, and SBOMs are published with releases
- Trademark policy protects the netrics brand without reducing self-hosted
  functionality

AGPL requires qualifying hosted modifications to offer corresponding source to
network users; it does not prohibit a compliant competing hosted service. A
source-available restriction on commercial hosting would be a different product
and community decision.

## Deliberate trade-offs

| Decision               | Chosen now                                           | Revisit when                                            |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Repository model       | Public monorepo + private cloud repo                 | Independent teams need independent ownership            |
| Backend shape          | Modular monolith with process roles                  | A module needs separate scaling, security, or ownership |
| Queue                  | PostgreSQL-backed                                    | Measured contention or latency requires Redis           |
| Metrics store          | PostgreSQL                                           | Volume or query cost exceeds practical partitioning     |
| Connector distribution | Reviewed bundle                                      | Release cadence or connector count becomes limiting     |
| Community execution    | Reviewed code only in SaaS                           | Arbitrary tenant code becomes a validated market need   |
| TV rendering           | Native slides and widgets from JSON (ADR 0007, 0015) | Customers need layouts the widget set cannot express    |
| Self-host deployment   | Docker Compose                                       | Sustained customer demand justifies Helm/Kubernetes     |
| Authentication         | Embedded                                             | External identity operation becomes simpler overall     |

## Implementation decisions still to make

- Select and validate the PostgreSQL job library.
- Select database query and migration tooling with first-class SQL and RLS
  support.
- Choose the initial SaaS S3-compatible storage provider (dashboard images
  live in PostgreSQL, ADR 0015; object storage waits for snapshots or exports).
- Define the first connector SDK compatibility and deprecation policy.
- Validate the pinned Railway Terraform provider against a disposable project.
- Decide whether production deploys immediately after every green main merge or
  use a short release-candidate soak once real customers exist.
