# Milestone 07 — Google Search Console connector

## Outcome

A user can authorize Google through a standard OAuth flow, select a Search
Console property, and display search-performance metrics.

## Dependencies

- Milestones 03–05

## Architectural purpose

This milestone creates the reusable OAuth authorization-code platform used by
future connectors. Google Search Console is its first production consumer. The
design is recorded in
[ADR 0012](../decisions/0012-oauth-authorization-code-platform.md).

On the hosted service users connect through netrics' own Google OAuth app in
a few clicks and never register an app themselves. A self-hosted
administrator registers a Google OAuth app for the instance and sets
`NETRICS_OAUTH_GOOGLE_CLIENT_ID` and `NETRICS_OAUTH_GOOGLE_CLIENT_SECRET`; the
callback is `<app origin>/oauth/google/callback`. Without them the connector is
shown as unavailable, with setup instructions.

## In scope

- Instance-level OAuth application configuration from the environment
- Hosted managed credentials and self-hosted administrator credentials
- Authorization state, PKCE, callback validation, and account linking
- Encrypted refresh-token storage and serialized refresh
- Revocation, reauthorization, and scope-upgrade handling
- Search Console site discovery
- Clicks, impressions, CTR, and position metrics
- Date, page, query, country, and device dimensions with cardinality controls:
  at most 2 dimensions besides date, at most 5,000 rows per day per query
- Backfill of 16 months (Search Console's retention)
- Connection health for expired or revoked grants (including the 7-day
  refresh-token limit while the hosted Google app is in testing) and a
  reauthorization flow
- Search Console data-latency explanation in the UI
- OAuth and connector fixture tests

## Out of scope

- Google Analytics
- Google Ads
- Search Console write operations
- A general OAuth-provider marketplace

## Implementation slices

Tracked in the GitHub milestone "07 Google Search Console":

1. OAuth platform: provider definitions, instance config and records (#131).
2. Authorization flow: start, web callback, validation, reauthorization
   (#132).
3. Token service: serialized refresh, reauthorization state, revocation
   (#133).
4. Search Console connector: properties, search analytics, limits (#134).
5. Self-hosted Google OAuth app: configuration and setup guide (#135).
6. Connect, finish setup, reconnect and disconnect UX (#136).
7. Exit gate in hosted and self-hosted configurations (#137).

Publishing the hosted Google OAuth app (netrics.so homepage and privacy
policy, verified domain) is tracked in #138. It does not block the exit gate,
which can run while the app is in testing.

## Security invariants

- OAuth state binds user, workspace, connector, redirect target, and nonce.
- Redirect URLs come from an allowlist.
- Refresh tokens never reach the browser or logs.
- Token refresh is serialized per connection.
- Requested scopes use Search Console read-only access, plus `openid` and
  the account email to show which Google account is linked.
- Tokens are exchanged by the API; they never reach the browser.
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
