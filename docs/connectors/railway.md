# Railway connector

Reads deployments, the current state of every service and an estimate of
this month's cost from [Railway](https://railway.com), per project, through
Railway's public GraphQL API. The connector only reads: every request is a
GraphQL query, never a mutation, so it cannot deploy, restart or change
anything.

Railway is a preview connector (milestone 13.1): it is listed in
development, and in production only when the operator names it in
`NETRICS_PREVIEW_CONNECTORS` (see `deploy/compose/README.md`), until the
milestone's exit gate passes.

## Create a token

1. In Railway, open **Account Settings → Tokens**
   (<https://railway.com/account/tokens>).
2. Under **Workspace**, choose:
   - **a workspace**: a workspace token. It reads only that workspace and
     can be shared with teammates. Enter the workspace's ID in the
     connection's **Workspace ID** field (Workspace Settings → General).
   - **No workspace**: an account token. It sees every workspace you belong
     to; netrics reads all of them, or only the one whose ID you enter.
3. Name the token (for example "netrics"), click **Create** and copy it.
   Railway shows it only once.

Project tokens are not supported: they read one environment of one project
and cannot read usage. Railway has no read-only token kind; netrics only
sends queries with it. The token is stored encrypted (AES-GCM, bound to the
connection) and is never shown or logged.

The connection check reads the workspace list (`me`, account tokens) or the
configured workspace (`workspace`), then one project. When Railway answers
"Not Authorized" the check fails with a reason:

| Code                       | When                                                                      |
| -------------------------- | ------------------------------------------------------------------------- |
| `railway.token_rejected`   | No workspace ID, and the token is wrong, deleted, or a workspace token    |
| `railway.workspace_denied` | The workspace ID is wrong, or the token does not belong to that workspace |

## What is collected

Resources are Railway projects (the `resource` dimension), so a project's
numbers can be linked to a workspace project like any other connection
resource. Services and environments are discovered as the `service` and
`environment` dimensions, so dashboards show their names.

Metrics:

| Key                          | What                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `railway.deployments`        | Deployments per UTC day, project, service and environment, by creation time                        |
| `railway.failed_deployments` | Of those, the ones that are FAILED or CRASHED                                                      |
| `railway.cost`               | One UTC day's usage per project at list prices (cents of USD); a month adds up to the month so far |
| `railway.estimated_cost`     | Railway's estimate of the usage up to the end of the billing period, at list prices                |

Datasets:

- `deployments` (upsert): one row per deployment: project, service,
  environment, status, failed, created, status changed, finished and
  duration. `finished_at` and `duration_seconds` are only set for SUCCESS,
  FAILED and SKIPPED: for later statuses (REMOVED when a newer deployment
  replaced it, CRASHED, SLEEPING) Railway's `statusUpdatedAt` is no longer
  the end of the deployment.
- `service_states` (snapshot): one row per service and lasting
  environment (PR environments are left out by Railway's `isEphemeral:
false` filter; environments and service instances are read page by page)
  with its latest deployment and a `state`:
  - `building`: the latest deployment is queued, waiting, needs approval,
    initializing, building or deploying;
  - `up`: a deployment is running (an active SUCCESS deployment), even when
    a newer one failed;
  - `sleeping`: the running deployment sleeps until a request wakes it;
  - `failed`: nothing runs, and a deployment failed or crashed;
  - `down`: nothing runs (removed, skipped or never deployed).
- `project_usage` (snapshot): per project this calendar month (UTC): CPU
  (vCPU minutes), memory (GB minutes), egress (GB), volume storage (GB
  minutes), the estimated cost so far and Railway's estimate for the billing
  period, in USD. It is replaced only when today's usage of every workspace
  was read; otherwise the stored snapshot stays. The estimate column is
  empty when Railway refused the estimate.

Deployment rows of PR environments carry their environment ID; their name
is empty, as the state reads lasting environments only. Discovery names
them.

### Freshness (ADR 0025)

- **Deployments and state** (`deploys`, continuous): every completed sync
  reads the current state; deployments of the last two days are read again
  on every sync, so their status follows Railway (building → success).
  Older deployment rows keep the status they had then; `service_states` is
  always current. A project deleted during a sync leaves the stream
  unreported for that sync.
- **Cost** (`cost`, periodic, UTC days): Railway counts usage continuously,
  so a UTC day is complete at midnight UTC. A sync reports the day before
  today as the last complete day, only when every workspace's usage was
  read.
- **Cost estimate** (`cost_estimate`, continuous): Railway's estimate,
  reported when every workspace's estimate was read.

### How a sync proceeds

A sync is a run of steps that each send one request: the workspaces, a page
of projects, a page of a project's environments or of an environment's
service instances, a page of its deployments, one day's usage of one
workspace, one workspace's estimate. A sync page runs at most ten requests
and checkpoints the next step in its cursor, so a failure or a rate limit
repeats one step, not a page of them. The cursor belongs to the connection
and its workspace ID: after a change of the workspace ID the next sync
starts a new run. Snapshots are completed by the run's last page only.

## How cost is estimated

Railway's public API has no money amount per project. `usage` and
`estimatedUsage` answer resource quantities (`MetricMeasurement`), so the
connector prices them with Railway's list prices for containers
([Pricing Plans](https://docs.railway.com/reference/pricing/plans), checked
2026-11-23):

| Measurement       | Price                                               |
| ----------------- | --------------------------------------------------- |
| `CPU_USAGE`       | $20 per vCPU per month ($0.000463 per vCPU-minute)  |
| `MEMORY_USAGE_GB` | $10 per GB per month ($0.000231 per GB-minute)      |
| `NETWORK_TX_GB`   | $0.05 per GB egress                                 |
| `DISK_USAGE_GB`   | $0.15 per GB per month ($0.000003472 per GB-minute) |

The units of the usage values are not documented next to the API; the
connector assumes per-minute values, as the per-minute prices are. The
estimate leaves out the plan's subscription fee, the usage the plan
includes, credits and discounts, VM rates (sandboxes, agents), backups and
anything Railway bills apart. Cost is per calendar month (UTC); Railway's
own estimate (`railway.estimated_cost`) is per billing period, which starts
on the subscription's day. A token that may list projects but not read
usage (Railway supports `usage` with workspace tokens) syncs everything
else, without cost.

Usage is read for the days of the sync window in this and the previous
calendar month: one request per day and workspace, plus one for the day
before the first.

## Railway's API, as checked on 2026-11-23

- Endpoint: `https://backboard.railway.com/graphql/v2`
  ([Public API](https://docs.railway.com/reference/public-api)). Account
  and workspace tokens use `Authorization: Bearer`, project tokens
  `Project-Access-Token`. `me` works with account tokens only, `workspace`
  with workspace tokens for their own workspace.
- Errors come back as HTTP 200 with `errors`, for example `Not Authorized`
  for a wrong token and `Workspace not found` for an ID the token cannot
  see. The recorded answers are in
  `packages/connectors/src/railway/fixtures/`.
- Rate limits ([Public API](https://docs.railway.com/reference/public-api),
  [API reliability](https://railway.com/api-reliability.md)): 100 requests
  an hour on Free, 1,000 on Hobby, 10,000 on Pro; 10 (Hobby) or 50 (Pro) a
  second. Answers carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset` and, after a 429, `Retry-After`. The connector stops
  five requests before the window ends and hands a later reset to the host.
- Pagination: Relay connections with `first` / `after` and
  `pageInfo { hasNextPage endCursor }`. Deployments are listed newest first
  (`deployments(input: { projectId })`); the connector stops at the first
  page that reaches back before the window.
- `DeploymentStatus`: BUILDING, CRASHED, DEPLOYING, FAILED, INITIALIZING,
  NEEDS_APPROVAL, QUEUED, REMOVED, REMOVING, SKIPPED, SLEEPING, SUCCESS,
  WAITING ([Manage Deployments](https://docs.railway.com/guides/manage-deployments)
  lists ten of them; the schema has all thirteen). A status Railway adds
  later is stored as Railway names it.
- The schema is the contract: additive changes never break an existing
  query. The connector's queries were validated against the live schema on
  2026-11-23 (Railway validates a query before it checks the token).

A sync with N projects (each with up to ten lasting environments) sends
about 2 + 2N requests, plus per workspace one usage request per day read
and one for the day before (an incremental sync reads three days) and one
estimate: about 7 + 2N for one workspace. A five-minute interval needs the
Hobby plan or larger for more than a few projects.
