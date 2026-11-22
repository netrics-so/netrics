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
- **A date per day is no grain.** `day` on a date dimension changes
  nothing, so it has one stored form: none. Saving a widget drops it, and
  such a widget behaves exactly like one without the field (click-to-filter
  included). The query accepts it and ignores it.
- **Refused by the query**: a grain on a dimension that is neither a date
  nor a timestamp (`model_group_grain_not_temporal`), on a dimension the
  query does not group by (`model_group_grain_not_grouped`), an unknown
  grain (`model_group_grain_invalid`), and a bucketing grain on the date a
  rolling or period-offset measure runs on
  (`model_group_grain_window_unsupported`).
- **A bucket is no scope**: a measure with `requiredDimensions` needs that
  dimension itself (or a filter fixing it); grouped by week or month it is
  refused as unscoped, since a bucket holds several of its values.
- **One rule for widgets and Studio.** The dimensions a measure is read per
  value of are its required dimensions and the date of its windows and
  comparisons (`modelMeasureFixedGrainDimensions`; in the published catalog
  each measure's `fixedGrainDimensions`). A widget may not bucket such a
  dimension with any of its measures: saving refuses it
  (`dashboard_measure_grain_unsupported`), and Studio offers only the
  remaining choices (`allowedTimeGrains`), disables the others with a
  reason, and takes a grain back when such a measure is added. A grain for
  a dimension the widget does not group by is
  `dashboard_measure_grain_invalid`.
- **No labels**: a bucket is not one of the dimension's labelled values,
  and the dimension's display names are not read at all unless the filter
  names it (a filter's values keep their names).
- **No click-to-filter**: a declared interaction on a bucketed dimension is
  refused (`dashboard_interaction_grain_unsupported`); a click would set the
  filter to the bucket's first day, not to a value of the dimension.
- **Every valid value has a bucket**, a well-formed date, computed from the
  parsed instant, never from the value's text (`…T24:00:00Z` is the next
  day), with UTC a zone like any other. Two edges, where no zone has rules
  or no date exists: an instant before 0100-01-01T00:00:00Z is read as its
  UTC day (a source's zero time stays one day), and a day past 9999-12-31
  in the zone is 9999-12-31. The week holding 0000-01-01 is cut at that
  day. A value that is no date or timestamp cannot be in a table (tables
  are validated before a query reads them); should one reach the
  bucketing, the query fails with the same data error
  (`data_timestamp_invalid`, `data_date_invalid`), never with a malformed
  group.

### 3. Where it is computed

In the shared query engine (`querySemanticModel`), in the single pass over a
dataset's rows that already resolves dimension values. A row is first
filtered on its own values and, for rolling and comparison measures,
checked against the window's bounds; only a row that remains is bucketed,
once per bucketed dimension, and that result keys both its window partition
and its group. A row a filter or bound excludes costs what it costs without
a grain. No group per instant is ever built, so the cost is one operation
and one zone lookup per kept value (remembered per quarter hour of UTC)
inside the existing operation budget and row limits. The engine evaluates
loaded tables in the server process; there is no SQL statement to truncate
in. Preparations are unchanged: their `to_date` remains the UTC day.

Everything after the row pass (ordering, a chart's latest points, a top N
by a measure, paging, windows, totals, remembered results) works on the
buckets: a bucketed query costs what the same rows cost with the dimension
already stored as dates, plus the one operation per kept value. Tests
compare the two stage by stage.

A value is checked with the tables' own validator before it is bucketed, so
bucketing accepts exactly the dates and timestamps a table can hold.

### 4. Clients

A widget's result names its dimensions with the types the rows carry: a
bucketed timestamp is reported as `date` in the widget's `metadata`. The web
app and the Apple TV app format a dimension by that type, so they show
"Nov 2, 2026" / "02.11.2026" without a change, and current TV builds need no
update. The device payload's shape is unchanged.

A bucket can be an early day (a source's zero time gives `0001-01-01`).
Both clients word years 1 to 99 with the year they are ("Jan 1, 1"); the
year 0, which has no wording of its own, is shown as stored. The Apple TV
app also shows 5 to 14 October 1582 as stored: Foundation's Gregorian
calendar has no such days.

## Out of scope

Hour, quarter and year grains; fiscal calendars; a time zone per widget;
grains in filters; bucket labels such as "CW 45" or "November 2026" (a
bucket reads as its first day); changes to preparations.
