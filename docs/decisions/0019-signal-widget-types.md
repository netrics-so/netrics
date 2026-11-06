# 0019 — Signal widget types, goals, new periods and review text

Status: accepted (2026-10-04, owner decision; #312). Amends
[ADR 0015](./0015-dashboard-studio.md) sections 2 and 8, and
[ADR 0014](./0014-app-store-connect-signed-keys.md) decision 2 (review
data).

## Context

ADR 0015 shipped six widget types (`metric`, `line`, `bar`, `image`, `text`,
`clock`) and named table, gauge, status/health and multi-series compare as
later work. The Signal handoff (ADR 0018, design 4a and 4b) shows seven new
types: gauge and goal (with a "goal reached" state), status board, table,
compare/derived, latest review, countdown, and a clock with date and zone.
ADR 0018 §7 left them to this design pass because each needs a data
binding, minimum sizes, a type scale and shared vectors before web and tvOS
can render it identically.

What exists today, and what this pass builds on:

- **Model.** `dashboard_widgets` has one metric binding (`connection_id`,
  `metric_key`, `aggregation`, `period`, `dimensions`, `display_currency`)
  plus `options` jsonb validated by zod per type. Check constraints list
  the types (`dashboard_widgets_type_valid`), tie the binding columns to
  the data types (`dashboard_widgets_type_columns`), allow `image_id` only
  on image widgets and list the periods (`dashboard_widgets_period_valid`).
- **Queries.** `queryMetric` gives a value, the previous period's value and
  both series; `queryMetricBreakdown` gives one value per dimension value
  (top `limit` plus "Others") for the current window only.
- **Periods** are `today`, `last_7_days`, `last_30_days`, `this_month`,
  `last_90_days` and `last_12_months` (`PERIODS` in `packages/domain`,
  `resolvePeriod`, `SERIES_UNITS`). There is no week, quarter or year to
  date. Weekly series points already start on Monday.
- **Dimensions with useful rows.** Vercel `route_pageviews` (route),
  `country_visitors` (country) and `events` (event); App Store Connect
  territory, device, source and rating; every metric by `resource`. Search
  Console has no page or query dimension, so the design's "Top pages ·
  clicks" is a Vercel "Top routes" table today.
- **Connection health.** `connection_state` gives `health` (`ok`,
  `pending`, `auth_failed`, `needs_reauthorization`, `outage`),
  `lastSuccessAt` and the poll interval; `tileStatus` derives a widget's
  `ok`/`stale`/`auth_failed`/`outage`/`no_data`/`backfilling` from it.
- **Reviews.** App Store Connect reads customer reviews with an optional
  Customer Support key, asking Apple only for `rating`, `createdDate` and
  `territory`; titles, bodies and nicknames are never fetched (ADR 0014,
  decision 2; connector `reviews.ts`). The metrics are counts and star sums
  per day. Connectors return numeric observations only (`SyncResult`,
  ADR 0008).
- **Clock.** Already has `showDate`, `hour12` and `timeZone`; no zone line.
- **Unknown types and values on screens.** tvOS decodes a widget type it
  does not know as `WidgetContent.unsupported` and draws an empty themed
  cell (since schema 2 support, #222); its schema 3 reflow lays out an
  unknown type as 1 × 1 (`layoutType` falls back to `image`). An unknown
  period decodes as `.unknown` ("vs previous period"). The web renders
  unknown types as the "could not be shown" notice (`WidgetFailed`).
  Unknown fields and options are ignored on both.
- **Roles.** Owners and admins may do everything; editors may view, create
  and update dashboards; viewers may view (`ROLE_PERMISSIONS`).
- **Derived metrics** (expression grammar, unit and zero-division rules,
  stored definitions) belong to milestone 11; **alerts** to milestone 14.

## Decision record (owner, 2026-10-04)

The proposal put four questions to the owner. The owner decided:

1. **Goals are a shared entity**, not a widget option (section 4).
2. **netrics fetches App Store review text**: title, body and reviewer
   nickname, for a latest-review widget (sections 11 and 12).
3. **Week, quarter and year to date** become periods for every widget and
   goal (section 3).
4. **The gauge is a full ring**, as designed; **compare ships now** with a
   second metric binding on the widget, without waiting for milestone 11
   (section 10).

## Decision

### 1. Summary

| Type (key)               | Binding                                   | Min (cells) | Section |
| ------------------------ | ----------------------------------------- | ----------- | ------- |
| Goal (`gauge`)           | a goal (`goal_id`)                        | 3 × 3       | 5       |
| Table (`table`)          | one metric by a dimension                 | 4 × 4       | 6       |
| Status board (`status`)  | connections of the workspace              | 3 × 3       | 7       |
| Countdown (`countdown`)  | none (a date and time in the widget)      | 3 × 2       | 8       |
| Clock (`clock`, amended) | none (long date and zone line)            | 2 × 1       | 9       |
| Compare (`compare`)      | two metrics, numerator and denominator    | 4 × 3       | 10      |
| Latest review (`review`) | an App Store Connect connection (reviews) | 4 × 3       | 12      |

Supporting work: three periods (section 3), the goals entity and its page
(section 4), and stored review text (section 11).

### 2. Rules every new type follows

**Compatibility rule.** A new widget type, period, option or data field is
additive: it needs no new payload schema and no `DEVICE_API_VERSION`
change. Every client that reads schema 2 or 3 ignores unknown fields,
renders an unknown type safely (tvOS: an empty themed cell; web: the
"could not be shown" notice) and shows an unknown period as "vs previous
period". New types are sent in schemas 2 and 3 as further members of the
widget union. Schema 1 still carries only `metric` widgets; a metric
widget with a new period reaches old schema 1 clients with that period,
which they decode the same way.

**Forward-compatible reflow.** Released tvOS builds reflow an unknown type
as 1 × 1, so on a non-primary format the empty cell's stack can sit
differently from the Studio preview (schema 2 is laid out on the server
and is exact). From the first new type on, schema 3 widgets carry
`min: { w, h }`, the type's minimum size, and clients use it for types
they do not know. Old builds ignore it; newer builds reflow any later type
exactly. `labelFit` checks every type with a label, not only metric, line
and bar. Both land with the first widget issue to merge (section 14).

**Storage.** Each type's issue widens `dashboard_widgets_type_valid` and
`dashboard_widgets_type_columns` for its own key in its own migration:
`table` uses the binding columns like `bar`; `compare` uses them plus the
denominator columns (section 10); `gauge` uses `goal_id` and no binding
columns (section 5); `review` uses `connection_id` only, plus an optional
`image_id` (section 12); `status` and `countdown` use none. Everything
else type-specific lives in `options` jsonb, validated by zod. The API's
widget union admits a type only once its issue ships.

**Limits.** Toward the 48 data widgets per dashboard, `gauge`, `table`
and `review` count once and `compare` twice (two metric queries). A table
costs two grouped queries (current and previous window); `status` costs
one small query per payload, shared by all status boards.

**Labels.** Metric-bound types resolve `label` on the server like
`metric` (title or metric name, then the resource line, `tileLabel`).
`gauge` uses the title or the goal's name; the others their title or a
localised default ("Sources"/"Quellen", "Countdown", "Latest review"/
"Neueste Bewertung"). `labelFit` applies to all: title and resource line
at 30 u, at most two lines each.

**Data states** (ADR 0018 §5) come from `tileStatus`, with the surfaces of
`metric`: stale (warning border, value dimmed, ring and Δ in `muted`),
auth failed ("Reconnect …"), no data and backfilling (dashed border,
skeleton). `status` is a status display and always `ok` (empty: "No
sources connected"). `countdown` and `clock` have no data states.

**Colours** are theme tokens; themes gain none (ADR 0018 §5). Good and bad
are `up` and `down`, attention is `warning`, quiet parts `muted`, the
gauge track `border` and its fill `chartLine`. Tinted surfaces (goal
reached) are derived with `color-mix` like the layered surfaces; flat
themes stay flat.

**Motion** (ADR 0018 §6) is part of the slide enter only: values count up,
the gauge arc draws (`pathLength` dash offset), table and status rows rise
14 u and fade in with a 90 ms stagger (each row 400 ms, ease-out cubic; at
most 10 rows, so the last ends with the 1200 ms enter). Nothing new
animates continuously. Reduce Motion shows the final state.

**Readability.** Every text is at least 24 u; every primary value at least
64 u and as large as fits. New text roles (section 13) join
`STUDIO_TEXT_MINIMUMS`, `widgetTypeScale` and the Swift port. Each type gets
a content-layout function in `packages/domain` (`gaugeLayout`,
`tableLayout`, `statusLayout`, `countdownLayout`, `clockLayout`,
`compareLayout`, `reviewLayout`), ported to Swift and covered by
`studio-layout.json` vectors, because `fits` and the Studio need the same
answers the renderers use. (The content layouts of `metric`, `line` and
`bar` live in `apps/web/src/lib/studio-render.ts` and `StudioRender.swift`;
new types start in the domain.)

**Data text may end in an ellipsis.** Titles and values keep ADR 0015 §8
(never cut). Text that comes from data and is known only at render time
(table and status row labels, review text) shrinks to its minimum and then
ends with an ellipsis; the Studio's live preview shows it.

**Scroll view** (ADR 0017 §5): `table` spans the full row when it is at
least 6 columns wide in the primary, like text and image; the others take
one column. Heights fit content: a table shows all `limit` rows, a status
board all its items and a review its whole text.

**Reflow** needs no change: minimum sizes are cells and mean the same in
every format (ADR 0017 §1).

**Studio.** The add-widget menu gains Goal, Table, Status, Countdown,
Compare and Latest review (Clock exists). `newWidget` creates each at its
minimum size with valid defaults. The inspector reuses the binding fields
of `metric` and `bar` where they apply. Strings in English and German
(ADR 0016).

### 3. Periods: this week, this quarter, this year

`PERIODS` gains `this_week`, `this_quarter` and `this_year`, period to
date like `this_month`, available to every data widget and every goal.

- **Week start: ISO, Monday**, for everyone. It matches the weekly series
  points netrics already draws and needs no setting. A workspace setting
  (Sunday or Saturday starts) can be added later as a column with a
  default of Monday; nothing here prevents it.
- **Time zone:** the workspace zone, like every period. Daily metrics are
  selected by reporting date (ADR 0008), so a week of Pacific-Time App
  Store days is still Monday to Sunday by date.
- **Windows:** this week from Monday, this quarter from the first day of
  January, April, July or October, this year from 1 January, each up to
  now.
- **Previous window: the same span of the previous period**, as
  `this_month` does it: the previous week up to the same weekday and time
  of day; the previous quarter up to the same day of the quarter (capped
  at its last day, as `sameDayIn`); the previous year up to the same date
  (29 February becomes 28 February). Comparison lines read "vs last week
  to date", "vs last quarter to date", "vs last year to date".
- **Series points:** days for this week, weeks (Monday starts, partial
  first week as for 90 days) for this quarter, calendar months for this
  year. All stay within `MAX_BUCKETS`.
- **Where:** `PERIODS`, `resolvePeriod` and `SERIES_UNITS` in
  `packages/domain` with tests at boundaries (Monday 00:00, quarter starts,
  1 January, DST changes, leap days); `metricPeriodSchema` follows
  `PERIODS`; a migration widens `dashboard_widgets_period_valid` (and the
  goals table's check, section 4); the server's queries need nothing else.
  Web labels and comparison strings, and the tvOS `MetricPeriod` enum,
  bucket labels and comparison strings, gain the three periods.

### 4. Goals

A goal is a named target for one metric in a calendar period that renews
each period: "15,000 downloads of Wurfel this month". Goals are shared:
several gauge widgets on several dashboards can show one goal, and
milestone 14 can notify on it.

**Table `goals`** (workspace table under RLS with the usual policies,
explicit `workspace_id` predicates in every query, cross-workspace tests):

| Column             | Type       | Notes                                                                        |
| ------------------ | ---------- | ---------------------------------------------------------------------------- |
| `id`               | uuid       |                                                                              |
| `workspace_id`     | uuid       |                                                                              |
| `name`             | text       | 1–60 characters, unique per workspace                                        |
| `connection_id`    | uuid       | FK `(connection_id, workspace_id)`, on delete cascade                        |
| `metric_key`       | text       |                                                                              |
| `aggregation`      | text       | `sum` (delta metrics) or `last` (gauge and counter metrics)                  |
| `dimensions`       | jsonb      | default `{}`; filters as on widgets, including `resource`                    |
| `display_currency` | text, null | as on widgets (#191)                                                         |
| `period`           | text       | `today`, `this_week`, `this_month`, `this_quarter`, `this_year`              |
| `target`           | double     | > 0, ≤ 1e15, in the unit the payload value uses (minor units, 0–1 for ratio) |
| `version`          | integer    | optimistic concurrency, as dashboards                                        |
| timestamps         |            | `created_at`, `updated_at`, `created_by_user_id`                             |

Validation, on create and update (400 with a code):

- the connection, metric, aggregation and dimension filters exist and fit,
  as for a widget; other aggregations are `aggregation_not_supported` ("to
  go" means nothing for an average);
- only period-to-date periods: a rolling window has no end to reach a goal
  by (`period_not_supported`);
- metrics whose `better` is `lower` (average position) are refused
  (`goal_direction_unsupported`), as proposed; a "stay below" goal would
  need its own progress rule;
- a currency goal must resolve to one currency (a `currency` filter or a
  `display_currency`), else `currency_required`, so the target never
  changes meaning.

A deleted connection deletes its goals, as it deletes its widgets.

**API** (contracts and OpenAPI): `GET /v1/workspaces/:w/goals` (with each
goal's current progress, used by the page and the Studio picker), `POST`,
`GET/PUT/DELETE …/goals/:id` (`PUT` version-checked, 409
`version_conflict`). Permissions reuse the dashboard actions, as themes
and images do: `dashboards:view` to read (viewers), `dashboards:create` and
`dashboards:update` to create and edit (editors), `dashboards:delete` to
delete (owners and admins). Audit events `goal.created`, `goal.updated`,
`goal.deleted`. `DELETE` succeeds even when gauges use the goal; its
response lists those dashboards, and the UI confirms first ("Used on 2
dashboards").

**UI.** A **Goals** page under Dashboards in the sidebar, between
Dashboards and Themes, added with this feature (ADR 0018 §4: only
destinations that exist). It lists goals with name, metric and resource,
period and a progress bar, and opens a form: name, metric binding (the
picker the Studio inspector uses), period, target in display units (major
units, percent) with the unit beside it. Strings in English and German.

**Milestone 14** can later add alert rules on a goal (reached, or behind
a pace) that reference `goals.id`; nothing here needs to change for that.

### 5. Goal widget (`gauge`)

**Purpose.** Progress toward a goal in its current period: "83 % of
15,000 downloads this month, 2,520 to go, 9 days left", and a distinct
"goal reached" state.

**Binding.** `dashboard_widgets.goal_id`, FK `(goal_id, workspace_id)`
with `on delete set null (goal_id)`; no metric binding columns. Options:
`showTimeLeft` (true). The API accepts `goalId: null` so a dashboard with a
gauge whose goal was deleted still saves; the Studio requires a goal for a
new gauge.

**Deleted goal.** The payload sends the widget with `status: "no_data"`
and `goal: null`; screens show the not-found state ("Goal deleted",
`muted`, dashed border like no data). The Studio flags the widget with a
new format warning `goal_missing` (attention) and offers to pick another
goal.

**Payload** (`data`), resolved on the server from the goal: the shared
data fields (`period`, `aggregation`, `unit`, `conversion`, `kind`,
`granularity`, `better`, `status`, `updatedAt`) plus

```jsonc
{
  "goal": { "id": "…", "name": "Monthly downloads" }, // null when deleted
  "value": 12480, // null without data
  "target": 15000,
  "progress": 0.832, // value ÷ target, not clipped; null without data
  // Bucket start where the running sum first reached the target (sum of a
  // delta metric only), else null.
  "reachedAt": null,
  // Exclusive end of the goal's period in the workspace zone.
  "periodEnd": "2026-11-01T00:00:00+01:00",
}
```

Clients compute "days left" and "N days early" from `periodEnd`,
`reachedAt` and their clock with one domain function (`goalTimeText`,
vectors), so a cached payload stays right offline and the `ETag` does not
change at midnight. Time left: whole days after today ("9 days left", on
the last day "last day"); for `today` hours ("5 h left", "< 1 h left").

**Rendering: a full ring.** A stack: the label; the target line ("Goal
15,000", resource role, one line); the ring with the value centred inside;
the progress line ("2,520 to go · 9 days left", change role, at most two
lines); the freshness footer. The ring is a full circle from 12 o'clock,
stroke 10 % of its diameter (at least 16 u), track `border`, fill
`chartLine`, round caps, filled to `min(progress, 1)`; its diameter is what
is left, at most the content width, **at least 160 u**. When height runs
short the footer goes first, then the target line. When the content is at
least 1.6 times as wide as high, the ring sits right of the text. In
progress the value inside the ring is the percent rounded **down** (never
"100 %" before the goal is reached); once reached it is the value itself.

**Goal reached** (`progress ≥ 1`): ring and value in `up`, a surface tinted
toward `up` with a border of `up` at 35 % (glow only on non-flat themes),
and "✓ Reached · 122 % · 2 days early" ("early" when `reachedAt` is set;
on `today` just "✓ Reached · 122 %"). Stale data never shows the reached
colours: the stale surface wins.

**Minimum 3 × 3.** At 16:9 the content box is 404 × 295 u: a one-line
title (35), the target line (35), the ring (160), the progress line (32)
and the gaps fit (285 u); the footer appears from 3 × 4. At 3 × 2 the ring
would be under 60 u.

**Motion.** The arc draws from 0 to `progress` and the value counts up;
the end cap appears when the draw completes.

**Studio.** Inspector: Goal (a picker of the workspace's goals with their
progress, plus "New goal…", which opens the goal form in a dialog and
needs `dashboards:create`), "Edit goal" (to the Goals page), "Show time
left". `fits`: the label and `goal_missing`.

### 6. Table (`table`)

**Purpose.** A ranked list of one metric by a dimension with the change
per row: top routes by page views, downloads by territory, reviews by
rating.

**Binding and options.** The metric binding of `bar` (any aggregation the
metric allows; `groupBy` must be one of its dimensions and not `currency`),
plus `groupBy` (required), `limit` 3–10 (default 5), `showChange` (true,
the Δ column) and `showOthers` (false, a last dimmed "Others" row).

**Payload** (`data`): the shared data fields plus

```jsonc
{
  "groupBy": "route",
  "columns": { "label": "Route", "value": "Page views" }, // localised heads
  "rows": [
    {
      "key": "/pricing",
      "label": "/pricing",
      "value": 8120,
      "previousValue": 7250,
      "ratio": 0.12, // null without a previous value, or against zero
    },
  ],
  "others": { "label": "Others", "value": 2015, "groups": 14 }, // or null
}
```

The server runs `queryMetricBreakdown` for the current window and a second
grouped query for the previous window restricted to the returned keys
(same aggregation, conversion and resource names). Column heads come from
`localizedDimensionName` and the metric name.

**Rendering.** Label, a column-head row (24 u, caps, `muted`, tracked), the
rows (cell role 28 u), the footer. The value column is as wide as the
widest value (tabular figures, compact form when needed, never cut), the Δ
column as wide as "+999 %", the label column takes the rest. Δ is coloured
by `better` ("+12 %", "−3 %"; "new" when the previous value is missing or
zero and the value is not; "–" without both). Row labels shrink to 24 u,
then end with an ellipsis. Row pitch is the cell line plus 12 u.

**Rows by height.** `tableLayout` returns `rowCapacity`. A screen shows
`min(limit, rows, rowCapacity)` rows and the subtitle says how many ("Top 5
· Last 30 days"), so nothing is dropped silently. The Studio warns when
`limit` exceeds the capacity in a format (new warning `rows_cut`,
attention, "Shows 5 of 8 rows").

**Minimum 4 × 4.** The smallest `limit` (3 rows) must fit at every font
scale. At 16:9 a 4 × 4 content box is 560 × 414 u: label, heads and footer
leave room for 6 rows at font scale 1 and 4 at 1.3, and the label column
keeps about 370 u (around 20 characters at 28 u). Three rows high, only 2
rows fit at 1.3; three columns wide, a route keeps about 12 characters.

**Motion.** Rows rise with the stagger of section 2; values do not count
(many moving numbers are noise).

**Studio.** Inspector: binding as for bar charts, plus Rows, "Show
change", "Show Others". `fits`: label, and `rows_cut` per format.

### 7. Status board (`status`)

**Purpose.** Are the numbers on this wall fresh? One row per source with a
health dot and the age of its last successful sync, as in design 4a.

**What a status is: connection health**, the smallest useful definition on
existing data: `connection_state` already drives every widget's status and
the admin's source-health summary. Metric thresholds are alert rules
(milestone 14); once alerts and goals have states, a board may list them
as a second source (`options.source`), not before. Per connection, with
the `tileStatus` rules (`hasData` true):

| Item status   | When                                                          | Dot       |
| ------------- | ------------------------------------------------------------- | --------- |
| `ok`          | healthy and synced within 3 poll intervals (at least 15 min)  | `up`      |
| `stale`       | healthy but the last success is older, or never               | `warning` |
| `backfilling` | first sync pending, or a backfill queued or running           | `muted`   |
| `auth_failed` | `auth_failed`, `needs_reauthorization`, or setup not finished | `down`    |
| `outage`      | `outage`                                                      | `down`    |

**Options.** `connectionIds`: null (every connection, default) or 1–12 ids
of the workspace's connections, validated on save; a deleted connection
drops out (removed on the next save, ignored in the payload). `showAge`
(true).

**Payload** (`data`):

```jsonc
{
  "status": "ok",
  "items": [
    // Attention first (auth_failed, outage, stale, backfilling, ok), then
    // by name.
    {
      "connectionId": "…",
      "name": "App Store Connect",
      "status": "stale",
      "lastSuccessAt": "2026-10-04T09:12:00Z",
    },
  ],
}
```

Connection names are workspace data the TV already shows in labels; no
credentials, configuration or error texts are sent.

**Rendering.** Label; rows of dot (14 u), name (cell role 28 u, one line,
data text) and, right-aligned, the age ("14 m", "3 h", "2 d"; 24 u,
`muted`, `warning` when stale); a footer "4 connected · 1 delayed". Ages
are computed on the client from `lastSuccessAt`. When items exceed the
rows that fit, the last row becomes "+N more"; problems sort first, so a
problem is never the one hidden.

**Minimum 3 × 3.** At 16:9 five rows fit at font scale 1 and three at 1.3
(row pitch 44 u, 54 u at 1.3, in a content box of 404 × 295 u); the design
shows four.

**Studio.** Inspector: "All sources" or a checklist of connections; "Show
age". `fits`: label, and `rows_cut` (info) when the chosen connections
exceed the capacity.

### 8. Countdown (`countdown`)

**Purpose.** Time left to a moment set in the widget: "Launch in 2 d 14 h
05 m", with the target below.

**Options.** `target`: a local date and time, `YYYY-MM-DDTHH:mm` (years
2000–2100); `timeZone`: IANA, null for the workspace's (as the clock);
`showTarget` (true): the subtitle "Tue 7 Oct · 10:00"; `doneText`: 1–40
characters or null (localised "Now"/"Jetzt"). A past target is valid: a
dashboard saved after its launch must still save.

**Payload.** No `data`. The server resolves the options as it does the
clock's zone: `timeZone` (resolved) and `targetAt`, the instant in UTC
(`zonedInstant(target, zone)` in the domain: a time in a spring-forward
gap moves forward, an ambiguous one takes the earlier offset; vectors).
Screens count down from their own clock, ticking each minute like the
clock, so the `ETag` never changes with time.

**Rendering.** Label (the title, e.g. "Launch in"); the target line; the
remaining time as up to three groups, number (value role, at least 64 u, as
large as fits, sized on the widest digits) plus unit letter (change role
28 u, `muted`): "2 d 14 h 05 m" from one day on, "14 h 05 m" below, "41 m"
below an hour, "< 1 m" in the last minute. Letters come from the catalog
(en d/h/m, de T/Std/Min). At and after `targetAt` the widget shows
`doneText` at heading size in `accent`, and the target line.

**Minimum 3 × 2.** Title, target line and value fit in 404 × 175 u at
16:9, like a metric.

**Motion.** None beyond the slide fade; a countdown does not count up.

**Studio.** Inspector: date and time, time zone, "Show target", "Text when
reached". `fits`: label, and an info warning `countdown_passed`.

### 9. Clock with date and zone (extends `clock`)

The clock gains two options instead of a new type; released builds ignore
them and keep showing time and date:

- `dateStyle`: `short` (default, "Sat 4 Oct") or `long` ("Saturday, 4
  October"; "Samstag, 4. Oktober").
- `showZone` (false): a zone line "Berlin · UTC+2".

The zone line is the city (the IANA name's last part, underscores as
spaces; `Etc/UTC` is "UTC") and the current UTC offset (`UTC+2`,
`UTC+5:30`, `UTC−3`, `UTC`), from `zoneLabel(timeZone, now)` in the domain
with vectors. Not the abbreviation ("CEST"): ICU and Foundation disagree on
abbreviations by locale, and many zones have none.

Type scale: time at least 56 u (unchanged), date in the title role (30 u),
zone in the new `zone` role (24 u, `muted`). The design's 64 px clock is
96 u at 1080p, which "as large as fits" already gives a 3 × 3 clock.
Minimum stays 2 × 1; when lines do not fit, the zone line goes first, then
the date, and the Studio reports an info warning `clock_parts_hidden`.
Inspector: "Date: short / long", "Show time zone".

### 10. Compare (`compare`)

**Purpose.** Two metrics and their ratio, as in design 4b: "12.5k
downloads / 38.2k visitors → 32.7 % conversion, ▲ 1.9 pt". Also the
average App Store rating (review stars ÷ reviews, ADR 0014) and ROAS
(proceeds ÷ ad spend, milestone 10).

**Binding.** The widget's metric binding is the **numerator** (A). The
**denominator** (B) is a second binding in four new columns:
`denominator_connection_id` (FK `(…, workspace_id)`, on delete cascade: a
deleted connection deletes the widget, as for A), `denominator_metric_key`,
`denominator_aggregation` and `denominator_dimensions` (jsonb, default
`{}`). The check constraint requires them exactly for `compare`. `period`
and `display_currency` are shared by both sides. The API takes
`denominator: { connectionId, metricKey, aggregation?, dimensions? }`.

**Validation** (400 with a code):

- each side as a widget binding (metric, aggregation, filters);
- **one period** for both (it is one column), resolved in the workspace
  zone, so both windows align;
- **units:** a currency denominator is allowed only when the numerator is
  the same currency after conversion (the ratio is then unitless, e.g.
  ROAS), else `compare_units_incompatible`; a currency numerator over a
  non-currency denominator gives an amount per unit ("€0.42 per
  download") and needs `format: ratio`; `percent` needs two non-currency
  sides.

**Options.** `format`: `percent` (default) or `ratio` (a plain number with
two significant decimals, or an amount); `ratioLabel` (1–30 characters,
e.g. "conversion"; null shows "ratio"/"Verhältnis"); `showChange` (true:
Δ in percentage points for `percent`, relative for `ratio`).

**Payload** (`data`): the shared data fields (`status` is the worse of the
two sides, `updatedAt` the older; `unit` is the ratio's: null, or the
currency for an amount per unit) plus

```jsonc
{
  "numerator": { "label": "Downloads", "value": 12500, "unit": "downloads" },
  "denominator": { "label": "Visitors", "value": 38200, "unit": "visitors" },
  "ratio": { "value": 0.327, "previousValue": 0.308, "format": "percent" },
}
```

The ratio is A ÷ B over the period; null when B is zero or either side has
no data (a shared domain function `ratioOf` with vectors, which milestone
11 reuses).

**Rendering.** Label; the two operands side by side, each a number in the
new `operand` role (48 u, compact form when needed) with its caption
(24 u), separated by "/"; the ratio in the value role (at least 64 u) in
`chartLine` with `ratioLabel` and Δ (change role) beside it; the footer
"derived · updated 2 min ago". **Minimum 4 × 3**: two five-character
operands at 48 u and the separator need the 560 u of four columns.

**Motion.** Operands and ratio count up.

**Studio.** Inspector: two binding blocks ("Numerator", "Denominator") with
one shared period and display currency, Format, Ratio label, "Show
change". `fits`: the label.

**Milestone 11.** Compare keeps its ratio inside the widget: there is no
stored metric definition now, so no second persistent metric model.
When milestone 11 ships derived metrics, a compare widget offers "Save as
derived metric", which creates the definition `A / B` from its two
bindings (same filters, aggregation, period semantics and `ratioOf`
rules); the widget may keep showing its operands or be turned into a
metric widget bound to the new derived metric. Derived metrics then work
in every widget, including either side of a compare.

### 11. App Store review text (amends ADR 0014, decision 2)

ADR 0014 kept counts and star sums only. On the owner's decision, the
connector also fetches and netrics stores the text of recent reviews.

**Fetch.** The same `GET /v1/apps/{id}/customerReviews` pages the review
sync already reads (newest first, the Customer Support key's token, through
`runtime.fetch` to `api.appstoreconnect.apple.com`, no new host or role),
now with `fields[customerReviews]=rating,title,body,reviewerNickname,createdDate,territory`.
The API has no app version for a review, so none is stored. Counts and
star sums are unchanged.

**Storage: a typed `app_reviews` table**, not observations and not a
generic record store. Observations are numeric by design (ADR 0008).
A generic "connector records" store (kind plus jsonb) would still need a
schema, limits and retention per kind, and nothing else needs records
today; a typed table keeps lengths, retention and deletion checkable in the
database. If a second review source arrives (Google Play), it uses the
same table, which is why it is keyed by connection and provider id rather
than named after Apple.

| Column               | Type        | Notes                                                 |
| -------------------- | ----------- | ----------------------------------------------------- |
| `connection_id`      | uuid        | FK `(connection_id, workspace_id)`, on delete cascade |
| `workspace_id`       | uuid        | RLS                                                   |
| `provider_review_id` | text        | Apple's review id; primary key with `connection_id`   |
| `resource_id`        | text        | the app                                               |
| `rating`             | smallint    | 1–5                                                   |
| `title`              | text, null  | at most 300 characters (longer is cut on ingest)      |
| `body`               | text, null  | at most 4,000 characters                              |
| `author`             | text, null  | the reviewer nickname, at most 100 characters         |
| `territory`          | text, null  | ISO 3166-1 alpha-2                                    |
| `created_at`         | timestamptz | Apple's `createdDate`                                 |
| `hidden_at`          | timestamptz | set by "Hide this review" (moderation, below)         |
| `ingested_at`        | timestamptz |                                                       |

**SDK.** `SyncResult` gains an optional `reviews` array (SDK 0.2.8,
additive): `{ id, resource, rating, title, body, author, territory,
createdAt }`, plus `reviewWindows: [{ resource, from, to }]`, the spans
the page read completely. The host upserts the reviews and deletes stored
reviews of that resource inside a complete window that were not returned,
so edited and deleted reviews follow Apple within the existing 7-day
lookback. Connectors without reviews return neither.

**Retention.** Per app, the newest 50 reviews and none older than 90 days;
the hourly maintenance prunes the rest (the retention table in
`docs/architecture.md` gains the row). Backfill stores text only inside
that window; older history stays counts.

**Privacy.** The nickname is personal data and review text is user
content. Text is stored only while a reviews key is configured: removing
the key, deleting the connection or the workspace deletes the stored
reviews (cascade and an explicit delete on key removal). Review text never
appears in logs or error messages. It is not exported and has no list API:
it reaches clients only as the latest-review widget's payload (device
payload and the Studio's widget data). The privacy policy and the DPA
(#164) name it: a processing category "App Store customer reviews
(nickname, text, rating, country) of the customer's own apps", the
retention above, and Apple as the source.

**Moderation.** No automatic language filter (unreliable and
language-dependent). Instead: the widget's `minRating` and "Hide reviews
without text" options (section 12), and a **Hide this review** action on
the widget in the Studio (needs `dashboards:update`; audit
`review.hidden`), which sets `hidden_at` so no widget shows that review
again.

### 12. Latest review widget (`review`)

**Purpose.** The newest App Store review of an app on the wall: stars,
the text and who wrote it (design 4b).

**Binding and options.** `connection_id` (an App Store Connect connection;
a connector without review support is refused, 400
`reviews_not_supported`), an optional `resource` filter in `dimensions`
(one app; none means all apps of the connection), an optional `image_id`
(the app's resource icon, set by the Studio through the existing "use app
icon" path, so the device image endpoint serves it). Options: `minRating`
1–5 (default 1), `requireText` (true: skip reviews without a body),
`showAuthor` (**true**, as designed). One review only, the newest that
matches and is not hidden; a newer one replaces it on the next payload. No
rotation inside the widget (motion stays on the slide enter).

**Payload** (`data`):

```jsonc
{
  "status": "ok",
  "updatedAt": "2026-10-04T09:12:00Z",
  "review": {
    "rating": 5,
    "title": "Finally",
    "body": "Finally a dashboard I can leave on the office TV …",
    "author": "Marta P.", // null with showAuthor false
    "territory": "DE",
    "createdAt": "2026-10-04T07:02:00Z",
  }, // null: no matching review
}
```

Status: `auth_failed` with "App Store reviews paused — upload a new
reviews key" when the reviews key is missing or refused; `backfilling`
while the first review sync runs; `no_data` ("No reviews yet") without a
match; `stale` by the usual rule.

**Rendering.** A row with the icon (when set, 48 u, the theme's corner
radius), the app name (resource role) and five stars (28 u, filled in
`warning`, empty in `border`); the title (32 u, semibold, one line) and the
body (32 u, body role), wrapping into the lines that fit and then ending
with an ellipsis (data text); the author line "Marta P. · Germany · 2 h
ago" (24 u, `muted`; territory name localised, age from the device clock).
**Minimum 4 × 3**: the header row, title, two body lines and the author
line fit in 560 × 295 u at 16:9.

**Studio.** Inspector: connection, app, "Minimum stars", "Hide reviews
without text", "Show author", "Hide this review". `fits`: the label.

### 13. Amendments to ADR 0015

Section 2's table gains these rows (its "Later" paragraph now points
here):

| Type        | Shows                                          | Options (`options` jsonb)                                              | Min size |
| ----------- | ---------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| `gauge`     | A goal's progress, "goal reached"              | `showTimeLeft` (true); the goal is `goal_id`                           | 3 × 3    |
| `table`     | One metric by a dimension, ranked, with Δ      | `groupBy`, `limit` 3–10 (5), `showChange` (true), `showOthers` (false) | 4 × 4    |
| `status`    | Health and sync age of the workspace's sources | `connectionIds` (null: all), `showAge` (true)                          | 3 × 3    |
| `countdown` | Time left to a date and time                   | `target`, `timeZone`, `showTarget` (true), `doneText`                  | 3 × 2    |
| `compare`   | Two metrics and their ratio                    | `format` (`percent`), `ratioLabel`, `showChange` (true); a denominator | 4 × 3    |
| `review`    | The newest App Store review                    | `minRating` (1), `requireText` (true), `showAuthor` (true)             | 4 × 3    |
| `clock`     | (amended) adds a long date and a zone line     | adds `dateStyle` (`short`), `showZone` (false)                         | 2 × 1    |

Section 8's minimum text sizes gain (at `u = 1`, before `fontScale`):
table and status cell 28, column head 24, clock zone line 24, compare
operand 48, review title and body 32, review stars 28. Gauge, table,
compare and countdown values follow the value rule (at least 64, as large
as fits); the gauge ring is at least 160 u. Data text may end in an
ellipsis after shrinking (section 2). `STUDIO_MIN_WIDGET_SIZE`,
`STUDIO_TEXT_MINIMUMS`, `widgetTypeScale` and their Swift ports gain the
entries with vectors.

`formatWarnings` gains `rows_cut` (attention for tables, info for status
boards), `goal_missing` (attention), `countdown_passed` (info) and
`clock_parts_hidden` (info).

### 14. Order and split

One issue per item, each end to end (domain and vectors, contracts and
OpenAPI, migration where needed, server, web and tvOS renderers, Studio,
English and German). The first widget issue to merge also adds schema 3
`min` and the generalised `labelFit` (section 2); the others rebase onto
it.

| Wave | Issue                                        | Depends on                 |
| ---- | -------------------------------------------- | -------------------------- |
| 1    | Periods: this week, this quarter, this year  | –                          |
| 1    | Table widget                                 | –                          |
| 1    | Clock: long date and zone                    | –                          |
| 1    | App Store review text: fetch, store, privacy | –                          |
| 2    | Goals: entity, API and Goals page            | Periods                    |
| 2    | Compare widget                               | first widget issue (`min`) |
| 2    | Countdown widget                             | first widget issue (`min`) |
| 2    | Status board widget                          | first widget issue (`min`) |
| 3    | Goal widget (gauge)                          | Goals                      |
| 3    | Latest review widget                         | App Store review text      |

Periods come before goals because goals validate their period against the
new list. Compare, countdown and status board are independent of each
other. The issues belong to milestone 09.3 as follow-ups outside its exit
gate (#314).

## Alternatives considered

- **The target as a widget option** (the proposal). Simplest, but a target
  shown on two dashboards would be two numbers to keep equal, and alerts
  could not refer to it. The owner chose the shared entity.
- **Rolling periods for goals.** A rolling window never ends, so "days
  left" and "reached" have no meaning. Rejected; goals use period-to-date
  periods.
- **A 409 when deleting a goal in use** (as themes and images). Deleting a
  goal is a normal edit on the Goals page; the widget's not-found state and
  the Studio warning keep it visible instead of blocking.
- **New `goals:*` permissions.** Reusing the dashboard actions matches how
  themes and images are governed; a separate set can be split out with
  milestone 15's access work.
- **Week start by locale** (Sunday in the US). Weekly series already start
  on Monday; mixing both would make a week's chart and its total disagree.
  ISO Monday now, a workspace setting later.
- **Compare waiting for milestone 11** (the proposal). The owner wants it
  now; keeping the ratio inside the widget and offering a conversion later
  avoids two persistent metric models.
- **A binding table for compare** (one row per binding). More general, but
  only compare has two bindings; four columns with a check and a cascading
  key keep integrity as simple as the primary binding's.
- **A generic connector-records store for review text.** See section 11.
- **Not showing nicknames.** The owner chose to fetch them; showing is a
  widget option, on by default as designed.
- **Rotating through several reviews inside the widget.** Continuous motion
  outside the slide enter is excluded by ADR 0018 §6; several reviews can
  be several widgets or slides.
- **A degraded fallback in schema 2** (a gauge sent as `metric`, a table as
  `bar` to released builds). Every type would need projection code for a
  schema being retired, and Apple TV apps update automatically. Rejected.
- **A new payload schema for the new types.** Unnecessary: the union is
  open on every client (section 2).
- **Row limit fixed by size** (no `limit`). It would change what a
  dashboard shows between formats without saying so; an explicit limit
  plus `rows_cut` keeps it visible.
- **Zone abbreviations ("CEST").** Differ between ICU and Foundation and by
  locale. Rejected for the UTC offset.

## Consequences

- Six widget keys join the model, contracts and both renderers; the clock
  gains two options. Each issue ships web and tvOS together with vectors,
  as ADR 0015 requires.
- New tables `goals` and `app_reviews`, new columns `goal_id` and
  `denominator_*` on `dashboard_widgets`, wider period checks; all under
  RLS with cross-workspace tests. Existing rows are unchanged.
- The connector SDK gains optional `reviews` and `reviewWindows` in
  `SyncResult` (0.2.8, additive).
- netrics now stores personal data from App Store reviews: retention,
  deletion and the privacy documents (#164) change with the review-text
  issue, and `docs/connectors/app-store-connect.md` stops saying review
  text is never fetched.
- The sidebar gains Goals under Dashboards.
- Every widget and goal can use week, quarter and year to date.
- Milestone 11's widget slice moves here (table, gauge, health and compare
  ship in 09.3); milestone 11 gains "save a compare widget as a derived
  metric" and reuses `ratioOf`. Milestone 14 can alert on goals.
- Released tvOS builds show empty themed cells for the new types until
  they update; the web kiosk follows each deploy.
