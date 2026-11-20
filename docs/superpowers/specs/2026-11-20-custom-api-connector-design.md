# Custom API connector (milestone 13) — design

Date: 2026-11-20. Status: draft for owner approval.
Plan this replaces in detail: [milestone 13](../../milestones/13-custom-api-connector.md).

## Intent

Customers will want their own data next to the bundled connectors: their own
backends, and services netrics does not ship a connector for. Today that
needs a netrics code change. This milestone lets a workspace member describe a
JSON HTTP API in the UI, without writing code, and get scheduled, typed data
that behaves exactly like bundled connector data: it feeds preparations,
models, measures, dashboard filters and screens (ADR 0022).

No customer has asked yet; the owner expects it. The milestone is proven
against real APIs, including public endpoints of one first-party service of the owner, so the builder is shaped by real cases.
Testing it also covers images: the first visible result is "the latest images
from my service" on a dashboard and on Apple TV, beside a number over time.

## Goals

- Define a custom API once, connect it several times (one connection per
  account or environment, each with its own credentials), like connecting
  Apple Ads twice.
- Support the common authentication methods: none, API key (header or query
  parameter), bearer token, HTTP basic, OAuth 2.0 client credentials and
  OAuth 2.0 authorization code.
- Support the common pagination styles, record selection, typed field
  mapping, incremental time windows, lookback, backfill and a schedule.
- Test a request in the builder and see a redacted response before saving.
- Version, export and import definitions without credentials.
- Show images returned by an API: a "latest items" widget on web and tvOS.
- Keep hosted safe: no access to private networks, metadata services or
  arbitrary redirect targets; bounded bytes, time and records.

## Non-goals

- POST/PUT/PATCH/DELETE requests, GraphQL, SOAP, XML, CSV over HTTP.
- Arbitrary JavaScript, template languages or a second formula language.
  Transformations happen in preparations (ADR 0022).
- Username/password login flows, request signing (AWS SigV4, signed JWT keys),
  mutual TLS.
- Push or webhook ingestion, near-real-time sync.
- Submitting definitions to a community catalog (needs milestone 12; it
  stays the last slice of 13 and moves after 12).
- Publishing the connector SDK (milestone 12). Only the dataset contract the
  custom connector emits is frozen here.

## Anti-goals (failure even if it works)

- A credential appears in a preview, log, error, export, dataset or
  expression.
- A hosted definition can reach a private address, a cloud metadata service,
  or another host by redirect or DNS change.
- A definition can make netrics send an API's credentials to a different
  host (for example the image CDN).
- Setting up a simple public JSON API takes more than a few minutes, or the
  builder requires reading JSONPath documentation.
- Images make the TV payload large or break offline playback.

## Constraints

- Repository invariants (CLAUDE.md): RLS plus explicit workspace predicates,
  secrets only in AES-GCM envelopes bound to the connection, network only
  through the runtime's egress guard, one source for hosted and self-hosted,
  packages depend inward, English and German everywhere.
- Existing egress guard (`packages/connector-runtime/src/egress.ts`) already
  enforces https, non-public address blocking after DNS lookup, no URL
  credentials, a redirect limit and a response size limit. Extend it; do not
  build a second client.
- Dataset transport limits (`DATASET_LIMITS` in
  `packages/connector-sdk/src/datasets.ts`): 100 fields, 20 datasets, 1,000
  rows / 1 MiB per page, 64 KiB per row.
- The OAuth platform (ADR 0012) treats providers as trusted host code with
  instance configuration. Custom OAuth endpoints are user data, so they need
  their own path through the same credential service.
- Image handling follows ADR 0015 and resource icons: the host validates
  raster bytes, strips metadata and stores them; screens only load images
  from netrics.

## Approaches

