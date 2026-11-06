# Milestone 05 — Vercel Web Analytics connector

## Outcome

A customer can select Vercel from the marketplace, connect a real project, and
display its visitor and page-view metrics on a dashboard.

## Dependencies

- Milestones 03–04

## Why this connector comes first

Vercel provides a relatively direct token-authenticated analytics API. It proves
the complete external-connection experience before introducing reusable OAuth
or Apple-specific signed credentials.

## In scope

- Vercel marketplace metadata and documentation
- Bearer-token credential schema and encrypted storage
- Team and project discovery
- Web Analytics visits and custom-event metric definitions
- Supported dimensions and bounded aggregation queries
- Historical backfill and incremental synchronization
- Pagination, rate-limit handling, and exponential backoff
- Fixture-based contract tests
- Connection wizard resource and metric selection
- Health messages for permissions, unavailable analytics, and quota failures

## Out of scope

- Vercel deployment or infrastructure metrics unrelated to Web Analytics
- Raw analytics drains
- Generic user OAuth
- Custom-event schema editing

## Implementation slices

1. Capture sanitized provider fixtures and define expected metrics.
2. Implement credential checking and team/project discovery.
3. Implement bounded report fetching and pagination.
4. Normalize values, timestamps, and dimensions.
5. Add backfill, cursor behavior, rate limits, and retry classification.
6. Build the Vercel-specific connection wizard content.
7. Add end-to-end dashboard and provider-failure tests.
8. Publish operator setup and least-privilege guidance.

## Verification

- A token with insufficient access produces an actionable error.
- Several Vercel connections can coexist in one workspace.
- Repeated backfills remain idempotent.
- API fixture changes fail contract tests clearly.
- Unsupported or high-cardinality queries are bounded before provider calls.

## Exit gate

Connect a real Vercel project in the hosted sandbox, backfill analytics, display
visitors and page views on a dashboard, revoke the token, and observe the
connection enter a recoverable authentication state.

## Decisions

- **Tokens, not OAuth.** Vercel's OAuth integrations have no Web Analytics
  scope: a test integration could list projects but got 404 "Web Analytics
  not found" for a project a personal token reads. Users create a token
  scoped to one project or team ([setup guide](../connectors/vercel.md)).
  Generic OAuth stays in the connector framework's backlog for providers
  that support it.
- **Monthly pages, monthly top 10.** Vercel ranks routes, countries and
  events over the queried range, so every query spans a whole calendar
  month (up to today) and only the requested days are kept. A day's values
  are the same whichever sync asks for them. While a month is open, a route
  that falls out of the top 10 keeps its earlier values.
- **Backfill.** Up to 366 days (the Pro plan), clamped to a shorter plan
  window when Vercel reports one. Incremental syncs re-read yesterday and
  today.
- **Credential failures.** A rejected token, a missing project or disabled
  Web Analytics fail the connection check (`auth_failed`, syncing paused
  until a new token is saved). Rate limits and outages are retried.

Exit gate passed on the hosted service on 2026-09-28 (#53).
