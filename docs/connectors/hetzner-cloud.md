# Hetzner Cloud connector

Reads the servers of a [Hetzner Cloud](https://www.hetzner.com/cloud)
project with their current state, each server's CPU, disk and network
metrics per hour, and an estimate of the project's monthly cost, through the
Hetzner Cloud API. The connector only reads: every request is a GET of a
listing, so it cannot start, stop, rebuild or delete anything.

Hetzner Cloud is a preview connector (milestone 13.1): it is listed in
development, and in production only when the operator names it in
`NETRICS_PREVIEW_CONNECTORS` (see `deploy/compose/README.md`), until the
milestone's exit gate passes.

## Create a token

1. In the [Hetzner Console](https://console.hetzner.com/), open the project
   netrics should read.
2. Go to **Security → API tokens** and click **Generate API token**.
3. Name the token (for example "netrics"), choose **Read** and copy it.
   Hetzner shows it only once.

A token belongs to one project, so a connection reads one Hetzner project;
add a connection per project. **Read** is enough: Hetzner limits a Read
token to GET requests
([Generating an API token](https://docs.hetzner.com/cloud/api/getting-started/generating-api-token)).
The API has no endpoint that tells a token's permission, so the connection
check cannot say whether a token can also write; netrics never sends
anything but GET, and the setup steps ask for a Read token. The token is
stored encrypted (AES-GCM, bound to the connection) and is never shown or
logged.

The connection check reads one server (`GET /servers?per_page=1`) and the
price list (`GET /pricing`). It fails with a reason when:

| Code                            | When                                                              |
| ------------------------------- | ----------------------------------------------------------------- |
| `hetzner_cloud.token_rejected`  | Hetzner answers 401 `unauthorized`: the token is wrong or deleted |
| `hetzner_cloud.token_forbidden` | Hetzner answers 403 `forbidden` to a listing the sync needs       |

A 403 `maintenance` or a 5xx is an outage, not a token problem: the check
and the sync throw, and the host tries again later.

## What is collected

**Resources** are the project's servers (the `resource` dimension, the ID
Hetzner gives them), so each server can be linked to a workspace project.
The Hetzner project itself is not a resource: it is the connection (a token
reads exactly one project, and the API names no project ID), and a project
on Hetzner often runs several products, which is why servers are the unit
that links. Labels are in the `servers` dataset, so a preparation can also
map servers to workspace projects by label. Load balancers are resources
too (`lb-<id>`, as Hetzner numbers them apart from servers), for their cost;
volumes and IPs attached to neither are the `unattached` resource.

Metrics:

| Key                          | What                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `hetzner-cloud.cpu`          | Average CPU usage per hour, percent of all the server's vCPUs                         |
| `hetzner-cloud.disk_read`    | Average bytes per second read from the first disk, per hour                           |
| `hetzner-cloud.disk_write`   | Average bytes per second written to the first disk, per hour                          |
| `hetzner-cloud.network_in`   | Average bytes per second received on the public interface, per hour                   |
| `hetzner-cloud.network_out`  | Average bytes per second sent on the public interface, per hour                       |
| `hetzner-cloud.monthly_cost` | Estimated monthly cost per server or load balancer (net, minor units of the currency) |

Hetzner's CPU value is per vCPU (100 is one vCPU fully used); the connector
divides it by the server's vCPUs, so 100 % is the whole server. Samples are
read at Hetzner's one-hour step and stamped at the start of the UTC hour
their timestamp falls in; an hour is read once it ended ten minutes ago.

Datasets:

- `servers` (snapshot): one row per server: name, status, `state`, server
  type, vCPUs, memory, disk, location (city, country, network zone),
  labels, whether backups are on, created, traffic this billing period
  (outgoing, incoming, included; bytes) and when it was read. Labels that
  would make a row larger than 64 KiB are left out (null) rather than the
  server. `state` is what the status widget shows:

  | Hetzner status                                        | `state`    |
  | ----------------------------------------------------- | ---------- |
  | `running`                                             | `up`       |
  | `initializing`, `starting`, `rebuilding`, `migrating` | `building` |
  | `stopping`, `off`, `deleting`                         | `down`     |
  | `unknown`, or a status Hetzner adds later             | `unknown`  |

  Hetzner has no failed status: a server that hangs is still `running` to
  the API (a health check sees it). The API says nothing about when a
  status changed; `checked_at` is when netrics read it.

- `cost_items` (snapshot): every billable item at its monthly list price,
  net and gross, with the server or load balancer it belongs to: servers,
  their backups, volumes, primary IPs, floating IPs, load balancers. A
  price the list does not have (a type or location missing from it) is
  empty.

### Freshness (ADR 0025)

Each stream is one read that can fail on its own:

- **Servers** (`servers`, continuous): reported when the whole server list
  was read in one consistent listing (see below) and no server disappeared
  during the run.
- **Metrics** (`metrics`, continuous, per server): reported for each server
  whose metrics window was read whole. A server whose metrics are refused
  (403) is skipped and only that server goes stale. When no hour completed
  since the last sync, nothing is read and every server is current.
- **Cost estimate** (`cost`, continuous): reported when the price list and
  every listing were read consistently and every item had a price.

### How a sync proceeds

A sync is a run of steps that each send one request: the price list; a
page (50 items, by ID) of servers, volumes, primary IPs, floating IPs, load
balancers; one server's metrics for up to 20 days. A sync page runs at most
ten requests and 20 seconds, and checkpoints the next step in its cursor.
A failure in the first step of a page fails the page (the host retries
it); a failure after successful steps returns what was read, and the next
page starts with the failed step. A 401 always fails at once. A rate limit
stays a rate limit: when a later step hits it, the progress goes out and
the next page hands the limit to the host before it sends anything.

The cursor belongs to the connection and its token (a salted, shortened
hash, never the token); another token starts a new run. A run uses the time
it started for the metrics window and the cost day; rows carry the time
they were read. Rows go out on pages before the last; the last page carries
nothing but the empty pages that complete the snapshots, and only those
that were read whole.

Hetzner pages by position. An item created or deleted between two pages of
a listing shifts the rest, so a page may repeat an item or leave one out:
the connector drops a repeated item and, when an item repeats or
`total_entries` changes between pages, does not complete the snapshot (the
stored one stays) and reports no freshness for it. A server that answers
404 to its metrics was deleted during the run: neither snapshot is
completed, so its row never stays in a completed one. A listing whose
pagination is inconsistent (more pages announced but no next page, a
skipped page, a next page after an empty one) fails the step.

## How cost is estimated

The Cloud API has no invoices or usage amounts. The estimate is the monthly
price on Hetzner's own price list (`GET /pricing`, in the project owner's
currency, net and gross of VAT) of what the project holds now:

| Item          | Price                                                                                 |
| ------------- | ------------------------------------------------------------------------------------- |
| Server        | `server_types[name].prices[location].price_monthly`                                   |
| Backups       | `server_backup.percentage` of the server's monthly price, when `backup_window` is set |
| Volume        | size (GB) × `volume.price_per_gb_month`                                               |
| Primary IP    | `primary_ips[type].prices[location].price_monthly` (IPv6 is listed at 0)              |
| Floating IP   | `floating_ips[type].prices[home_location].price_monthly`                              |
| Load balancer | `load_balancer_types[name].prices[location].price_monthly`                            |

The metric is the net amount per server (with its backups, attached
volumes and IPs), load balancer and `unattached`, in minor units of the
currency, stamped on the UTC day the run started. Amounts are computed
exactly (decimal strings, no floating point) and rounded half up to the
minor unit once per resource. A resource with an item the price list has no
price for gets no value, and the run reports no cost freshness.

Not included: traffic beyond what a server or load balancer includes
(`servers` shows the traffic so far), snapshots and images
(`image.price_per_gb_month`), Object Storage, Storage Boxes and dedicated
servers (not in the Cloud API), resources that existed for part of the
month only (Hetzner bills by the hour up to the monthly price), discounts
and credits. Hourly prices are not used.

## Hetzner Cloud's API, as checked on 2026-11-23

From the [API reference](https://docs.hetzner.cloud/reference/cloud) and
its [OpenAPI document](https://docs.hetzner.cloud/cloud.spec.json):

- Endpoint `https://api.hetzner.cloud/v1`, `Authorization: Bearer <token>`;
  a token is bound to one project (Overview → Authentication).
- Pagination (Overview → Pagination): `page` (from 1) and `per_page`
  (default 25, at most 50); answers carry `meta.pagination` with `page`,
  `per_page`, `previous_page`, `next_page`, `last_page`, `total_entries`
  (the last four may be null). The `Link` header is deprecated and removed
  on 2027-04-01
  ([changelog](https://docs.hetzner.cloud/changelog#2026-10-12-link-header-deprecation));
  the connector reads `meta.pagination` only. Every listing it reads sorts
  by `id:asc`.
- Rate limits (Overview → Rate Limiting): 3,600 requests an hour per
  project by default, refilled continuously (one a second at that limit);
  answers carry `RateLimit-Limit`, `RateLimit-Remaining` and
  `RateLimit-Reset` (UNIX seconds until the budget is full); a 429 has the
  code `rate_limit_exceeded`. The connector waits up to 15 seconds for the
  budget to refill and stops at 20 remaining requests; a longer wait goes
  to the host as a rate limit.
- Errors (Overview → Errors): `{ "error": { "code", "message", "details" } }`;
  401 `unauthorized`, 403 `forbidden` or `maintenance`, 404 `not_found`,
  429 `rate_limit_exceeded`, 5xx. The connector classifies by status and
  code and never repeats Hetzner's message.
- Server statuses (`GET /servers`): `running`, `initializing`, `starting`,
  `stopping`, `off`, `deleting`, `migrating`, `rebuilding`, `unknown`.
  Servers and primary IPs carry `location`; their `datacenter` property was
  removed on 2026-07-01
  ([changelog](https://docs.hetzner.cloud/changelog#2026-07-01-removing-datacenters)).
  Unassigned primary IPs answer `assignee_type: "unassigned"`
  ([changelog](https://docs.hetzner.cloud/changelog#2026-09-23-primary-ips-unassigned)).
- Metrics (`GET /servers/{id}/metrics`): `type` `cpu`, `disk`, `network`
  (comma-separated for several), `start` and `end` (RFC 3339), `step`
  (seconds). At most 500 samples per answer (Hetzner widens the step
  beyond); metrics are kept for 30 days. CPU is per vCPU. The connector asks
  for 480 hours per request at a 3,600-second step, so a first sync reads
  30 days in two requests per server.
- Pricing (`GET /pricing`): the project owner's currency and VAT rate, net
  and gross per item, monthly and hourly prices per location for server
  types, load balancer types, primary IPs and floating IPs, a per-GB price
  for volumes and images, and the backup percentage. Traffic prices are per
  type and location since 2024
  ([changelog](https://docs.hetzner.cloud/changelog#2024-07-25-cloud-api-returns-traffic-information-in-different-format)).
- Token permission (Read or Read & Write) is not readable through the API.

The fixtures in `packages/connectors/src/hetzner-cloud/fixtures/` follow
the documented schemas and examples; they are not recordings of a real
project.

## Request budget

A sync with S servers, V volumes, P primary IPs, F floating IPs and L load
balancers sends 1 + ⌈S/50⌉ + ⌈V/50⌉ + ⌈P/50⌉ + ⌈F/50⌉ + ⌈L/50⌉ requests,
plus one metrics request per server when an hour completed since the last
sync (two per server on a first sync of 30 days). At a five-minute interval
a project with 50 servers uses about 12 × 6 + 50 = 122 requests an hour,
well inside Hetzner's 3,600.
