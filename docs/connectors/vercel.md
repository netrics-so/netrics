# Vercel connector

Reads the deployments and production state of your Vercel projects, their
visitors, page views and custom events from
[Vercel Web Analytics](https://vercel.com/docs/analytics) where it is
enabled, and this month's billing charges of each team.

## Create a token

Use a token with the smallest scope that covers the projects you want to
see.

1. In Vercel, open **Account Settings → Tokens**
   (<https://vercel.com/account/settings/tokens>).
2. Name the token (for example "netrics") and set **Scope**:
   - **one project**: the token can read only that project. This is the
     smallest scope and the right choice for a single site.
   - **a team**: the token can read all of that team's projects, and you
     choose which ones to sync when you create the connection.
   - Avoid **Full Account** tokens. If you use one anyway, enter the team's
     ID (Team Settings → General, starts with `team_`) in the connection's
     **Team ID** field.
3. Choose an expiration. When the token expires, the connection stops
   syncing and asks for a new token. Nothing collected so far is lost.
4. Click **Create**, copy the token and paste it into netrics. Vercel shows
   it only once.

Connections made before deployments were added keep working with the token
they have: the next sync reads deployments too, and the history of the new
datasets is read once in the background.

## Change which projects are synced

On the connection's page, **Edit connection → Synced projects** shows what
is selected: all current and future projects, or the selected ones by name
(by ID until a project has been named). **Change project selection** lists
every project the token can see and lets you choose all current and future
projects, or a selection.

- Every project can be selected. A project without Web Analytics is marked
  "Deployments only": its deployments and production state are synced, its
  visitor numbers stay empty, and they never show as fresh.
- A selected project is only synced while the token can see it.
- A project you remove is no longer synced and is no longer offered in
  pickers. The data it already collected is kept.
- A project you add gets its history with the next import, which reads the
  connection's history again.
- At least one project has to be selected: a selection without a project
  cannot be saved, in the app or through the API
  (`resource_selection_empty`). A connection that was saved without a
  project before this was required keeps collecting nothing new; its page
  says so, its widgets show the last values with the time they were last
  checked, and choosing a project (or all projects) makes it sync again.
- When a selected project is no longer listed (deleted, or the token lost
  access), the list says so. Restore the token's access, or remove it from
  the selection. Deleting the connection is the third way out, and also
  deletes the data it collected.

A Vercel token grants the same access you have within its scope. netrics
only reads projects, deployments, Web Analytics and billing charges with it
and changes nothing. The token is stored encrypted (AES-GCM, bound to the
connection) and is never shown or logged.

Vercel's OAuth integrations cannot read Web Analytics (there is no analytics
scope), so this connector uses tokens.

## What is collected

### Deployments

| Data                             | Meaning                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dataset `deployments`            | One row per deployment: state, target, created, build started, ready, build duration, branch, URL                                                           |
| Dataset `production_deployments` | Per project as of the last sync: the newest production deployment, the one serving traffic, and `state` (`up`, `building`, `failed`, `down`), `rolled_back` |
| Metric Deployments               | Deployments per day (UTC), project and environment (`production`, `preview`, or a custom environment), by creation time                                     |
| Metric Failed deployments        | The same, counting state `ERROR` only                                                                                                                       |

- `state` is Vercel's `readyState`: `QUEUED`, `INITIALIZING`, `BUILDING`,
  `READY`, `ERROR`, `CANCELED`, `BLOCKED` or `DELETED`. A state Vercel adds
  later is kept as it comes. `failed` is true for `ERROR` only.
- `target` is the slug of the deployment's custom environment, else
  Vercel's target; a deployment without either is a `preview`.
- `build_duration_seconds` is from build start to ready; empty while
  building and for deployments that did not finish.
- The production `state`: `building` while the newest production build
  is queued or building; else `up` while the project's production target
  points at a deployment (the one serving production traffic, also after an
  instant rollback, however old), even when a newer build failed; else
  `failed` when the newest build failed; else `down`. The `live_*` fields
  are that target's deployment, the `latest_*` fields the newest build.
- `rolled_back` is true when production points at an older build than the
  newest promoted `READY` production build (read from the newest 20 READY
  ones); `state` stays `up`, so a status widget can show "up · rolled
  back". A build that is staged or still in a rolling release
  (`readySubstate` `STAGED` or `ROLLING`) is not promoted, so production
  serving the build before it is not a rollback.
- The first sync reads deployments up to 90 days back. Every sync then
  reads each project's deployments of the last two days again: a
  deployment that finished building shows its new state, and one the
  previous sync read in those days that Vercel no longer lists was deleted
  and is removed. Older rows keep the state they had when last read. A sync
  stores the dataset once, whatever the number of projects.
- A page of deployments that ends at an instant shared with the next one
  is continued from that instant, and the deployments already read there
  are skipped: none is lost or counted twice.
- Each day of a read window gets a count for `production`, `preview` and
  every environment the previous sync saw in the re-read days, zero
  included, so a re-read day whose deployments were deleted drops to
  zero.

### Web Analytics (projects with Web Analytics enabled)

Every value is a daily count per project, dated by Vercel's reporting day
(UTC).

| Metric              | Meaning                                               |
| ------------------- | ----------------------------------------------------- |
| Page views          | Page views                                            |
| Daily visitors      | Unique visitors that day                              |
| Page views by route | The 10 busiest routes of each month, rest as "Others" |
| Visitors by country | The 10 largest countries of each month, rest "Others" |
| Custom events       | The 10 most frequent events of each month, "Others"   |

- Summing daily visitors over several days counts a returning visitor once
  per day.
- While a month is still running, its top 10 can change. A route that drops
  out keeps the daily values it already has, so summing all routes for the
  current month can slightly overcount.

### Charges this month

Dataset `billing_charges`: per team, project and product, the charges of
the current calendar month (UTC) so far, from Vercel's FOCUS billing
export. `billed_cost` is what Vercel invoices, `effective_cost` includes
discounts and commitments; both in the billing currency (USD). Charges of no
single project (seats, the plan) have an empty project ID. With a project
selection, charges of other projects are left out; team-wide charges stay.

- Only teams are billed through this export: a personal account's projects
  have no charges here.
- Charges are read one day at a time and summed, so the answer for a
  team stays small however much it is charged. A charge belongs to the day
  it starts on.
- Vercel lets the Owner, Member, Developer, Security, Billing and
  Enterprise Viewer roles read it. A token whose role may not, or a plan
  without the export (Vercel answers 400, 402, 403 or 404), leaves the
  charges as last stored, and the connection's other data syncs as usual.
  A rate limit or an outage while reading charges is retried like any
  other request. A day whose export is larger than netrics accepts for one
  answer (10 MiB) leaves the charges as last stored too; the other data
  publishes.
- Metric **Cost** (`vercel.cost`): the effective cost per day (UTC), net of
  discounts, in minor units (cents) with its currency, per project; charges
  of no single project under the team's ID as `resource`, and every value
  with its `team`. Summed over a calendar month it is the month's spend,
  rounded to the cent: the charges are summed exactly, with every decimal
  of the export (a charge of $0.0049996 stays below half a cent), and only
  the totals from the 1st are rounded. Each day is the difference of those
  rounded totals, so the days add up to the month's rounded total even
  when every day's cost is a fraction of a cent. The billed cost stays in the
  dataset.
- The cost is published only after every team's charges of every day of
  the month so far were read. When charges are not read (a refusal, an
  oversized day), the cost stays as last stored, like the dataset. Every
  day of the month so far gets a value, zero included, for each project
  and team charged this month: a project the export no longer charges on
  a day (a revised export) drops to zero instead of keeping its old
  value. A team whose charges were not read (its projects are no longer
  listed) keeps its stored cost. Reloading the history keeps this: the
  reload takes the projects and teams charged before from the previous
  sync of the same token, team and selection, so a project charged before
  the reload and no longer after it drops to zero too.

## History and refresh

- The first sync reads Web Analytics up to 366 days back (plans that keep
  less, like Hobby, as far back as Vercel allows) and deployments up to 90
  days back. Vercel's plan window moves with the current UTC day: a sync
  that goes on after midnight starts its analytics queries a day later,
  while the last day it reads stays the one it started on.
- Afterwards the connection syncs every 15 minutes and re-reads the last
  two days, which Vercel is still counting and where deployments still
  change state.
- A sync runs in short steps of one request each and records its position
  after every step: a failed request is retried alone, and a large history
  is read over several steps.
- Vercel allows a limited number of API calls per window and reports with
  every answer how many are left and when the window resets. netrics stops
  a few requests before the limit: a reset within 30 seconds is waited
  out, a later one pauses the connection until then. Its syncs, the first
  backfill included, continue right after the reset where they stopped,
  and the connection shows "Vercel limit reached, continuing at …" rather
  than an outage. The dashboard shows the last values meanwhile. A limit
  reached after other steps keeps what they read, and the next step waits
  for the same reset.
- Every request is limited to 20 seconds, and the steps of one call to
  the connector stop requesting and waiting 45 seconds after it started,
  within the host's 60: a request Vercel never answers ends in time for
  the sync to record its position, and the next call repeats only that
  step.

## When numbers arrive

Vercel counts live, so there is no day to wait for. Widgets show when
netrics last checked and when it checks next
([ADR 0025](../decisions/0025-data-freshness.md)): every completed sync,
about every 15 minutes, counts as a check. Today's numbers keep growing
until the day ends.

- Visitors and page views are checked per project. A project without Web
  Analytics is never reported as checked: its widgets show no data rather
  than a fresh zero.
- Deployments are checked per project and for the connection. When the
  listed projects' deployment and Web Analytics entries together would
  exceed the 2,000 entries a sync may report, deployments are checked for
  the connection only, by every sync of that connection, so Web Analytics
  keeps its per-project entries. netrics then removes the per-project
  deployment checks stored before, so none shows an older check than the
  connection's. A sync that cannot check the connection (a project removed
  at Vercel while the sync ran, or a selected project the token no longer
  lists) still checks every project it read completely whenever those
  entries fit; the next complete sync replaces them with the connection's
  check.
