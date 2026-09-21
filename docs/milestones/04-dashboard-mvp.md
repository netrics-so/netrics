# Milestone 04 — Dashboard MVP

## Outcome

A user can build and view a useful browser dashboard from demo metrics without
editing code.

## Dependencies

- Milestone 03

## In scope

- Dashboard and widget persistence
- Workspace and optional project ownership
- Metric query service with time windows and aggregation
- Big-number, trend, and line-chart widgets
- Dashboard grid editing and widget configuration
- Auto-refresh and stale-data indication
- TV-sized responsive layout mode
- Empty, loading, error, and partial-data states
- Dashboard duplication and deletion
- Onboarding dashboard populated by the demo connector
- Query limits and server-side validation

## Out of scope

- Public sharing and embeds
- Apple TV pairing and snapshots
- Derived metric expressions
- Additional chart types
- Cross-project permission restrictions

## Implementation slices

1. Define dashboard, layout, widget, and metric-query contracts.
2. Implement aggregation queries with unit and time-zone metadata.
3. Build read-only dashboard rendering.
4. Add the three initial widgets and consistent formatting.
5. Add grid editing, widget creation, and configuration.
6. Add refresh, staleness, empty states, and failure behavior.
7. Generate an onboarding dashboard from demo data.
8. Add browser-level tests for creation, editing, and viewing.

## UX requirements

- The first useful dashboard requires no manual query language.
- Widget configuration offers compatible metrics and aggregations only.
- Large-screen layouts remain readable from a distance.
- A failed widget does not blank the entire dashboard.
- Stale data is visible without overwhelming the display.

## Verification

- Queries remain tenant-scoped and enforce bounded time ranges.
- Layout is usable on laptop, desktop, 1080p TV, and 4K TV viewports.
- Empty and partially synchronized connections produce clear guidance.
- Dashboard changes survive reload and concurrent stale updates are rejected.
- The onboarding path reaches a populated dashboard from a new workspace.

## Exit gate

Starting with a new workspace, enable demo data, create and edit a dashboard,
display it full-screen at TV resolution, and demonstrate refresh plus a
connection-failure state.
