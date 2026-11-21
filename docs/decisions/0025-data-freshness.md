# 0025 — Data freshness: covered day, next expected, sync timing

Status: accepted design (2026-11-16;
[#701](https://github.com/netrics-so/netrics/issues/701), milestone 11.2).
Implemented by #702 (SDK, storage, scheduler), #703 (connectors), #704
(widget data and device payload), #705 (web) and #706 (netrics TV). It
describes no shipped behaviour yet. Amended 2026-11-19 by #784: widgets
that combine sources list each source's freshness (sections 7 and 8). Amended
2026-11-20 by #378: an empty window of days the connection has read
completely sums to 0 (section 9).

Extends ADR 0015 (widgets), ADR 0018 section 5 (freshness footer) and
ADR 0022 (models and their sources).

## Context

A widget shows when netrics last synced its connection, and nothing else
about time. Metric widgets carry `updatedAt`, the connection's
`lastSuccessAt` (`packages/contracts/src/index.ts:3047-3049`, `:3113-3115`);
measure widgets carry `sourceHealth`, one entry per source connection with
its status and `lastSuccessAt` (`packages/contracts/src/dashboard-data.ts:117-139`,
built by `modelSourceHealth` in `apps/server/src/dashboards/data.ts:139`).
The web footer words it as "updated 2 min ago · Source"
(`apps/web/src/components/studio/widget-parts.tsx:56-75`). A widget is
`stale` when the last success is older than three poll intervals, at least
15 minutes (`apps/server/src/devices/dashboard.ts:123-127`).

What a viewer cannot see:

- **Which day the numbers cover.** A sync at 09:00 in Berlin has App Store
  Connect sales up to the day before yesterday; at 21:30 it has yesterday.
  "Updated 5 min ago" looks the same both times.
- **When the next numbers come.** The publication rules live only in
  connector code. App Store Connect's `latestReportDay()`
  (`packages/connectors/src/app-store-connect/probes.ts:109-112`) expects
  the Pacific Time day D from 12:00 PT on D+1, about 21:00 in Berlin.

The cadence differs by kind of data, within one connector:

| Connector         | Data                  | How it arrives                                                                 |
| ----------------- | --------------------- | ------------------------------------------------------------------------------ |
| App Store Connect | Sales and proceeds    | Daily report per PT day, from about 12:00 PT the next day; last 3 days re-read |
| App Store Connect | App Store analytics   | Daily instances; a day is complete two to three days later; 7 days re-read     |
| App Store Connect | Reviews               | Continuously (Customer Support key)                                            |
| App Store Connect | Listing ratings       | A snapshot per UTC day, taken at each sync                                     |
| Google Play       | Installs, ratings     | Report files per package and month in Cloud Storage, days behind               |
| Google Play       | Earnings              | Monthly files                                                                  |
| Google Play       | Listing ratings       | A snapshot per UTC day, taken at each sync                                     |
| Search Console    | Performance           | Final data two to three days behind (PT days); last 5 days re-read             |
| Vercel            | Visitors, page views  | Counting live; today and yesterday re-read                                     |
| Apple Ads         | Spend, taps, installs | Days of the ad account's own time zone; settles over a few days                |

Syncs run on a fixed interval per connection: `poll_interval_seconds` on
`connection_state`, copied from the manifest's `minRefreshIntervalSeconds`
(`packages/connector-sdk/src/manifest.ts:308`): 6 h for App Store Connect,
Google Play, Search Console and Apple Ads, 15 min for Vercel. The scheduler
enqueues due connections and advances `next_due_at` by the interval
(`apps/server/src/scheduler.ts:60-131`); a succeeded run sets
`lastSuccessAt` and `nextDueAt = now + interval`
(`apps/server/src/sync/engine.ts:1029-1047`); a failed run only counts
`consecutiveFailures` and sets `authState` (`engine.ts:459-512`). Yesterday's
App Store sales can therefore wait up to 6 h after Apple publishes them.
The connection's cursor is opaque to the host and says nothing about
coverage.

`SyncResult` (`packages/connector-sdk/src/transport.ts:118-150`, SDK 0.2.12)
has taken optional fields before (`reviews` in 0.2.8, `receivedDatasets` in
0.2.12). tvOS decodes the device payload leniently
(`apps/netrics-tv/NetricsKit/Sources/NetricsKit/ModelsV2.swift:47`), so new
optional payload fields do not break released builds.

## Decision

### 1. Freshness streams in the manifest

A **freshness stream** is a part of a connector's data that the provider
publishes on one cadence. **SDK 0.2.13** adds the optional manifest field
`freshnessStreams`:

```ts
freshnessStreams?: Array<{
  key: string; // "sales"; unique in the manifest
  name: string; // "Sales"; translatable like metric names (ADR 0016)
  kind: "periodic" | "continuous";
  period?: "day" | "month"; // periodic only; default "day"
  timeZone?: string; // IANA zone of the provider's days; required for periodic
  metrics?: string[]; // metric keys of this manifest
  datasets?: string[]; // source dataset keys of this manifest
}>;
```

- **periodic**: the provider publishes complete periods (a day, a month).
  The stream has a last complete day and, usually, a time when the next
  period is expected. `period: "month"` marks streams published by
  calendar month (Play earnings); their screens name the month, not a day.
- **continuous**: the provider changes the data at any time (reviews,
  live visitor counts, rating snapshots). There is no "next period"; the
  next check is the next sync.

Validation: keys unique; every named metric and dataset exists; a metric or
dataset belongs to at most one stream; a periodic stream has a valid
`timeZone`, and a dataset in it that declares `reportingTimeZone` declares
the same zone. Metrics and datasets in no stream have no freshness and
behave as today. Membership is static: it never depends on credentials or
configuration.

The first streams (#703 confirms details against the provider's
documentation and the connector code):

| Connector         | Stream            | Kind            | Time zone                 | Members                                          |
| ----------------- | ----------------- | --------------- | ------------------------- | ------------------------------------------------ |
| App Store Connect | `sales`           | periodic        | America/Los_Angeles       | sales metrics, `sales_rows`                      |
| App Store Connect | `analytics`       | periodic        | America/Los_Angeles       | impressions, product page views, store downloads |
| App Store Connect | `reviews`         | continuous      | —                         | review metrics (and review text)                 |
| App Store Connect | `listing_ratings` | continuous      | —                         | `store_ratings`                                  |
| Google Play       | `installs`        | periodic        | America/Los_Angeles       | `install_rows`                                   |
| Google Play       | `earnings`        | periodic, month | America/Los_Angeles       | `earning_rows`                                   |
| Google Play       | `ratings`         | periodic        | America/Los_Angeles       | `rating_rows`                                    |
| Google Play       | `listing_ratings` | continuous      | —                         | `store_ratings`                                  |
| Search Console    | `performance`     | periodic        | America/Los_Angeles       | all metrics                                      |
| Vercel            | `traffic`         | continuous      | —                         | all metrics                                      |
| Apple Ads         | `ads`             | periodic        | the ad account's (result) | all metrics                                      |

Google Play's `report_status` dataset is bookkeeping and belongs to no
stream. Apple Ads has one connection per ad account; its manifest zone is a
default, and each connection reports its account's zone (section 2).

The zone says what the provider's dates mean, for validation and
diagnostics. Screens never show it (section 8).

### 2. What a done sync reports

`SyncResult` gains an optional field, read from the **done** result only
(as `receivedDatasets`; on a result with `done: false` it is ignored):

```ts
freshness?: Array<{
  stream: string; // a declared stream key
  resource?: string; // absent: the whole connection
  dataThrough?: string; // YYYY-MM-DD, last complete day (periodic only)
  timeZone?: string; // overrides the stream's zone for this entry
  expectedFrom?: string; // ISO instant (UTC): earliest typical publication
  nextExpectedAt?: string; // ISO instant (UTC): latest normal publication
}>;
```

- `dataThrough` is a **calendar date in the provider's reporting time
  zone**, not an instant: the last day for which the stream's numbers are
  complete as far as the provider publishes them. A day that is still
  revised later (re-read days) counts once the provider has published it;
  revisions are normal and not shown.
  For a `period: "month"` stream it is the last day of the last complete
  month; any other date is a contract violation.
- `nextExpectedAt` is when the period after `dataThrough` should be
  published, by the connector's knowledge of the provider. It is reported
  **even when it is already past**: a connector that finds yesterday's
  report still missing at 14:00 PT reports `dataThrough` two days back and
  `nextExpectedAt` 12:00 PT today. That is how the host knows the provider
  is late. A connector that cannot estimate it (Search Console, Play
  earnings until #703 finds a rule) leaves it out.
- `expectedFrom` is optional: the typical **earliest** time the next
  period appears, when a provider often publishes before its cutoff (App
  Store sales often appear before 12:00 PT). `nextExpectedAt` then stays
  the latest normal time (the cutoff). The host starts checking at
  `expectedFrom` (section 5); screens show and lateness counts from
  `nextExpectedAt` only. Without it, both are the same time.
- A **continuous** stream reports an entry with neither field: "this run
  read it". Its freshness is the time of the run.
- An entry means the run read that stream (and resource) completely. A
  stream it did not read (no Customer Support key, analytics not enabled,
  a resource whose read failed but did not fail the run) gets no entry.
- Undeclared stream keys, `dataThrough` on a continuous stream,
  `expectedFrom` without or after `nextExpectedAt`, invalid dates, zones
  or instants are contract violations, as an undeclared
  dataset in `receivedDatasets` is. At most streams × (resources + 1)
  entries, bounded like dataset pages.

### 3. Granularity: connection or resource

An entry without `resource` covers the whole connection; one with
`resource` covers that resource (an app, a package, a property) and
wins over the connection entry for it. A connector reports at the level
the provider publishes at:

- App Store Connect sales: one report per vendor for all apps, so one
  connection entry. Analytics: per app, since each app has its own report
  and some apps have none.
- Google Play: per package. Search Console: per property.
- Apple Ads: one connection entry with the ad account's `timeZone`. A
  connection is one ad account, and its `resource` dimension is the
  promoted app (`packages/connectors/src/apple-ads/index.ts:375`), whose
  days all follow the account's zone.
- Vercel and continuous streams in general: one connection entry.

### 4. Storage

A new tenant table `connection_freshness` (next free migration number):

| Column             | Meaning                                                      |
| ------------------ | ------------------------------------------------------------ |
| `workspace_id`     | Tenant; RLS and explicit predicates as on `connection_state` |
| `connection_id`    | Cascades on delete                                           |
| `stream`           | Stream key                                                   |
| `resource`         | Resource id, `''` for the connection entry                   |
| `data_through`     | date, null for continuous streams                            |
| `time_zone`        | IANA zone of `data_through`, null for continuous streams     |
| `expected_from`    | timestamptz, null when not reported                          |
| `next_expected_at` | timestamptz, null when unknown or continuous                 |
| `checked_at`       | The run that last reported this entry (its start time)       |
| `advanced_at`      | When `data_through` last moved forward                       |

Primary key `(connection_id, stream, resource)`; one row per entry, latest
value wins. Rules:

- Rows are written in the final ingest transaction of a **succeeded** run,
  together with `lastSuccessAt` and the cursor, never without them.
- A **failed** run writes nothing: the rows keep the last known coverage,
  and the failure shows through the existing status (`outage`,
  `auth_failed`, `stale`).
- A **partial** run (a done result that omits a stream or resource)
  leaves the omitted rows unchanged; their `checked_at` stays older, which
  is what screens show.
- **`data_through` never moves back.** A reported date earlier than the
  stored one leaves `data_through`, `time_zone` and the expected times as
  stored and only updates `checked_at` (a provider withdrawing a day, or a
  connector bug, does not make screens claim less). A later date updates
  all fields and `advanced_at`.
- A backfill's done result is handled the same way.
- Rows of streams the manifest no longer declares and of resources outside
  the connection's selection are ignored on read and removed with the
  connection. The table holds no personal data and needs no retention of
  its own.

### 5. Sync timing

`poll_interval_seconds` stays the longest gap between syncs. Freshness can
only make the next sync earlier, never later. After a succeeded run the
engine computes `nextDueAt` from the stored rows of the connection's
periodic streams (selected resources only):

```
interval = poll_interval_seconds
grace = 10 min, step = min(30 min, interval), floor = min(15 min, interval)
for each row with next_expected_at E (expected_from F, else F = E):
  if now < F + grace:              candidate = F + grace          (wait)
  else if now < E + grace:         candidate = min(now + step, E + grace)
  else if now < E + interval:      candidate = now + step         (late)
  else:                            no candidate (back to the interval)
nextDueAt = no candidates ? now + interval
          : max(now + floor, min(now + interval, min(candidates)))
```

- **Without freshness rows** (or without candidates) `nextDueAt` is
  exactly `now + interval`, as today; a connector polling every 300 s (the
  demo connector) keeps that. Since `floor ≤ interval`, freshness never
  delays a run.
- **Grace** covers the spread of a provider's publication.
- **Window**: from `expectedFrom + grace` the host checks every 30 minutes
  until the period arrives, with one check at `nextExpectedAt + grace`.
  Without `expectedFrom` the first check is at `nextExpectedAt + grace`.
- **Floor**: through freshness, never two syncs of a connection less than
  `min(15 min, interval)` apart (a manual sync still can).
- **Late provider**: past `nextExpectedAt + grace` the host keeps checking
  every 30 minutes and stops once the provider is a full interval late, so
  a wrong estimate costs a bounded number of extra syncs a day. For App
  Store Connect that is a few extra report reads per check, far inside the
  hourly limit (ADR 0014).
- **Failures**: the rule applies only after a succeeded run. A failed run
  leaves `next_due_at` where the scheduler put it (now + interval) and the
  job queue retries as today; `consecutiveFailures` and the `auth_failed`
  and `needs_reauthorization` skips in the scheduler are unchanged.
- The scheduler keeps reading only `connection_state`
  (`scheduler.ts:74-77`): the engine writes the computed `next_due_at`
  there, so the scheduler role needs no new grant.
- A sync reads every stream; there is no per-stream sync. An early sync
  for sales also refreshes reviews.

### 6. Which streams a widget depends on

The host resolves a widget's **(connection, stream, resources)** set when
it computes the widget's data:

- **Metric widgets** (metric, gauge, line and the other connector metric
  types): the stream that lists the widget's metric key in its
  connector's manifest, on the widget's connection; resources from the
  widget's resource scope or the slide scope (#707), else every selected
  resource. A slide scoped to a linked product (`product:<id>`) gives a
  widget that is not fixed to an app the product's app of its connection
  (#777), resolved through the models the dashboard's shared filters map
  to: the mapping tables among their datasets, read as for measure
  widgets below. Another install's mapping never counts.
- **Measure widgets**: the model's sources (ADR 0022). A source dataset
  binding resolves to `data_datasets (connection_id, key)` and so to the
  stream listing that dataset key; an `observation:<connection>:<metric>`
  binding resolves through the metric definition to its key and stream.
  `resources:` bindings (names only) and manual datasets have no stream.
  Resources are the apps the slide scope and a screen's scope pick on
  each connection (#767): a scope value naming a resource, or a linked
  product (`product:<id>`) resolved through its install's mapping table to
  its apps. The filters' chosen values (a viewer's choice, else the
  default) and the dashboard's fixed values pick apps the same way (#776),
  so freshness covers the apps the rows cover; a filter the widget
  excludes picks nothing. A connection the scope names no app of adds no
  rows; a scope that picks no apps leaves every selected resource, and so
  does a mapping table that cannot be read, for any reason: freshness
  never fails a widget. This extends `modelSourceHealth`, which already
  walks the same bindings.
- **Latest-review widgets**: the connector's stream with key `reviews`;
  no metric or dataset carries review text, so a connector that ingests
  review text declares its reviews in a stream with that key. Resources as
  for metric widgets.
- For each (connection, stream) the resource rows are used, and the
  connection row for resources without one.
- An app a widget names (its own, a scope's, a product's member) that has
  no row in any of the widget's streams, while other rows are used, counts
  as **no data yet** (#776): a periodic row without a covered day, so the
  summary has no `dataThrough` and a product is never shown fresher than
  its least fresh app. It is not overdue by itself. Its check time is its
  connection's latest. An app without rows alone leaves the widget without
  freshness, as below.

A widget whose data depends on no stream with stored rows has no
freshness, and shows `updatedAt` as today.

### 7. Payload

One optional object, `freshness`, on the data of every data widget: in
`deviceWidgetDataShape` (device schemas 2 and 3; schema 1 tiles unchanged)
and in `dashboardWidgetDataSchema` (measure widgets, web and device):

```ts
freshness?: {
  kind: "periodic" | "continuous";
  stream: string; // localized stream name, for lists that name it
  fetchedAt: string; // instant: the oldest checked_at of the rows used
  dataThrough?: string; // YYYY-MM-DD (periodic)
  period?: "month"; // periodic stream published by month
  nextExpectedAt?: string; // instant (periodic, when known)
  late?: true; // the provider missed nextExpectedAt (below)
  nextCheckAt?: string; // the connection's next_due_at
};
```

When a widget depends on several rows, the summary is the **least fresh**
one: among periodic rows the earliest `dataThrough` (the numbers are
complete only up to it), ties broken by the earliest `nextExpectedAt`;
`late` if any row with that date is late. Continuous rows count only when
there is no periodic row. `fetchedAt` is the oldest `checked_at` of all
rows used; `nextCheckAt` the earliest `next_due_at` of their connections.

**Per source** ([#784](https://github.com/netrics-so/netrics/issues/784),
2026-11-19; replaces "the least fresh source wins" for screens): when the
rows used come from more than one connector, the object also carries
`sources`, one summary per connector by the same rule over that
connector's rows (several connections of one connector are one source),
in name order:

```ts
sources?: Array<{
  source: string; // "App Store", "Google Play"; else the connector's name
  // and the fields above: kind, stream, fetchedAt, dataThrough, period,
  // nextExpectedAt, late, nextCheckAt
}>; // 2 to 50 entries, one per connector, never one left out; absent for one connector
```

The source is named by its store for the store connectors ("App Store"
for App Store Connect, "Google Play"), else by the connector's name in
the payload's language. The top-level fields stay the least fresh
summary, so clients that do not know `sources` show what they showed
before. Under the old rule a model over App Store sales and Google Play
installs showed Play's older day and dropped App Store's next time; now
screens list both. `overdue` and `status: "stale"` are unchanged: any row
overdue makes the widget stale. A measure widget's own fixed filter counts
like a scope (section 6): a fixed app picks its apps, and on a store
template's model a fixed store (`store = "google"`) keeps only that
store's connections.

**Late** is decided from stored values, not the clock:
`next_expected_at + grace < checked_at`, i.e. a sync after the expected
time still did not find the period; `expected_from` plays no part. A row
is **overdue** when `checked_at ≥ next_expected_at + 24 h`; the widget's
`status` is then `stale`, the existing warning, which older clients also
show. The payload stays deterministic, so its version hash (the ETag)
changes only when data or state change, and clients format every relative
time ("10 min ago") themselves from the instants, as they do with
`updatedAt`. `updatedAt` stays as it is for clients that do not know
`freshness`.

The signed-in live queries (#727) carry the same object: the metric
query and the breakdown (metric, line, bar, table and unbound compare
widgets), a goal read (gauges) and the bound compare reading. The query's
`resource` filter, which browsers set from the slide scope, picks the
rows as on screens. These responses have no data status of their own, so
an overdue row adds `status: "stale"` instead. A status board item
(device schemas 2 and 3) lists `streams`: per stream with stored rows,
this object over every selected resource's rows plus the stream `key` and
`overdue: true` when a row used is overdue. A connection whose credentials
failed or need reauthorization is not scheduled, so its streams carry no
`nextExpectedAt` or `nextCheckAt`. The connection page's `freshness[]`
lists the same rows (selected resources and the connection entry).

### 8. On screen

The freshness line replaces the "updated … · Source" footer candidates
(ADR 0018 section 5) when `freshness` is present, longest candidate first;
narrow widgets drop parts from the end. English and German (ADR 0016):

| Case                    | English                                                         | German                                                                   |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Periodic, next known    | Up to Nov 15 · fetched 10 min ago · next ~21:00                 | Bis 15. Nov. · abgerufen vor 10 Min. · nächste ~21:00                    |
| Periodic, next unknown  | Up to Nov 13 · fetched 10 min ago                               | Bis 13. Nov. · abgerufen vor 10 Min.                                     |
| Monthly stream          | Up to October · fetched 10 min ago · next ~Nov 18               | Bis Oktober · abgerufen vor 10 Min. · nächste ~18. Nov.                  |
| Periodic, provider late | Up to Nov 14 · Nov 15 not published yet · checking again ~15:10 | Bis 14. Nov. · 15. Nov. noch nicht veröffentlicht · erneut prüfen ~15:10 |
| Continuous              | Checked 10 min ago · next check ~14:30                          | Geprüft vor 10 Min. · nächste Prüfung ~14:30                             |

The table writes every time on a 24-hour clock; screens follow the
locale's clock, so English reads "~9:00 PM" and German "~21:00".

Lists that cover several streams (a connection's page, a detail view)
prefix the stream name: "Sales up to Nov 15 · next ~21:00", "Reviews
checked 10 min ago · next check ~14:30". Widgets do not repeat it; their
label already names the metric.

**Several sources** (section 7's `sources`, #784): a widget lists each
source by name with its own parts, on the web and on netrics TV alike, in
the first of these forms that fits one line of the tile's content width
(measured with the fit's glyph widths, `freshnessLevelFit`):

| Form                                    | English                                                                                 | German                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1. Full                                 | App Store up to Nov 17 · next ~9:00 PM · Google Play up to Nov 11 · fetched 10 min. ago | App Store bis 17. Nov. · nächste ~21:00 · Google Play bis 11. Nov. · abgerufen vor 10 Min. |
| 2. Without the fetch                    | App Store up to Nov 17 · next ~9:00 PM · Google Play up to Nov 11                       | App Store bis 17. Nov. · nächste ~21:00 · Google Play bis 11. Nov.                         |
| 3. Days only (the "next" parts dropped) | App Store up to Nov 17 · Google Play up to Nov 11                                       | App Store bis 17. Nov. · Google Play bis 11. Nov.                                          |
| 4. Short days                           | App Store up to 11/17 · Google Play up to 11/11                                         | App Store bis 17.11. · Google Play bis 11.11.                                              |
| 5. Stores and days                      | App Store 11/17 · Google Play 11/11                                                     | App Store 17.11. · Google Play 11.11.                                                      |
| 6. A line per source                    | App Store up to 11/17 ⏎ Google Play up to 11/11                                         | App Store bis 17.11. ⏎ Google Play bis 11.11.                                              |

A source is never left out and no form is cut: where even form 5 does
not fit, each source takes its own line (form 6). A measure table's fit
(#768) counts the chosen form's lines as freshness lines, so rows give
way, not the footer. A late source reads "Nov 12 not published yet" in
forms 1 and 2; a continuous one "Vercel checked 10 min ago". Under a
warning every form keeps only the days (and "not published yet"); a
provider overdue by a day keeps its one warning line. Scroll cards, which
grow with their content, show form 2 and let it wrap. A monthly source
keeps its month's name in forms 4 and 5. A metric widget gives its
freshness line room right after its label, value and notice, before the
change, the period line and the sparkline (#784), so every number says
how far it reaches. One source keeps the single line above.

Precedence, highest first:

1. **Connection failing or stale** (`auth_failed`, `outage`, `stale`):
   the existing warning notice. The line keeps only "Up to Nov 14" and
   drops "next", since netrics may not fetch it. A provider overdue by
   24 h is shown this way too, with the late wording ("Up to Nov 14 ·
   Nov 15 not published yet") in the warning style.
2. `backfilling` and `no_data`: as today.
3. **Provider late** (less than 24 h): the late wording in the normal
   muted footer style. It is not a data warning yet: netrics works, the
   provider has not published. No warning colour, no blinking dot,
   `status` stays `ok`. "Checking again" is `nextCheckAt`.
4. **Normal**: periodic or continuous wording.

Formatting:

- **The viewer's time zone, nothing else.** Every time on screen is in the
  zone of the person in front of it: the browser's zone on the web, the
  device's zone on netrics TV, not the workspace zone. No zone is ever
  named, on widgets or in detail views. The same holds for the screen's
  header clock, the offline note's last update and a clock widget without
  a zone of its own (#736): the payload marks such a clock
  `followsViewer` and keeps sending the workspace zone in `timeZone` for
  builds that predate the flag. The workspace zone only defines data days
  (goals, "today", measures); new workspaces start in the creator's
  browser zone.
- `dataThrough` is the provider's reporting day, shown as that date
  without a zone label and never converted: a Pacific day spans two local
  days in Berlin (09:00 to 09:00), so there is no local date to convert it
  to. A monthly stream shows the month ("October"), with the year when it
  is not the current one.
- `nextExpectedAt` and `nextCheckAt` are instants, shown in local time. Time only when it is today locally,
  "tomorrow ~09:00" or the weekday within a week, a date beyond. 12- or
  24-hour clock and the "~" follow the locale. An expected time already
  past and not late reads "next any minute" / "nächste in Kürze".
- `fetchedAt` is relative under a day ("10 min ago"), then a date, the
  same rule as `updatedAt` today.
- The strings live in the client catalogs (web messages, tvOS
  localizations); the payload carries no worded freshness text.

### 9. Connectors on older SDKs

A connector that declares no streams or reports no `freshness` (any
connector built for SDK 0.2.12 or earlier, and external connectors that
have not adopted it) has no rows. Its widgets get no `freshness` object and
show `updatedAt` as today; its syncs keep the fixed interval. The host does
not guess coverage from stored observations: a missing day and a day
without activity look the same there. A connector that declares streams
but reports nothing for one has the same fallback for that stream.
Connectors require `^0.2.13` only once they use the field; the host
accepts manifests without it.

**Empty windows of read days (#378).** The reverse holds where the host
knows what was read: from where the connection's last complete backfill
started (`connection_state.history_from`, set when a backfill succeeds and
cleared when one fails) to a periodic stream's `dataThrough`. A sum of a
`delta` metric (spend, installs, downloads) whose current window starts
within those days and has no observations is 0, not "no data": the
provider had nothing to report (Apple Ads answers inactive days with their
date alone, which are not stored). Limits:

- Only the current window: the previous one can reach back before the
  history.
- Only without filters other than the currency. A resource may be outside
  the selection or selected after its history was read; other dimensions
  (countries, keywords, queries) are stored as top rows, where a value
  outside them has no observations although it had activity.
- An amount without a currency filter reads 0 in the currency the
  connection's configuration names (Apple Ads), else stays "no data".
- Not for averages, minimums, maximums or latest readings, not for a
  window that starts after `dataThrough` (today), and not while a backfill
  of the connection runs.
- A connection stuck in `auth_failed` keeps its last `dataThrough`: its
  windows count as read only up to that day, and its widgets are marked
  stale by the connection's state.

Ratios over two zeros (cost per install) stay without a value. Breakdowns
(bars, tables) keep their empty state.

## Alternatives considered

- **Host-side publication rules per connector** (a table of "Apple: noon
  PT"): rejected. The rules belong with the connector that knows its
  provider, and must change with it.
- **Derive coverage from the newest observation date**: rejected. Zero
  days, missing days and partial days cannot be told apart.
- **Per-metric freshness instead of streams**: rejected. Dozens of keys
  with identical cadence; streams match how providers publish.
- **`dataThrough` as an instant**: rejected. Providers publish calendar
  days in their own zone; converting a day to the viewer's zone shifts it.
- **Per-stream sync jobs**: rejected for now. One sync already reads
  everything within the budget; splitting jobs changes cursors and
  continuation (ADR 0023, 0024).
- **"Late" as a warning from the first minute**: rejected. The viewer
  cannot act on it and netrics is not at fault; it becomes the stale
  warning only after 24 h.
- **Showing the provider's zone next to the day**: rejected. Viewers read
  their own time; the day is a label from the provider.

## Consequences

- Every periodic number on a screen says which provider day it covers and
  when the next one is due; App Store sales are fetched within about 40
  minutes of Apple publishing them (30-minute checks from `expectedFrom`
  plus grace) instead of up to 6 h.
- More syncs per day for daily providers: up to two per hour of a stream's
  publication window, and on late days until the provider is a full
  interval late (for a 6 h interval, about 12 more). Accepted for the
  current connectors; there is no switch.
- Connections without freshness rows are scheduled exactly as before, and
  the floor never exceeds a connection's interval.
- The quality of "next" depends on connector estimates. A wrong estimate
  shows "not published yet" until the period arrives, and the stale
  warning after 24 h.
- One new tenant table, an SDK minor (0.2.13), an additive payload field.
  Released tvOS builds ignore it; schema 1 tiles are unchanged.
