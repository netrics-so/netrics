# 0019 — Signal widget types: goal, table, status board, countdown, clock zone

Status: proposed (owner decision pending; #312). Amends
[ADR 0015](./0015-dashboard-studio.md) sections 2 and 8.

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
  plus `options` jsonb validated by zod per type. Two check constraints
  list the types (`dashboard_widgets_type_valid`) and tie the binding
  columns to the data types (`dashboard_widgets_type_columns`).
- **Queries.** `queryMetric` gives a value, the previous period's value and
  both series; `queryMetricBreakdown` gives one value per dimension value
  (top `limit` plus "Others") for the current window only. Periods are
  `today`, `last_7_days`, `last_30_days`, `this_month`, `last_90_days`,
  `last_12_months`; there is no week, quarter or year to date.
- **Dimensions with useful rows.** Vercel `route_pageviews` (route),
  `country_visitors` (country) and `events` (event); App Store Connect
  territory, device, source and rating; every metric by `resource`. Search
  Console has no page or query dimension, so the design's "Top pages ·
  clicks" is a Vercel "Top routes" table today.
- **Connection health.** `connection_state` gives `health` (`ok`,
  `pending`, `auth_failed`, `needs_reauthorization`, `outage`),
  `lastSuccessAt` and the poll interval; `tileStatus` derives a widget's
  `ok`/`stale`/`auth_failed`/`outage`/`no_data`/`backfilling` from it. The
  admin top bar already summarises source health.
- **Reviews.** App Store Connect reads customer reviews with an optional
  Customer Support key, but asks Apple only for `rating`, `createdDate` and
  `territory`: titles, bodies and nicknames are never fetched or stored
  (ADR 0014, decision 2; connector `reviews.ts`). The metrics are counts and
  star sums per day.
- **Clock.** Already has `showDate`, `hour12` and `timeZone`; no zone line.
- **Unknown types on screens.** tvOS decodes a widget type it does not know
  as `WidgetContent.unsupported` and draws an empty themed cell; this has
  been true since schema 2 support (#222). Its schema 3 reflow lays out an
  unknown type as the smallest widget (`layoutType` falls back to `image`,
  1 × 1). The web renders unknown types as the "could not be shown" notice
  (`WidgetFailed`). Unknown fields and options are ignored on both.
- **Derived metrics** (a restricted expression grammar, unit, currency and
  zero-division rules, stored definitions) belong to milestone 11, which
  also lists "table, gauge and health widgets".
- **Alerts** (threshold rules with states) belong to milestone 14.

## Decision

### 1. Summary

| Type (key)                    | Ships        | Binding                              | Min (cells) | Payload `data` (section)         |
| ----------------------------- | ------------ | ------------------------------------ | ----------- | -------------------------------- |
| Goal (`gauge`)                | yes          | one metric + `target`                | 3 × 3       | value, target, progress (§3)     |
| Table (`table`)               | yes          | one metric by a dimension            | 4 × 4       | rows with Δ (§4)                 |
| Status board (`status`)       | yes          | connections of the workspace         | 3 × 3       | items with health and age (§5)   |
| Countdown (`countdown`)       | yes          | none (a date and time in the widget) | 3 × 2       | none; `targetAt` in options (§6) |
| Clock date and zone (`clock`) | yes          | none (extends the existing type)     | 2 × 1       | none (§7)                        |
| Compare / derived             | milestone 11 | one derived ratio metric             | 4 × 3       | operands and ratio (§8)          |
| Latest review                 | deferred     | needs review text, which is not kept | 4 × 3       | (§9)                             |

The user-facing name of `gauge` is "Goal" ("Ziel"): every gauge has a
target. The key stays `gauge`, the word milestone 11 and the design use.

### 2. Rules every new type follows

**Compatibility rule.** A new widget type, or a new option or data field
of an existing type, is additive: it needs no new payload schema and no
`DEVICE_API_VERSION` change. Every client that reads schema 2 or 3 ignores
unknown fields and renders an unknown type safely (tvOS: an empty themed
cell; web: the "could not be shown" notice). New types are therefore sent
in schemas 2 and 3 as further members of the widget union. Schema 1 is
unchanged (it carries only `metric` widgets). A new schema is needed only
when an existing type's fields change meaning, which nothing here does.

**Forward-compatible reflow.** Released tvOS builds reflow an unknown type
as 1 × 1, so on a non-primary format their placement of the empty cell can
differ from the Studio preview (only for that cell's stack; schema 2 is
laid out on the server and is exact). From the first new type on, schema 3
widgets carry `min: { w, h }`, the type's minimum size, and clients use it
for types they do not know. Old builds ignore it; newer builds reflow any
future type exactly.

**Storage.** One migration widens `dashboard_widgets_type_valid` to the
accepted keys (`gauge`, `table`, `status`, `countdown`) and lets
`dashboard_widgets_type_columns` treat `gauge` and `table` as data types
(binding columns required) and `status` and `countdown` as non-data types
(binding columns null, like `clock`). Everything type-specific lives in
`options` jsonb, validated by zod. The API's widget union admits a type only
once its issue ships, so the database never holds a type the server cannot
render.

**Limits.** `gauge` and `table` count as data widgets toward the 48 per
dashboard. A table costs two grouped queries (current and previous window);
`status` costs one small query per payload shared by all status boards.

**Labels.** Data types resolve `label` on the server exactly like
`metric` (title or metric name, then the resource line, `tileLabel`).
`status` and `countdown` send their title, or a localised default
("Sources"/"Quellen", "Countdown"). `labelFit` treats every type with a
label like a data widget: title and resource line at 30 u, at most two
lines each.

**Data states** (ADR 0018 §5) for `gauge` and `table` come from
`tileStatus`, with the same surfaces as `metric`: stale (warning border,
value dimmed, ring and Δ in `muted`), auth failed ("Reconnect …"), no data
and backfilling (dashed border, skeleton). `status` is itself a status
display and is always `ok` (empty: "No sources connected"). `countdown`
and `clock` have no data states.

**Colours** are the theme's tokens; nothing new is added to themes (ADR
0018 §5). Good and bad are `up` and `down`, attention is `warning`, quiet
parts are `muted`, the gauge track is `border` and its fill `chartLine`.
Tinted surfaces (goal reached) are derived with `color-mix` like the
layered surfaces; flat themes stay flat.

**Motion** (ADR 0018 §6) is part of the slide enter only: values count up,
the gauge arc draws (`pathLength` dash offset), table and status rows rise
14 u and fade in with a 90 ms stagger (each row 400 ms, ease-out cubic; at
most 10 rows, so the last ends with the 1200 ms enter). Nothing new
animates continuously. Reduce Motion shows the final state.

**Readability.** Every text is at least 24 u; every primary value at least
64 u and as large as fits. New text roles (section 10) join
`STUDIO_TEXT_MINIMUMS`, `widgetTypeScale` and the Swift port. Each type gets
a content-layout function in `packages/domain` (`gaugeLayout`,
`tableLayout`, `statusLayout`, `countdownLayout`, `clockLayout`), ported to
Swift and covered by `studio-layout.json` vectors, because `fits` and the
Studio need the same answers the renderers use. (Today the content layouts
of `metric`, `line` and `bar` live in `apps/web/src/lib/studio-render.ts`
and `StudioRender.swift`; new types start in the domain.)

**Scroll view** (ADR 0017 §5): `table` spans the full row when it is at
least 6 columns wide in the primary, like text and image; the others take
one column. Heights fit content; a table shows all `limit` rows and a
status board all its items, because scroll view has no height limit.

**Reflow** needs no change: the minimum sizes are cells and mean the same
in every format (ADR 0017 §1).

**Studio.** The add-widget menu gains Goal, Table, Status and Countdown
(Clock exists). `newWidget` creates each at its minimum size with valid
defaults (below). The inspector reuses the data-binding fields of `metric`
and `bar` where they apply. New strings in English and German (ADR 0016).

### 3. Goal (`gauge`)

**Purpose.** Progress of one metric toward a target in the period: "83 % of
15,000 downloads this month, 2,520 to go, 9 days left", and a distinct
"goal reached" state.

**Binding and options.** The metric binding of `metric`, restricted:

- `aggregation`: `sum` for `delta` metrics (period to date, the usual
  goal) or `last` for `gauge` and `counter` metrics (a level to reach).
  Others are refused (400 `aggregation_not_supported`): "to go" means
  nothing for an average.
- Metrics whose `better` is `lower` (average position) are refused (400
  `goal_direction_unsupported`) in this version.
- `target`: number, finite, > 0, at most 1e15, **in the unit the payload
  value uses**: minor units for currency, 0–1 for `ratio`. The inspector
  converts what the user types (major units, percent). A currency goal must
  have a fixed currency (a `currency` dimension filter or a
  `displayCurrency`), else 400 `currency_required`, so the target never
  changes meaning.
- `showTimeLeft` (true): "N days left" for calendar periods.

**Period to date, no projection.** The value is the period so far, as on
every widget. "Days left" exists only where the period has an end:
`this_month` (whole days after today: "9 days left", on the last day
"last day") and `today` ("5 h left", under one hour "< 1 h left"). Rolling
periods (`last_7_days` …) show "to go" only. A linear "on pace for …" line
is not in this version (Alternatives). Week, quarter and year to date need
new periods for every widget; they are a separate issue, not a gauge
option (open question 3).

**Where the target lives: a widget option.** It is the smallest model that
works today: no table, no API, one place to edit. A stored goal entity
would pay off only when several widgets or alert rules share one target
(milestone 14). If that comes, `options.goalId` can be added beside
`target` without migrating existing widgets (open question 1).

**Payload** (`data`): the shared data fields (`period`, `aggregation`,
`unit`, `conversion`, `kind`, `granularity`, `better`, `status`,
`updatedAt`) plus

```jsonc
{
  "value": 12480, // null without data
  "target": 15000,
  "progress": 0.832, // value ÷ target, not clipped; null without data
  // Bucket start where the running sum first reached the target (sum of a
  // delta metric only), else null.
  "reachedAt": null,
  // Exclusive end of a calendar period in the workspace zone; null for
  // rolling periods.
  "periodEnd": "2026-11-01T00:00:00+01:00",
}
```

Clients compute "days left" and "N days early" from `periodEnd`,
`reachedAt` and their clock with one domain function (`goalTimeText`,
vectors), so a cached payload stays right offline and the `ETag` does not
change at midnight.

**Rendering.** A stack, top to bottom: the label; the target line ("Goal
15,000" in the resource role, one line); the ring with the value centred
inside it; the progress line ("2,520 to go · 9 days left", change role, at
most two lines); the freshness footer. The ring is a full circle starting
at 12 o'clock, stroke 10 % of its diameter (at least 16 u), track
`border`, fill `chartLine`, round caps, filled to `min(progress, 1)`; its
diameter is what is left, at most the content width, **at least 160 u**.
When height runs short, the footer goes first, then the target line (as
charts drop their footer, #309). When the content is at least 1.6 times as
wide as high, the ring sits right of the text instead. In progress the
value inside the ring is the percent, rounded **down** (never "100 %"
before the goal is reached); once reached it is the value itself.

**Goal reached** (`progress ≥ 1`): ring and value in `up`, a surface
tinted toward `up` with a border of `up` at 35 % (glow only on non-flat
themes), and the line "✓ Reached · 122 % · 2 days early" ("early" only
with `reachedAt` and a calendar period; on `today` just "✓ Reached ·
122 %"). Stale data never shows "reached" in `up`: the stale surface wins.

**Minimum 3 × 3.** At 16:9 its content box is 404 × 295 u: a one-line
title (35), the target line (35), the ring (160), the progress line (32)
and the gaps fit (285 u); the footer appears from 3 × 4. At 3 × 2 the ring
would be under 60 u.

**Motion.** The arc draws from 0 to `progress`, the value counts up; end
caps appear when the draw completes.

**Studio.** Inspector: the metric binding (connection, metric, resource,
period, aggregation limited as above, display currency), Target (number
field in display units with the unit beside it; prefilled with the
previous period's value rounded up to two significant figures when the
Studio has it, else empty and required before Save), "Show time left".
`fits`: the label (as `metric`) and a new problem `target_missing`.

### 4. Table (`table`)

**Purpose.** A ranked list of one metric by a dimension with the change
per row: top routes by page views, downloads by territory, reviews by
rating.

**Binding and options.** The metric binding of `bar` (any aggregation the
metric allows; `groupBy` must be one of its dimensions and not
`currency`, as for bars), plus:

- `groupBy`: dimension key (required).
- `limit`: 3–10 rows (default 5).
- `showChange` (true): the Δ column.
- `showOthers` (false): a last, dimmed "Others" row.

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

**Rendering.** Label, a column-head row (24 u, caps, `muted`, tracked),
the rows (cell role 28 u), the footer. Columns: the dimension label takes
what is left; the value column is as wide as the widest value (tabular
figures, compact form when needed, never cut); the Δ column as wide as
"+999 %". Δ is coloured by `better` ("+12 %", "−3 %"; "new" when the
previous value is missing or zero and the value is not; "–" without both).
Row labels are data, known only at render time: they shrink to 24 u and
then, as the one exception to "never cut", end with an ellipsis. Row pitch
is the cell line plus 12 u.

**Rows by height.** `tableLayout` returns how many rows fit
(`rowCapacity`). A screen shows `min(limit, rows, rowCapacity)` rows and
the subtitle says how many ("Top 5 · Last 30 days"), so nothing is dropped
silently. The Studio warns when `limit` exceeds the capacity in a format
(new warning `rows_cut`, attention, "Shows 5 of 8 rows").

**Minimum 4 × 4.** The smallest `limit` (3 rows) must fit at every font
scale. At 16:9 a 4 × 4 content box is 560 × 414 u: label, heads and footer
leave room for 6 rows at font scale 1 and 4 at 1.3, and the label column
keeps about 370 u (around 20 characters at 28 u). Three rows high, only 2
rows fit at 1.3; three columns wide, a route keeps about 12 characters.

**Motion.** Rows rise with the stagger of section 2; values do not count
(many moving numbers are noise).

**Studio.** Inspector: binding as for bar charts (Group by, Rows 3–10,
"Show change", "Show Others"). `fits`: label, and `rows_cut` per format.

### 5. Status board (`status`)

**Purpose.** Are the numbers on this wall fresh? One row per source with
a health dot and the age of its last successful sync, as in design 4a
("Search Console · 14 m", "App Store Connect · 3 h" in amber).

**What a status is: connection health.** It is the smallest useful
definition that uses existing data: `connection_state` already drives
every widget's status and the admin's source-health summary. Metric
thresholds ("visitors below 100") are alert rules and belong to milestone
14; when alerts exist, a status board may list rule states as a second
source (`options.source: "alerts"`), not before.

Per connection, with the `tileStatus` rules (`hasData` true):

| Item status   | When                                                          | Dot       |
| ------------- | ------------------------------------------------------------- | --------- |
| `ok`          | healthy and synced within 3 poll intervals (at least 15 min)  | `up`      |
| `stale`       | healthy but the last success is older, or never               | `warning` |
| `backfilling` | first sync pending, or a backfill queued or running           | `muted`   |
| `auth_failed` | `auth_failed`, `needs_reauthorization`, or setup not finished | `down`    |
| `outage`      | `outage`                                                      | `down`    |

**Options.** `connectionIds`: null (every connection of the workspace,
default) or 1–12 ids of the workspace's connections, validated on save;
a deleted connection drops out of the list (the server removes stale ids
on the next save and ignores them in the payload). `showAge` (true).

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
credentials or error texts are sent.

**Rendering.** Label; rows of dot (14 u), name (cell role 28 u, one line,
shrink then ellipsis as table labels) and, right-aligned, the age ("14 m",
"3 h", "2 d"; 24 u, `muted`, `warning` when stale); a footer "4 connected
· 1 delayed". Ages are computed on the client from `lastSuccessAt`. When
items exceed the rows that fit, the last row becomes "+N more"; because
problems sort first, a problem is never the one hidden.

**Minimum 3 × 3.** At 16:9 five rows fit at font scale 1 and three at 1.3
(row pitch 44 u, 54 u at 1.3, in a content box of 404 × 295 u); the design
shows four.

**Studio.** Inspector: "All sources" or a checklist of connections; "Show
age". `fits`: label, and `rows_cut` (info) when the chosen connections
exceed the capacity.

### 6. Countdown (`countdown`)

**Purpose.** Time left to a moment set in the widget: "Launch in 2 d 14 h
05 m", with the target below.

**Options.**

- `target`: a local date and time, `YYYY-MM-DDTHH:mm` (year 2000–2100).
- `timeZone`: IANA zone, null for the workspace's (as the clock).
- `showTarget` (true): the subtitle "Tue 7 Oct · 10:00".
- `doneText`: 1–40 characters or null (localised "Now"/"Jetzt").

A past target is valid: a dashboard saved after its launch must still
save.

**Payload.** No `data`. The server resolves the options in the payload as
it does the clock's zone: `timeZone` (resolved) and `targetAt`, the
instant in UTC (`zonedInstant(target, zone)` in the domain: a time in a
spring-forward gap moves forward, an ambiguous one takes the earlier
offset; vectors). Screens count down from their own clock, ticking each
minute like the clock, so the `ETag` never changes with time.

**Rendering.** Label (the title, e.g. "Launch in"); the target line;
the remaining time as up to three groups, number (value role, ≥ 64 u, as
large as fits) plus unit letter (change role 28 u, `muted`): "2 d 14 h
05 m" from one day on, "14 h 05 m" below, "41 m" below an hour, "< 1 m" in
the last minute. Letters come from the catalog (en d/h/m, de T/Std/Min).
Days can reach three digits; the fitted size uses the widest digits so it
does not jump. At and after `targetAt` the widget shows its done state:
`doneText` at heading size in `accent`, and the target line.

**Minimum 3 × 2.** Title, target line and the value fit in 404 × 175 u
at 16:9, like a metric.

**Motion.** None beyond the slide fade: a countdown does not count up
from zero.

**Studio.** Inspector: date and time fields, time zone (as the clock),
"Show target", "Text when reached". `fits`: label, and a new info warning
`countdown_passed` once the target is in the past.

### 7. Clock with date and zone (extends `clock`)

The existing clock gains two options instead of a new type; released
builds ignore them and keep showing time and date:

- `dateStyle`: `short` (default, today's "Sat 4 Oct") or `long`
  ("Saturday, 4 October"; "Samstag, 4. Oktober").
- `showZone` (false): a zone line "Berlin · UTC+2".

The zone line is the city (the IANA name's last part, underscores as
spaces; `Etc/UTC` is "UTC") and the current UTC offset (`UTC+2`,
`UTC+5:30`, `UTC−3`, `UTC`), from `zoneLabel(timeZone, now)` in the
domain with vectors. Not the abbreviation ("CEST"): ICU and Foundation
disagree on abbreviations by locale, and many zones have none, so the
offset is the one form both platforms produce identically.

Type scale: time at least 56 u (unchanged), date in the title role (30 u),
zone in the `zone` role (24 u, `muted`). The design's 64 px clock is 96 u
at 1080p, which the existing "as large as fits" rule already gives a 3 × 3
clock. Minimum stays 2 × 1; when the lines do not fit, the zone line goes
first, then the date, and the Studio reports a new info warning
`clock_parts_hidden`. Inspector: "Date: short / long", "Show time zone".

### 8. Compare / derived: in milestone 11, as a view of a derived ratio

The design's compare widget ("12.5k downloads / 38.2k visitors → 32.7 %
conversion, ▲ 1.9 pt") is a quotient of two metrics. Building it now would
mean a second metric binding on widgets (more columns or a binding table,
another foreign key, alignment of two windows, unit and currency rules,
zero division) — exactly the model milestone 11 defines for derived
metrics. Two models for "a ÷ b" would drift.

Decision: compare ships with milestone 11 and binds **one derived metric
whose definition is a quotient of two metric references**. The widget shows
the two operands (from the definition) and the ratio; any other widget can
show the same derived metric as a plain number. Specified now so milestone
11 only implements it:

- Options: `format` (`percent` or `number`), `ratioLabel` (1–30
  characters, e.g. "conversion"), `showChange` (Δ in percentage points for
  `percent`, else relative).
- Payload: the shared data fields plus `operands: [{ label, value, unit },
{ … }]` and `ratio: { value, previousValue }`; status is the worse of the
  two inputs.
- Type scale: ratio in the value role (≥ 64 u); operands in a new
  `operand` role (48 u) with captions at 24 u. **Minimum 4 × 3**: two
  operands of five characters at 48 u and the separator need the 560 u of
  four columns.
- In the meantime the average rating of App Store reviews (ADR 0014: review
  stars ÷ reviews) and ROAS are the motivating cases for milestone 11's
  first derived metrics.

### 9. Latest review: deferred; the data does not exist

No connector provides review text. App Store Connect deliberately requests
only rating, date and territory and stores counts (ADR 0014). A "latest
review" widget needs the review title, body and reviewer nickname, which
means:

- reversing a recorded privacy decision: nicknames are personal data, and
  the review text is user-generated content shown on an office wall
  (offensive text, moderation, Apple's terms for displaying reviews);
- a new non-numeric store beside observations (one row per review, kept
  for a bounded window, deleted when Apple deletes or edits the review),
  with RLS, retention and deletion rules;
- connector work under the existing Customer Support key (the API returns
  `title`, `body` and `reviewerNickname` when asked).

This is an owner decision (open question 2), then its own ADR amendment to
ADR 0014 and a connector issue before any widget work. If accepted, the
widget is: options `connectionId`, optional `resource`, `minRating`
(1–5), `showAuthor` (false by default); payload `{ rating, title, body,
territory, createdAt, author? }`; rendering the app icon (existing
resource icons), stars in `warning`, the quote at body size (32 u, at most
four lines, then an ellipsis with the Studio warning), author line 24 u;
minimum 4 × 3. Until then, review counts and the rating distribution are
available as `metric` and `bar` widgets.

### 10. Amendments to ADR 0015

Section 2's table gains these rows (and the "Later" paragraph now points
here):

| Type        | Shows                                          | Options (`options` jsonb)                                              | Min size |
| ----------- | ---------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| `gauge`     | Progress toward a target, "goal reached"       | `target`, `showTimeLeft` (true)                                        | 3 × 3    |
| `table`     | One metric by a dimension, ranked, with Δ      | `groupBy`, `limit` 3–10 (5), `showChange` (true), `showOthers` (false) | 4 × 4    |
| `status`    | Health and sync age of the workspace's sources | `connectionIds` (null: all), `showAge` (true)                          | 3 × 3    |
| `countdown` | Time left to a date and time                   | `target`, `timeZone`, `showTarget` (true), `doneText`                  | 3 × 2    |
| `clock`     | (amended) adds a long date and a zone line     | adds `dateStyle` (`short`), `showZone` (false)                         | 2 × 1    |

Section 8's minimum text sizes gain (at `u = 1`, before `fontScale`):
table and status cell 28, column head 24, clock zone line 24, compare
operand 48 (milestone 11). Gauge, table and countdown values follow the
value rule (at least 64, as large as fits); the gauge ring is at least
160 u. Row labels of tables and status boards may end in an ellipsis after
shrinking to 24 u (section 4); titles and values keep the existing rules.
`STUDIO_MIN_WIDGET_SIZE`, `STUDIO_TEXT_MINIMUMS`, `widgetTypeScale` and
their Swift ports gain the entries with vectors.

`formatWarnings` gains `rows_cut` (attention for tables, info for status
boards), `countdown_passed` (info) and `clock_parts_hidden` (info).

### 11. Order and split

One issue per type, each end to end (domain and vectors, contracts and
OpenAPI, server payload, web renderer, tvOS renderer, Studio add-widget and
inspector, English and German):

| Order | Issue                     | Depends on                                                                         | Notes                                                                                         |
| ----- | ------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1     | Goal widget (`gauge`)     | this ADR                                                                           | Carries the groundwork: the migration for all four types, schema 3 `min`, unknown-type reflow |
| 1     | Clock: long date and zone | this ADR                                                                           | No migration; independent of the others                                                       |
| 2     | Table widget (`table`)    | 1 (Goal)                                                                           | Previous-window breakdown query; `rows_cut`                                                   |
| 2     | Countdown widget          | 1 (Goal)                                                                           | `zonedInstant`; no data                                                                       |
| 2     | Status board (`status`)   | 1 (Goal)                                                                           | Connection health query shared per payload                                                    |
| –     | Compare / derived         | milestone 11 derived metrics                                                       | Spec in section 8; milestone 11's widget list shrinks to it                                   |
| –     | Latest review             | owner decision (open question 2), then an ADR 0014 amendment and a connector issue | Spec sketch in section 9                                                                      |

Goal goes first because it exercises everything new (a restricted
binding, a new layout function with vectors, a tinted state, a drawn arc)
and carries the shared groundwork; the three in wave 2 are independent of
each other once it lands. The issues belong to milestone 09.3 as
follow-ups outside its exit gate (#314).

## Open questions for the owner

1. **Where goals live.** This ADR stores the target in the widget. If you
   expect goals to be shared (the same target on several dashboards, or a
   "goal reached" notification in milestone 14), say so and the Goal issue
   adds a small `goals` table instead. Recommended: widget option now.
2. **Review text.** Do you want netrics to fetch and store App Store review
   titles, bodies and (optionally) nicknames to show the latest review on
   screens? It reverses ADR 0014's "never fetched" and adds personal and
   user-generated data to the product. Recommended: not now; revisit with a
   reason beyond the design.
3. **Week, quarter and year to date.** Weekly goals ("Weekly signups goal"
   in the design) need a `this_week` period (and perhaps `this_quarter`,
   `this_year`) for every widget, with database checks, contracts and tvOS
   enums. Should that be its own issue now? Recommended: yes, after Goal.
4. **Compare in milestone 11.** Confirm that compare waits for derived
   metrics rather than shipping earlier with a second binding on widgets.
5. **Gauge shape.** The design draws a full ring; a 270° arc reads better as
   a "gauge" but leaves less room for the value. This ADR keeps the ring.

## Alternatives considered

- **A stored goal entity now.** One target shared by widgets and alerts,
  but a table, API, permissions and an editor for a value that today lives
  on one widget. Deferred behind open question 1; `goalId` can be added
  without migrating.
- **Projection ("on pace for 16,200").** Linear pace is easy but misleads
  for seasonal or weekly patterns, and the design does not show it.
  Possible later as an option.
- **Gauge without a target** (a value against an implicit maximum, e.g.
  CTR against 100 %). Every case seen is a goal; an implicit maximum mostly
  shows a nearly empty ring. Rejected.
- **Status as metric thresholds.** Needs a rule model with states and
  hysteresis, which milestone 14 builds for alerts. Rejected here; the
  board can list alert states later.
- **Compare with a second binding on widgets now.** Duplicates milestone
  11's model (section 8). Rejected.
- **Showing a review without its text** ("★★★★★ · Germany · 2 h ago" from
  the stored counts). Counts per day cannot say which review was last or
  when exactly; it would be guesswork. Rejected; counts stay in metric and
  bar widgets.
- **A new `clock` type for date and zone.** Two clock types for one
  concept. Rejected for two options on the existing type, which older
  builds ignore safely.
- **Zone abbreviations ("CEST").** Differ between ICU and Foundation and by
  locale, and do not exist for many zones. Rejected for the UTC offset.
- **A degraded fallback in schema 2** (a gauge sent as `metric`, a table as
  `bar` to released builds). Released builds would show something, but
  every type would need projection code for a schema being retired, and
  Apple TV apps update automatically. Rejected; released builds show an
  empty themed cell until they update.
- **A new payload schema for the new types.** Unnecessary: the union is
  open on every client (section 2). Rejected.
- **Row limit fixed by size** (no `limit` option, as many rows as fit). It
  changes what a dashboard shows between formats without saying so;
  an explicit limit plus `rows_cut` keeps it visible. Rejected.

## Consequences

- Four widget keys join the model, the contracts and both renderers; the
  clock gains two options. Each issue ships web and tvOS together, with
  vectors, as ADR 0015 requires.
- Content layout for new types lives in `packages/domain` with vectors,
  which also gives `fits` exact answers. Moving `metric`, `line` and `bar`
  there is optional later work.
- Schema 3 widgets carry `min`, so later types reflow correctly on builds
  that do not know them.
- One migration widens two check constraints; existing rows are unchanged.
- Milestone 11's widget list shrinks to compare (table, gauge and health
  ship here); milestone 11 gains the compare spec of section 8.
- Latest review stays out until the owner decides on review text; ADR 0014
  is unchanged.
- Released tvOS builds show empty themed cells for the new types until
  they update; the web kiosk follows each deploy.
