# Milestone 07 — Google Search Console connector

## Outcome

A user can authorize Google through a standard OAuth flow, select a Search
Console property, and display search-performance metrics.

## Dependencies

- Milestones 03–05

## Architectural purpose

This milestone creates the reusable OAuth authorization-code platform used by
future connectors. Google Search Console is its first production consumer.

## In scope

- Instance-level OAuth application configuration
- Hosted managed credentials and self-hosted administrator credentials
- Authorization state, PKCE, callback validation, and account linking
- Encrypted refresh-token storage and serialized refresh
- Revocation, reauthorization, and scope-upgrade handling
- Search Console site discovery
- Clicks, impressions, CTR, and position metrics
- Date, page, query, country, and device dimensions with cardinality controls
- Search Console data-latency explanation in the UI
- OAuth and connector fixture tests

## Out of scope

- Google Analytics
- Google Ads
- Search Console write operations
- A general OAuth-provider marketplace

## Implementation slices

1. Define reusable OAuth provider and connection records.
2. Implement state, PKCE, callback, token refresh, and revocation.
3. Add instance provider settings for self-hosting.
4. Implement Search Console property discovery.
5. Implement bounded search-analytics queries and normalization.
6. Add dimension selection and cardinality limits.
7. Add connection-health and reauthorization UX.
8. Exercise the complete flow in hosted and self-hosted configurations.

## Security invariants

- OAuth state binds user, workspace, connector, redirect target, and nonce.
- Redirect URLs come from an allowlist.
- Refresh tokens never reach the browser or logs.
- Token refresh is serialized per connection.
- Requested scopes use Search Console read-only access.
- Reauthorization cannot attach credentials to a different workspace.

## Verification

- Consent denial and callback replay fail safely.
- Expired access tokens refresh once under concurrent jobs.
- A removed Google permission becomes an actionable connection state.
- Query dimensions and date ranges respect configured limits.
- Self-hosted setup works with a separately registered Google OAuth app.

## Exit gate

Authorize a real Google account, select a property, backfill data, display search
metrics, revoke access at Google, and recover the connection through
reauthorization.
