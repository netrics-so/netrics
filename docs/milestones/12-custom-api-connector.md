# Milestone 12 — Custom API connector

## Outcome

A user can turn a suitable JSON HTTP API into a private, scheduled metric source
through the UI without executing custom code.

## Dependencies

- Milestones 03–04 and 11

## In scope

- Declarative custom-connector schema
- GET endpoint, headers, query parameters, and safe authentication
- Pagination strategies required by common APIs
- JSON record selection and field mapping
- Timestamp, value, unit, and dimension configuration
- Restricted transformation expressions
- Refresh interval, lookback, and backfill settings
- Test request with redacted response preview
- Private definition versioning, import, and export
- Optional submission into the community review process
- Hosted SSRF, DNS-rebinding, redirect, decompression, and size protections

## Out of scope

- Arbitrary JavaScript or template evaluation
- POST, PUT, PATCH, or DELETE requests
- Browser automation and HTML scraping
- User-defined network proxies
- Access to private SaaS networks

## Implementation slices

1. Define the portable declarative schema and its versioning.
2. Implement the hardened outbound HTTP client.
3. Add supported authentication and pagination strategies.
4. Implement JSON extraction and restricted transformations.
5. Build request testing and redacted response preview.
6. Build metric mapping, validation, and schedule setup.
7. Add import, export, revision history, and rollback.
8. Connect publication submissions to the community review process.

## Security invariants

- Every DNS resolution and redirect target is validated.
- Loopback, private, link-local, and metadata-service ranges are blocked.
- Response bytes, decompressed bytes, redirects, duration, and record count are
  bounded.
- Exported definitions never contain credentials.
- Expressions cannot access filesystem, network, process, or runtime globals.

## Verification

- Tests cover IPv4, IPv6, encoded addresses, DNS rebinding, redirects, and
  decompression bombs.
- Credential values are redacted from previews, logs, exports, and errors.
- Pagination stops at configured safety limits.
- Schema upgrades preserve existing definitions.
- A submitted definition can be reviewed without access to tenant credentials.

## Exit gate

Configure a real public JSON API, preview and map its response, backfill and
display a metric, export and re-import the definition, then demonstrate the
SSRF test suite rejecting protected destinations.