**Connector core — one sensible way.** A definition is a declarative JSON
document (request, auth, pagination, record selection, fields, schedule). One
built-in generic connector, `custom-api`, executes any definition through the
egress guard and emits typed datasets. The UI is a guided form over that
document with a live test panel (similar to Airbyte's Connector Builder).
Rejected: uploading connector code (out of scope for security; that is the
community path of milestone 12), and running Airbyte or Singer beside netrics
(heavy hosted and self-host infrastructure, data would not land in typed
datasets).

**Images — owner picked A (2026-11-20).**

- A. Copy into netrics (picked): during sync the host downloads the images of
  the newest N records, validates and stores them like uploaded images; web
  and TV load them from netrics. Works with login-protected and expiring
  links (signed S3 URLs), keeps the TV offline cache and a single TV host.
  Costs storage and a cleanup rule.
- B. Hotlink the source URL: almost free, but breaks on expiring or
  protected links and makes the TV reach arbitrary hosts.

**Order — owner agreed.** Milestone 13 runs before 12. Connector core first,
the image feed widget last in the same milestone, the owner's service as test
case for both.

## Design

### 1. Concepts

- **Custom API definition** — workspace-scoped, versioned, contains no
  secrets. Holds environments (named base URLs), auth method and its non-secret settings, connection
  variables, streams and schedule defaults. Optionally assigned to a project.
- **Stream** — one request pattern producing one source dataset (for example
  "daily stats", "images"). At most 20 per definition (dataset limit).
- **Environment** — a named base URL in the definition (for example
  Production and Staging). Every host a definition may reach is written in
  the definition; a connection only picks one environment and never enters a
  host. _(Owner decision 2026-11-20.)_
- **Connection** — created from a definition (pinned to a definition
  version), picks an environment, holds the credentials and the values of
  connection variables (for
  example an account ID). Several connections may use one definition.
  Connections appear in the normal connection list with the definition's
  name; the marketplace gets a "Custom API" entry that starts the builder or
  creates a connection from an existing definition.

### 2. Definition document (schema version 1)

Validated with zod in `packages/contracts` (portable, JSON). Sketch:

```jsonc
{
  "schemaVersion": 1,
  "name": "Shop API",
  "environments": [
    // https only; first = default
    {
      "id": "production",
      "name": "Production",
      "baseUrl": "https://api.example.com/v1",
    },
    {
      "id": "staging",
      "name": "Staging",
      "baseUrl": "https://staging.example.com/v1",
    },
  ],
  "variables": [
    // per-connection values
    { "id": "account_id", "label": "Account ID", "secret": false },
  ],
  "auth": { "type": "bearer" }, // see section 3
  "defaults": { "refreshMinutes": 60, "timeZone": "UTC" },
  "streams": [
    {
      "key": "daily_stats",
      "name": "Daily stats",
      "request": {
        "path": "/accounts/{{account_id}}/stats",
        "query": { "from": "{{window.start}}", "to": "{{window.end}}" },
        "headers": { "Accept": "application/json" }, // non-secret only
      },
      "pagination": {
        "type": "cursor",
        "cursorPath": "meta.next",
        "param": "cursor",
      },
      "records": "data", // path to the record array
      "fields": [
        { "id": "day", "path": "date", "type": "date" },
        { "id": "orders", "path": "orders", "type": "integer" },
        {
          "id": "revenue",
          "path": "revenue.amount",
          "type": "decimal",
          "currencyField": "currency",
        },
        { "id": "currency", "path": "revenue.currency", "type": "string" },
      ],
      "keyFields": ["day"],
      "mode": "upsert",
      "reportingField": "day",
      "window": {
        "type": "date",
        "stepDays": 31,
        "lookbackDays": 3,
        "backfillDays": 365,
      },
    },
  ],
}
```

Rules:

- **Placeholders, not templates.** `{{…}}` substitutes only a closed set of
  names: connection variables, `window.start`, `window.end` (formatted by a
  chosen format: ISO date, ISO timestamp, Unix seconds or milliseconds),
  pagination values. Values are URL-encoded at their position. No
  expressions, filters, loops or conditionals. Secret variables may only be
  used inside auth, never in path, query or headers that show in previews.
- **Paths** use a small dotted syntax with array indexes (`data`,
  `meta.next`, `items[0].url`), not full JSONPath. The builder fills them by
  clicking in the response tree.
- **Fields** map a path to a dataset field: id, display name, type (the
  dataset types), nullable, classification (`public`, `internal`,
  `personal`; default `internal`), optional unit/currency/scale, optional
  input format for dates and timestamps. Unmapped data is not stored, so raw
  responses are never retained.
- **Modes** reuse the dataset modes: `upsert` (keyed records), `append`
  (events with a dedupe key), `replace_window` (a complete date window
  replaces its rows), `snapshot` (the whole list as of now, for example "all
  images").
- **Window**: `none` (one request set per run), `date` or `timestamp`
  ranges with step size, lookback and backfill depth. Runs, checkpoints and
  backfill follow the existing sync and backfill machinery (ADR 0022, ADR
  0023, #617): a cursor only advances after records are durable; no deletion
  is inferred from a failed or partial run.
- **Schedule**: refresh interval per definition, overridable per connection,
  with an instance minimum (hosted default 15 minutes) and the workspace
  sync throttling that exists today.
- Every definition change creates a new version; a field change bumps the
  stream's dataset version so downstream preparations see a schema change
  through the existing schema/version handling.

### 3. Authentication

The definition stores the method and non-secret settings; the connection's
credential envelope stores the secrets. The host applies auth to requests;
connector logic and expressions never see secret values.

| Method                   | Definition holds                                                                                     | Connection holds                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| None                     | —                                                                                                    | —                                                       |
| API key                  | placement (header or query) and name                                                                 | key                                                     |
| Bearer token             | optional header name and prefix (default `Authorization: Bearer`)                                    | token                                                   |
| HTTP basic               | —                                                                                                    | username, password                                      |
| OAuth client credentials | token URL, scopes, client auth style (body or basic)                                                 | client ID, client secret                                |
| OAuth authorization code | authorize URL, token URL, optional revoke URL, scopes, PKCE (default on), extra authorize parameters | client ID, client secret, then access and refresh token |

- OAuth authorization code: the user registers an OAuth app at their
  provider; netrics shows the redirect URL to enter there (the existing
  callback route, with the custom provider identified by the connection, not
  by trusted provider code). Tokens are refreshed by the host as today;
  refresh tokens never leave the host. This is the one place where the hosted
  "netrics owns the OAuth app" rule cannot apply, because netrics cannot own
  apps for APIs it does not know; the UI says so.
- Token, authorize and revoke endpoints pass the same egress checks as data
  requests and must be https. Their hosts join the connection's allowed
  hosts.
- Credentials are only sent to the connection's environment host and the declared
  token endpoint host — never to image hosts, never across redirects to
  another host.
- `401/403` makes the connection "needs attention" with an actionable
  message (reconnect, rotate key), like bundled connectors.

### 4. Pagination

Supported: none; page number (param, start, page size param); offset/limit;
cursor from a response body path sent as a param; next URL from a response
body path or the `Link` header. A next URL must stay on the API host. Stop
conditions: empty page, missing cursor, fewer records than page size, or the
safety limits (pages per run, records per run, run duration), which end the
run as incomplete rather than silently truncating.

### 5. Execution and safety

- One built-in connector `custom-api`. Per call, the host builds an effective
  manifest from the connection's pinned definition: datasets from streams,
  `outboundDomains` from the connection's environment host plus auth
  endpoint hosts. Credentials of a connection are bound to its environment's
  host; changing a connection's environment requires re-entering them.
- The egress guard gains: DNS pinning (resolve once, validate, connect to the
  validated address, so a re-resolution cannot rebind), per-hop validation of
  redirects with same-host-only for custom APIs, decompressed-size limit,
  per-request timeout, and a cap on JSON depth and record count. IPv4, IPv6,
  IPv4-mapped IPv6, decimal/octal/hex encodings and metadata addresses are
  covered by tests.
- Self-hosted only: an instance setting may allow named private hosts or
  ranges for custom APIs (internal services). Off by default; the hosted
  service never sets it.
- Bounds (defaults for the builder to settle, documented): response 10 MiB,
  decompressed 50 MiB, 30 s per request, 200 pages and 100,000 records per run.
- Errors, logs and previews pass through the existing redaction
  (`redact.ts`) with the connection's secret values and auth headers added to
  the redaction set.

### 6. Builder UX

A guided editor, English and German, using existing Signal admin components:

1. **Basics** — name, environments (one base URL to start, more can be
   added), project.
2. **Login** — pick the method; the form asks only for what that method
   needs; secrets go to a test connection.
3. **Request** — path, query, headers, variables; "Send test request".
4. **Response** — the redacted response as a collapsible JSON tree; click the
   record array, then tick the fields to keep. Types are suggested from the
   values (dates, numbers, decimals, booleans, image URLs) and can be changed.
   A table preview shows the mapped rows.
5. **Paging and time window** — pick a style; the panel shows how many pages
   and records the test fetched.
6. **Schedule and review** — refresh interval, backfill depth, then save and
   create the first connection.

The test panel also shows the request log: method, redacted URL, status,
duration, bytes, per page. Saving runs the same validation as import.

### 7. Versions, export, import

- Definitions keep a version history with author and time; rollback creates
  a new version equal to an older one. Connections pin a version and are
  offered the update explicitly (same pattern as template updates, #615).
- Export downloads the definition JSON with `schemaVersion`; it never
  contains credentials or connection variable values. Import validates,
  upgrades older schema versions, and creates a new definition.
- Schema upgrades are pure functions with fixture tests for every older
  version.

### 8. Images and the latest-items widget

- A field can be marked **image**: it stays a `string` field (the URL) with
  the field role `image`. The role is part of dataset contract v1 (section 9)
  and preparations pass it through like the unit (select, rename, filter,
  append and join keep it; a calculation or group-by drops it unless the
  field is carried unchanged). The definition lists the **image hosts**
  allowed for downloads (defaults to the API host). Image requests carry auth
  only when the image host is the API host. _(Builder check; my call.)_
- After a successful sync of a stream with an image field, the host
  downloads images for the newest N records by the reporting/time field
  (default 12, max 50), through the egress guard. Stored images are keyed by
  **workspace and URL hash**, not by record, so the same image reached through
  two connections or after a join/append is stored once, and a widget finds
  it from the URL in any prepared or model row. Unchanged URLs are not
  downloaded again. Images no longer referenced by any stream's newest N are
  deleted after a grace period. A failed or skipped image never fails the
  sync; the item shows without its image and the stream shows a count of
  skipped images. _(Builder check; my call.)_
- **Image rules follow ADR 0015** with a separate origin and quota _(builder
  check; my call)_: PNG, JPEG or WebP, metadata stripped without
  re-encoding, so no new native image library in this milestone. Per image
  at most 2 MiB (uploads stay 1 MiB); larger images are skipped and counted.
  New origin `custom_api` with its own workspace quota (default 500 images,
  200 MiB, instance setting), not counted against uploads. If the real test
  APIs show many skipped images, resizing (an image library, its own ADR)
  becomes a follow-up. The TV payload carries image references, not bytes,
  as today; the TV downloads and caches them per slide.
- **Latest items widget** (new widget type): binds to a dataset or prepared
  result with an image field, a title field, an optional subtitle and a time
  field; shows the newest items as a grid or one at a time rotating; respects
  dashboard filters like other widgets. Web, renderer and tvOS render it; the
  TV caches images with the slide for offline playback. The device payload
  adds the widget in a backward-compatible way; older TV apps show a
  placeholder.

### 9. Dataset contract freeze (from milestone 12 slice 1)

Document the dataset transport the custom connector emits (fields, types,
modes, keys, reporting field, retention, versions, checkpoints) as stable
"dataset contract v1" with compatibility tests. No public package
release; milestone 12 publishes it.

### 10. Credentials, drafts and OAuth details

- `custom-api` is trusted bundled code; it receives the connection's
  credentials through `ConnectionContext` like other connectors and applies
  auth itself. No custom definition content can read them: placeholders
  cannot reference secrets outside the auth block. _(Builder check; my call.)_
- "Send test request" and the OAuth authorization-code flow need credentials
  before the definition is saved: they live on a **draft connection** that
  is not synced and is deleted when the builder is abandoned (after a timeout).
  _(Builder check; my call.)_
- Custom OAuth has no OpenID account endpoint in general; the account
  identifier recorded for the grant is generated by netrics. _(Builder check;
  my call.)_

### 11. Permissions and limits

Creating and editing definitions uses the existing capability for managing
connections; viewers can see definitions without secrets. Limits per
workspace (definitions, streams, connections, stored images) are instance
settings with defaults, enforced server-side, for the SaaS control plane
(milestone 16) to tune later.

## Exit gate

1. A public JSON API without auth: define, test, map, backfill, show a
   number over time on a dashboard.
2. A first-party API (the owner's service), public endpoints only (owner
   decision 2026-11-20: no changes to that service): a number over time and
   the latest images; two connections of one definition (two environments or
   two variable values) combined in one preparation and filtered on a
   dashboard.
3. Every authentication method against real public APIs where a suitable
   free one exists (API key, bearer, OAuth authorization code, client
   credentials), otherwise against the fixture server.
4. The latest-images widget shows the newest images from the first-party
   service on web and on a paired Apple TV, including offline playback.
5. Export, re-import into another workspace, connect, same data.
6. The SSRF suite rejects protected destinations (IPv4/IPv6 forms, DNS
   rebinding, redirects, metadata, decompression bombs); no credential in
   any preview, log, export or error (tests).
7. Hosted and self-hosted runs.

CI covers every auth method, pagination style and image case against a
local fixture server (offline, part of the test suite). Gates 2–4 are a
manual acceptance run on hosted, done by the agent with any credentials the
owner provides and the owner watching, like earlier exit gates. _(Builder
check; my call.)_

Private details of the owner's test service (hosts, accounts, tokens) stay
out of this public repository.

## Left to the builder

- Exact table layout for definitions, versions and stored item images, and
  migrations.
- Where the definition-to-manifest adapter lives (connector-runtime vs
  server), within the package layering rules.
- Exact default limits, after measuring on the test APIs.
- Visual design of the builder steps and the widget, within Signal design.
- Issue split; suggested slices: dataset contract freeze; egress hardening
  and SSRF suite; definition schema and executor (none/key/bearer/basic,
  pagination, windows); builder UI and test panel; OAuth client credentials
  and authorization code; versions/export/import; image ingestion; latest
  items widget (web, renderer, tvOS); exit gate.
