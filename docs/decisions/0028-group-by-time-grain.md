# 0028 — Time grain for grouped dates and timestamps

Status: accepted (2026-11-22; [#838](https://github.com/netrics-so/netrics/issues/838)).
Extends ADR 0022 (§4 query semantics, §5 widget bindings).

## Context

Grouping by a timestamp dimension makes one group per distinct instant.
"New items per day" of a custom API dataset therefore needed two extra
preparation steps (a `to_date` column and a group), and a preparation's
`to_date` reads the UTC day, not the workspace's. The grain is part of what
a saved widget means, so its semantics are written down here.

## Decision

### 1. The grain belongs to the query, not to the dimension

A model query, and a measure widget's binding, carry an optional
`groupByGrain`: a record from a grouped dimension's id to `day`, `week` or
`month`. `groupBy` stays a list of dimension ids.

- A choice per use: the same timestamp can be a table per day and a chart
  per month without publishing the model again, and without a dimension per
  grain.
- Additive: bindings, published models and queries without the field mean
  what they meant. A widget's field is stored in its binding (JSON), so no
  migration is needed.
- A dimension-level grain was rejected: it changes the dimension's type for
  every reader (filters, items widgets, relationships) and needs a new model
  release per grain.

### 2. Semantics

- **The value is a date**: the first day of the bucket (`2026-11-02` for a
  day, the Monday for a week, the 1st for a month). Groups are keyed,
  ordered and returned by it, nulls last as for any dimension, so date
  formatting, sorting and "latest points" of a chart work unchanged.
- **Weeks start on Monday** (ISO), as the product's period windows count
  them ("this week", `startOfWeek`).
- **Time zone**: a timestamp's day is its calendar day in the workspace time
  zone at that instant. A day with 23 or 25 hours is one day; zones with
  offsets that are no whole hours are read the same way. The server takes
  the zone from the workspace, never from the request; it is part of the
  executed query, so a remembered result or a pinned page of one zone is
  never served for another. A **date** dimension is never shifted: its
  `day` is itself, `week` and `month` are calendar arithmetic.
- **Missing values** stay one group without a value.
- **Filters compare the dimension's own values**, before bucketing. A
  dashboard filter on the same timestamp still means instants.
- **Limits apply to buckets**: `limit`, `offset`, `window: "last"` and an
  order by a measure page and rank the buckets, not the rows.
- **Refused**: a grain on a dimension that is neither a date nor a timestamp
  (`model_group_grain_not_temporal`), on a dimension the query does not
  group by (`model_group_grain_not_grouped`; on a widget
  `dashboard_measure_grain_invalid`), an unknown grain
  (`model_group_grain_invalid`), and a grain on the date a rolling or
  period-offset measure is evaluated per
  (`model_group_grain_window_unsupported`).
- **A bucket is no scope**: a measure with `requiredDimensions` needs that
  dimension itself (or a filter fixing it); grouped by week or month it is
  refused as unscoped, since a bucket holds several of its values.
- **No labels**: a bucket is not one of the dimension's labelled values.
- **No click-to-filter**: a declared interaction on a bucketed dimension is
  refused (`dashboard_interaction_grain_unsupported`); a click would set the
  filter to the bucket's first day, not to a value of the dimension.
- Instants before the year 100, and days past 9999-12-30, are read as their
  UTC day: no zone has rules there (a source's zero time stays one day).

### 3. Where it is computed

In the shared query engine (`querySemanticModel`), in the single pass over a
dataset's rows that already resolves dimension values: a row is filtered on
its own values, then keyed by its bucket. No group per instant is ever
built, so the cost is one zone lookup per row (remembered per quarter hour of
UTC) inside the existing operation budget and row limits. The engine
evaluates loaded tables in the server process; there is no SQL statement to
truncate in. Preparations are unchanged: their `to_date` remains the UTC
day.

### 4. Clients

A widget's result names its dimensions with the types the rows carry: a
bucketed timestamp is reported as `date` in the widget's `metadata`. The web
app and the Apple TV app format a dimension by that type, so they show
"Nov 2, 2026" / "02.11.2026" without a change, and current TV builds need no
update. The device payload's shape is unchanged.

## Out of scope

Hour, quarter and year grains; fiscal calendars; a time zone per widget;
grains in filters; bucket labels such as "CW 45" or "November 2026" (a
bucket reads as its first day); changes to preparations.
