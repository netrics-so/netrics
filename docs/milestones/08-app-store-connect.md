# Milestone 08 — App Store Connect connector

## Outcome

A workspace can securely connect an App Store Connect account, select apps, and
display download and store-performance metrics.

## Dependencies

- Milestones 03–05

## Architectural purpose

This milestone proves uploaded private-key credentials and provider-specific JWT
signing while preserving the common connector lifecycle.

## In scope

- App Store Connect marketplace metadata and setup guide
- Team and individual API-key credential forms
- One-time private-key upload and encrypted storage
- Key ID, issuer ID, and role validation
- Short-lived JWT generation
- App discovery and selection
- Available downloads, sales, and analytics metrics supported by the official
  API
- Provider report retrieval, decompression, parsing, and normalization
- Currency, territory, product, and app dimensions where available
- Report-availability and delay states
- Sanitized report fixtures and parser tests

## Out of scope

- App management or write operations
- In-app purchase server notifications
- Financial reconciliation
- Provisioning-profile APIs

## Implementation slices

1. Define the signed-key credential strategy in the SDK.
2. Implement secure private-key upload, parsing, encryption, and redaction.
3. Generate minimal-scope short-lived JWTs.
4. Discover accessible apps and validate roles.
5. Fetch and parse the selected official reports.
6. Normalize metrics, units, currencies, dates, and dimensions.
7. Add backfill, report-delay, and provider-error behavior.
8. Add onboarding guidance for team and individual keys.

## Security invariants

- Private keys are never downloadable after submission.
- Key material never appears in logs, job payloads, or error details.
- Signed JWTs have the shortest practical lifetime.
- Connector execution receives only the selected connection's credential.
- Removing a connection erases its encrypted key material according to policy.

## Verification

- Malformed and mismatched keys fail before persistence.
- A key without required access receives an actionable least-privilege message.
- Parser fixtures cover changed columns, missing reports, and locale-independent
  numbers.
- Duplicate reports do not duplicate observations.
- Several App Store Connect teams can coexist in one workspace.

## Exit gate

Upload a real key, select an app, backfill available metrics, display them on a
dashboard, rotate the key, and verify the old key material is no longer usable.
