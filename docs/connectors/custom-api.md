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
> API, and the images of image streams are copied after each sync. OAuth
> (client credentials, authorization code), the builder UI and the latest
> items widget follow.

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
`customApiEnvironmentId`) needs every secret again: the login method's
credentials (unless it is none) and every secret variable
(`secretVariables`). Nothing stored moves to another environment's host.

Create a connection with
`POST /v1/workspaces/:workspaceId/custom-api/definitions/:definitionId/connections`
(`connections:create`). netrics checks the credentials with one request
before it stores anything, then queues the connection's backfill. The
generic connection routes refuse `custom-api` with
`custom_api_requires_definition`.

## Drafts and test requests (builder)

The builder keeps the secrets it needs before a definition is saved on a
**draft connection** (`POST /v1/workspaces/:workspaceId/custom-api/drafts`,
`connections:create`): a custom-api connection with status `draft` that is
never synced, never listed and deleted 24 hours after it was last used. At
most 10 drafts are open per workspace.

- `PUT …/drafts/:draftId` stores the unsaved definition (one stream), the
  environment, the connection values and, optionally, the secrets. Answers
  name the stored secrets, never their values. Secrets are bound to the hosts
  they were entered for (the environment host with its port, and the token
  endpoints of OAuth): when the definition moves to another host or another
  login method, stored secrets are deleted and have to be entered again.
  Otherwise secrets sent later are merged into the stored ones (only the
  names sent change, `null` removes one), and secrets the definition no
  longer declares are forgotten. The set is checked when the draft is
  tested or promoted.
- `POST …/drafts/:draftId/test` runs the stream against the draft's secrets:
  at most 5 pages, 1,000 records and 60 seconds. The answer holds the first
  response as a tree (at most 256 KiB, 50 items per list, 200 keys per
  object, 2,000 characters per text, 32 levels), the lists that may hold the
  records, suggested fields from the first 100 records, up to 100 mapped
  rows (512 KiB together) and a log per page. The whole answer stays within
  1 MiB; `truncated` says when anything was cut. Only the first page's body
  is kept while the test runs. Every secret value (raw, URL-encoded in
  either case, form-encoded or JSON-escaped) reads `[redacted]` in all of
  it, and values are redacted before they are shortened.
  Nothing from the test is stored. At most 30 test requests run per
  workspace and minute (`429 custom_api_test_rate_limited` with
  `Retry-After`); a definition whose host changed after the secrets were
  entered answers `409 custom_api_credentials_host_changed` without any
  request.
- `POST …/drafts/:draftId/promote` turns the draft into a connection of a
  saved definition version, keeping its secrets when that version sends them
  to the same hosts.

## What is supported

- **Login**: none; API key in a header or query parameter; bearer token
  (header name and prefix configurable, default `Authorization: Bearer`);
  HTTP basic. A `401` or `403` marks the connection "needs attention" with a
  message that says what to do. A `429` with `Retry-After` waits until then; a
  `429` without it is retried with the usual backoff.
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
`budget`): what earlier pages stored stays, and the next run (a new time
window) reads every stream again from the first one. JSON nested deeper than 64 levels is refused.

Requests go out only through the egress guard: https only, public addresses
only, redirects only to the same host (with credentials never sent to
another host), and the DNS answer checked once is the one connected to.
Next page links are stored in the run's position without the API key and
any other secret; netrics adds the key again when it requests them.

## Images

A string field with the role `image` holds an image URL. After every
succeeded sync of a stream with an image field, netrics copies the images of
the stream's newest items (by its reporting field; `images.newestItems`,
default 12, at most 50) into the workspace:

- Only from the definition's `images.hosts` (exact hosts or `*.example.com`),
  or, without an `images` block, from the environment host. Only https.
- Through the egress guard, at most 2 MiB and 15 seconds per image, with
  redirects only to the same host. The connection's credentials are sent
  only when the image host is the environment host; other hosts get a plain
  request.
- PNG, JPEG or WebP by their bytes (the Content-Type is ignored), at most
  4096 px per side, metadata stripped without re-encoding.
- Stored per workspace and SHA-256 of the exact URL. A URL already stored is
  not downloaded again, and an image whose bytes are already stored (an
  expiring signed URL) is reused.
- Their own quota per workspace (default 500 images, 200 MiB), apart from
  uploaded images.
- Images that no stream lists among its newest items for 7 days are deleted.

A failed or skipped image never fails the sync. The connection page shows
per image stream how many images are stored and how many were skipped, and
why.

### Latest items widget

A dashboard shows the images in a **latest items** widget. It binds to a
published model with an image dimension (a string field with the role
`image`) and a date or time dimension, and shows the newest records (up to 50) as a grid or one at a time, each with its title, an optional subtitle and
its time. Dashboard filters, slide scopes and screen scopes apply as on
measure widgets. Each item's image is looked up by the SHA-256 of its URL
among the stored images; an item outside the stored newest items, or whose
image was skipped, shows a placeholder. Screens load the images only from
netrics, never from the source URL, which no client receives.

Screens get the widget when they ask for it (`?features=items` on
`GET /v1/device/dashboard`); older netrics TV apps and kiosks get a text that
asks to update in its place, and none of its images. A screen may fetch an
item image only while its own current dashboard shows it.

## Instance settings

| Setting                                  | Default | Meaning                                                |
| ---------------------------------------- | ------- | ------------------------------------------------------ |
| `NETRICS_CUSTOM_API_MAX_DEFINITIONS`     | 50      | definitions per workspace (archived ones don't count)  |
| `NETRICS_CUSTOM_API_MAX_STREAMS`         | 20      | streams per definition (never above 20)                |
| `NETRICS_CUSTOM_API_MAX_CONNECTIONS`     | 100     | custom API connections per workspace                   |
| `NETRICS_CUSTOM_API_MIN_REFRESH_MINUTES` | 15      | the shortest refresh interval a connection may request |
| `NETRICS_CUSTOM_API_IMAGE_QUOTA_COUNT`   | 500     | item images per workspace (worker)                     |
| `NETRICS_CUSTOM_API_IMAGE_QUOTA_MIB`     | 200     | MiB of item images per workspace (worker)              |

Self-hosted only: `NETRICS_CUSTOM_API_PRIVATE_HOSTS` lets custom APIs reach
named hosts or address ranges on your own network (never metadata
addresses). It is off by default and never set on the hosted service; only
the custom API connector receives it, bundled connectors never do. See
[deploy/compose/README.md](../../deploy/compose/README.md).
