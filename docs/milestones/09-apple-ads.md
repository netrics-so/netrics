# Milestone 09 — Apple Ads connector

## Outcome

A workspace can connect one or more Apple Ads organizations and display campaign
spend and performance alongside product and website metrics.

## Dependencies

- Milestones 03–05 and 08

## Architectural purpose

This milestone proves OAuth client credentials with a signed client secret,
organization context, reporting time zones, and currency-aware advertising
metrics.

## In scope

- Apple Ads marketplace metadata and setup guide
- Public/private key credential setup
- Signed client-secret generation and access-token exchange
- Organization ACL discovery and selection
- Campaign, ad-group, keyword, and search-term report metrics supported by the
  initial product scope
- Spend, impressions, taps, installs, conversion, and cost metrics
- Currency and reporting time-zone preservation
- Pagination, throttling, retry, and quota visibility
- Historical report backfill
- Fixtures for organization and report variants

## Out of scope

- Creating or modifying campaigns
- Bid and budget automation
- Recommendations and write APIs
- Cross-currency conversion

## Implementation slices

1. Extend the signed credential strategy for Apple Ads token exchange.
2. Implement credential check and organization discovery.
3. Define metric semantics, units, and reporting dimensions.
4. Implement bounded report queries and pagination.
5. Normalize time zones, currencies, attribution windows, and identifiers.
6. Add rate-limit and provider-error behavior.
7. Add wizard guidance and multi-organization support.
8. Add end-to-end cross-source dashboard tests.

## Verification

- Concurrent jobs reuse or serialize short-lived token acquisition safely.
- Organization context cannot be confused between connections.
- Currency is always explicit and incompatible currencies are not summed.
- Reporting time zones survive storage and dashboard aggregation.
- Attribution-window differences remain visible in metric definitions.

## Exit gate

Connect a real Apple Ads organization, backfill campaign performance, display
spend and installs beside App Store and Vercel metrics, and demonstrate correct
currency and time-zone labels.
