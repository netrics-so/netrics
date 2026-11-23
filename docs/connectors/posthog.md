# PostHog connector

Reads daily events, pageviews and active users per project from
[PostHog](https://posthog.com), the most frequent events per day, and the
results of saved trends insights you choose. It works with PostHog Cloud US,
PostHog Cloud EU and a self-hosted PostHog. The connector only reads: it
lists organizations, projects and insights, and runs read-only queries on
PostHog's query endpoint. It never calls an endpoint that changes anything.

PostHog is a preview connector (milestone 13.1): it is listed in
development, and in production only when the operator names it in
`NETRICS_PREVIEW_CONNECTORS` (see `deploy/compose/README.md`), until the
milestone's exit gate passes.

## Create a personal API key

1. In PostHog, open **Settings → Personal API keys**
   (<https://us.posthog.com/settings/user-api-keys>, or the same page on
   EU Cloud or your own instance).
2. Click **Create personal API key** and name it (for example "netrics").
   Under its access scope, choose the organization or the projects netrics
   should read.
3. Choose the scopes **Organization: Read**, **Project: Read**, **Query:
   Read** and **Insight: Read**, click **Create** and copy the key. PostHog
   shows it only once.
4. In netrics, choose the **Region**: `us` for PostHog Cloud US
   (`us.posthog.com`), `eu` for PostHog Cloud EU (`eu.posthog.com`), or
   `self-hosted` with your instance's **Host** (for example
   `posthog.example.com`), and paste the key.

After connecting, choose the projects to sync (all of them, or some). Each
project is a resource that can be linked to a workspace project, like a
Vercel or Railway project.

The key is stored encrypted (AES-GCM, bound to the connection) and is never
shown or logged. PostHog has no read-only key kind apart from the scopes;
netrics never sends anything but the reads below.

The connection check reads one page of organizations, one project and runs
the query `SELECT 1` in it (which needs `query:read`), and, when insights are
configured, lists one insight. It fails with a reason:

| Code                       | When                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| `posthog.key_rejected`     | PostHog answers 401: a wrong or deleted key, or a key of another region |
| `posthog.scope_missing`    | PostHog answers 403 naming a missing scope                              |
| `posthog.host_invalid`     | `self-hosted` without a valid host (see below); nothing is sent         |
| `posthog.insights_invalid` | An entry of **Saved insights** is not an insight link, or more than 20  |

### Self-hosted PostHog

The **Host** is a host name, or an `https://` origin without a path: a
name with at least one dot, no IP address, no port. The connection reaches
that host only: since SDK 0.2.20 a manifest can name config keys whose value
the host adds to that connection's egress allowlist (`configuredHosts`), and
the PostHog connector names `host`. The egress guard still refuses private,
loopback and metadata addresses, so the instance must be reachable from the
internet over https. A PostHog on a private network is not supported (the
private-host allowance of self-hosted netrics applies to custom APIs only).

## What is collected

Metrics, per project (the `resource` dimension) and UTC day:

| Key                 | What                                                                             |
| ------------------- | -------------------------------------------------------------------------------- |
| `posthog.events`    | All events (PostHog's "All events", `math: total`)                               |
| `posthog.pageviews` | `$pageview` events                                                               |
| `posthog.dau`       | Distinct people with an event that day (`math: dau`)                             |
| `posthog.wau`       | Distinct people with an event in the 7 days through that day (`weekly_active`)   |
| `posthog.mau`       | Distinct people with an event in the 30 days through that day (`monthly_active`) |

The numbers are PostHog's own: one `TrendsQuery` per project and window
with five series, the same query PostHog's trends insights run. Test
accounts are not filtered out (`filterTestAccounts: false`). Days are UTC
days whatever the project's time zone (the `convertToProjectTimezone: false`
modifier), so a project in another zone shows slightly different day
boundaries than PostHog's own charts.

Datasets:

- `top_events` (upsert): the ten most frequent event names per project and
  UTC day, with their counts and rank, from one HogQL query per window
  (`… GROUP BY day, event … LIMIT 10 BY day`). The key is project, day and
  rank, so a day read again replaces its ranks and an event that drops out
  of the top leaves no stale row.
- `insight_results` (snapshot): the results of the configured saved
  insights, as PostHog last computed them: one row per series (a breakdown
  value or comparison is a series of its own) and time bucket, with the
  bucket's start date for daily, weekly and monthly insights, or the bucket
  `total` for a single-number insight. Replaced as a whole only when every
  insight was read or definitively left out; otherwise the stored snapshot
  stays.
- `insights` (snapshot): what became of each configured insight on the last
  sync: `ok`, `not_found` (deleted or unknown), `unsupported` (not a trends
  insight, or an interval other than day, week or month), `too_large` (more
  than 5,000 rows), `not_selected` (its project is not synced), `denied`
  (PostHog refused it) or `not_ready` (PostHog has not computed it). The
  last two keep the stored `insight_results`.

### Saved insights

**Saved insights** takes the links of saved trends insights, copied from
the browser (`https://us.posthog.com/project/12345/insights/AbCd1234`), or
`12345/AbCd1234`, separated by spaces or commas, at most 20. Each insight is
read with `GET /api/projects/{project}/insights/?short_id=…&refresh=blocking`:
PostHog answers its cached result when it is fresh, and computes it
otherwise, with the insight's own date range, filters and breakdowns.

### Freshness (ADR 0025)