- Charges are checked for the connection when every team's charges were
  read.

## When something goes wrong

| What you see                                           | What to do                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| "Vercel rejected the access token"                     | The token expired or was revoked. Create a new one and paste it into **Edit connection**. |
| "The token cannot see any projects"                    | Give the token the project's or team's scope.                                             |
| "The token no longer has access to … projects"         | Use a token that covers them, or remove them under **Synced projects**.                   |
| "Vercel limit reached, continuing at …"                | Nothing: syncing continues after Vercel's reset.                                          |
| "Vercel's API rate limit is used up" / "not answering" | Nothing: netrics retries automatically.                                                   |
| "Vercel answered … in an unexpected shape"             | Vercel changed its API. Report it; the sync retries.                                      |

Error messages never quote Vercel's own error text. After a new token is
saved, syncing restarts right away.

## Network access

The connector only talks to `api.vercel.com`.

## Vercel's API (checked 2026-11-23)

| What          | Endpoint                                                                                                | Facts the connector relies on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects      | [`GET /v10/projects`](https://vercel.com/docs/rest-api/projects/retrieve-a-list-of-projects)            | `limit`, `from` continuation; `pagination.next` null on the last page; `webAnalytics.enabledAt` set when enabled; `teamId` scopes to a team.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Project       | [`GET /v9/projects/{idOrName}`](https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name) | `targets` maps a target name to the deployment it points at ([OpenAPI](https://vercel.com/openapi.json): `id`, `readyState`, `readySubstate`, `createdAt`, `readyAt`, `url`); `targets.production` is the deployment serving production.                                                                                                                                                                                                                                                                                                                                                      |
| Deployments   | [`GET /v7/deployments`](https://vercel.com/docs/rest-api/deployments/list-deployments)                  | Filters `projectId`, `target`, `state`, `since`/`until` (creation time, ms), `limit`, `teamId`; newest first; `pagination.next` is the timestamp to pass as `until` for the next page, null on the last. `readyState` enum: `BLOCKED BUILDING CANCELED DELETED ERROR INITIALIZING QUEUED READY`; `target`: `production`, `staging` or null; `created`, `buildingAt`, `ready` in ms; `readySubstate` `STAGED`/`ROLLING`/`PROMOTED`; `customEnvironment.slug` names a custom environment. `pagination` with `next` (null on the last page) is required: a list without it is an invalid answer. |
| Web Analytics | `GET /v1/query/web-analytics/{visits,events}/aggregate`                                                 | As read since milestone 05 (recorded fixtures): `since`/`until` days, `by`, `limit`; the plan's window is reported as a 400 naming its days.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Billing       | [`GET /v1/billing/charges`](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges)        | FOCUS 1.3 as newline-delimited JSON for one team; `from` inclusive, `to` exclusive (ISO, UTC); one-day granularity, at most a year; roles Owner, Member, Developer, Security, Billing, Enterprise Viewer. `Tags` carry the project ID and name (read as `ProjectId`/`ProjectName`).                                                                                                                                                                                                                                                                                                           |
| Rate limits   | [Limits](https://vercel.com/docs/limits#rate-limits)                                                    | "Deployments list per minute": 1000 per 60 s per user. Every answer reports `x-ratelimit-remaining` and `x-ratelimit-reset`; 429 when used up. The connector declares 400 requests a minute to the host.                                                                                                                                                                                                                                                                                                                                                                                      |

Open points: the billing export's tag names are documented only as
"ProjectId and ProjectName information"; the connector reads `ProjectId`
and `ProjectName` (or their lowercase forms) and treats a charge without
them as team-wide. Vercel does not document whether `until` is inclusive;
the connector skips a deployment at the `until` it asked with, so a page
boundary never counts one twice (if it is exclusive, a second deployment
created in the very millisecond a page ends at could be missed until the
next re-read). Deletions are found by comparing with the deployments the
previous sync read in the re-read days, which its final cursor carries: a
backfill that starts without it, or a project with more than 2,000
deployments in two days, removes nothing.