- **Daily numbers** (`analytics`, periodic, UTC days, one entry per
  project): a sync that read a project's whole window reports the day
  before today as its last complete day. Today's numbers are sent too and
  grow during the day. A project PostHog refuses (403, 404), or whose
  PostHog refuses the query (400, say an older self-hosted version), is
  skipped for the rest of the run and its entry is not reported, so it shows
  as stale; the other projects go on.
- **Insights** (`insights`, continuous): reported when every configured
  insight was read or definitively left out.

### How a sync proceeds

A sync is a run of steps that each send at most one request: a page of
organizations, a page of an organization's projects (only the selected ones
are kept), per project and window of up to 31 days the trends query and
then the top-events query, and one request per configured insight. A sync
page runs at most five steps, and none starts after 20 seconds, since one
PostHog query may run for ten. The page checkpoints the next step in its
cursor:

- a step that fails first on its page fails the page, and the host retries
  that step (or waits for a rate limit's reset);
- a step that fails after others succeeded ends the page with what they
  read, so the next page repeats that step only;
- a missing key or scope fails at once.

The cursor belongs to the connection, the host, the project selection, the
configured insights and a hash of the key, never the key: a change of any
of them starts a new run. A run uses the day it started as "today" on every
page; values read live (an insight's results) carry the time they were
read. Rows go out on pages before the last; the last page only completes
the run's refreshes (ADR 0026), and only those that were read whole. An
incremental sync reads the last two days again: PostHog ingests late events
(offline clients, imports).

A sync with N projects and I insights sends 2 + 2N + I requests on an
incremental run (a window of three days), plus one listing page per further
organization and per further hundred projects; a 90-day backfill sends
2 + 6N + I.

## PostHog's API, as checked on 2026-11-23

- Hosts ([API overview](https://posthog.com/docs/api)): the private API is
  on `https://us.posthog.com` (US Cloud) and `https://eu.posthog.com` (EU
  Cloud); the `*.i.posthog.com` hosts are for ingestion and are not used. A
  self-hosted instance serves the same API on its own domain.
- Authentication: `Authorization: Bearer <personal API key>`
  ([Personal API keys](https://posthog.com/docs/api/personal-api-keys)).
  Keys carry scopes and an access scope (an organization, some projects, or
  all). The scope of each endpoint, from PostHog's OpenAPI schema
  (`https://us.posthog.com/api/schema/`):

  | Request                                              | Scope               |
  | ---------------------------------------------------- | ------------------- |
  | `GET /api/organizations/`                            | `organization:read` |
  | `GET /api/organizations/{organization_id}/projects/` | `project:read`      |
  | `POST /api/projects/{project_id}/query/`             | `query:read`        |
  | `GET /api/projects/{project_id}/insights/`           | `insight:read`      |

  A wrong key answers 401 (`authentication_failed`), a missing scope 403
  with "API key missing required scope '…'" (recorded shapes in
  `packages/connectors/src/posthog/fixtures/`).

- Queries ([Query API](https://posthog.com/docs/api/queries)): `POST` with
  `{ query: { kind, … }, refresh, name }`. `refresh: "blocking"` (the
  default) runs synchronously unless fresh results are cached. HogQL returns
  100 rows without a `LIMIT` of its own and up to 50,000 with one; a query
  runs for at most ten seconds and may wait up to 30 seconds for a slot.
  The connector sends `TrendsQuery` and `HogQLQuery` nodes only, and its
  top-events query has its own `LIMIT`: an answer that reaches it, or says
  `hasMore`, is refused as possibly cut off.
- Rate limits ([API overview](https://posthog.com/docs/api),
  [Query API](https://posthog.com/docs/api/queries)), counted per key:
  queries 2,400 an hour and 240 a minute with three running at once (some
  older plans 120 queries an hour), plus an hourly read budget; analytics
  endpoints such as insights 240 a minute and 1,200 an hour; other reads
  480 a minute and 4,800 an hour. A 429 carries `Retry-After`
  (`api_queries_budget_exceeded` for the query budget). The connector waits
  for a reset up to ten seconds away and hands a later one to the host,
  which runs the connection again after it.
- Pagination: listings answer `{ count, next, previous, results }` with
  `limit` and `offset`. The connector follows only the `offset` of `next`
  on the connection's own host (a self-hosted proxy may put `http://` in
  it), and refuses a page that has more entries than it reached without a
  `next`, or a `next` that does not move forward.
- Insights: `GET /api/projects/{project_id}/insights/` filters by
  `short_id` and takes `refresh` (default `force_cache`, which never
  computes); the insight's `query` is an `InsightVizNode` whose `source`
  says the kind (`TrendsQuery`) and `interval`. A trends `result` is a list
  of series with `data`, `days`, `label`, `breakdown_value`,
  `compare_label` and `action.order`, or `aggregated_value` for a
  single-number display.

## What PostHog's API does not give, or the connector leaves out

- PostHog's own bill: the API has no billing or usage cost per project, so
  "what does it cost" has no PostHog number.
- Funnels, retention, paths, stickiness, lifecycle and SQL insights, and
  hourly or finer intervals: their results do not fit the per-bucket rows
  and are reported as `unsupported`.
- Days in the project's own time zone (see above), persons, sessions,
  recordings, feature flags and experiments.
- A real-key check of the queries: no PostHog account was available while
  this connector was written. The request and answer shapes follow
  PostHog's documentation and OpenAPI schema, and the HogQL grammar's
  `LIMIT … BY`; the first real connection should confirm them.
