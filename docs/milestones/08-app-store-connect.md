# Milestone 08 — App Store Connect connector

## Outcome

A workspace can securely connect an App Store Connect team, select apps, and
display downloads, proceeds and store-reach metrics on dashboards and TVs.

## Dependencies

- Milestones 03–05 and 07 (shared connection lifecycle and `auth_failed`
  handling)

## Architectural purpose

This milestone proves that a connector can authenticate with an uploaded
private key: the host signs short-lived tokens for each call, and the
connector never sees the key. Apple Ads (milestone 10) reuses this. The
design is in
[ADR 0014](../decisions/0014-app-store-connect-signed-keys.md).

App Store Connect has no OAuth or delegated access. The only way in is a
**team API key** (issuer ID, key ID and a `.p8` private key), which an
Account Holder or Admin creates. netrics makes that path as guided as it
can, with step-by-step copy, deep links, role guidance and immediate
validation. The flow is the same on the hosted service and self-hosted,
with no instance configuration.

## In scope

- Marketplace entry and guided setup. Deep links go to Users and Access →
  Integrations → App Store Connect API and to Payments and Financial
  Reports (for the vendor number). The role guidance recommends **Sales**
  (or Finance) and advises against Admin.
- Team keys only. Individual keys cannot read Sales and Trends.
- A one-time key upload: issuer ID, key ID and a `.p8` file or paste.
- The key is validated before it is stored:
  - its format (PKCS#8, EC P-256);
  - the signature, against `GET /v1/apps`;
  - the role and vendor number, with a sales-report probe.
- Storage in the existing AES-GCM credential envelope. The key is never
  shown, downloaded or logged again.
- Host-side ES256 JWT signing with `node:crypto`: a 10-minute lifetime and
  a fresh token per connector call.
- App discovery and selection. Apps are the connection's resources, keyed
  by Apple ID.
- Sales and Trends (daily summary sales report, a gzip tab-separated file):
  - first downloads, redownloads, updates, in-app purchase units, and
    proceeds per currency of proceeds;
  - downloads broken down by territory (top 10 per month, plus "Others")
    and by device.
- Analytics Reports API: impressions, product page views and downloads by
  source. It is enabled once with a temporary Admin key that is not
  stored; after that the Sales key reads the reports.
- The `currency_minor` unit convention (amounts whose currency is a
  dimension), with currency-aware tiles.
- Pacific-Time reporting days, stamped as reported (ADR 0008).
- A 365-day sales backfill, with incremental syncs re-reading 3 days.
- Report availability: the two meanings of a 404 (a day without sales, or
  a report not yet published), and latency copy in the UI.
- Key rotation, and an actionable `auth_failed` state for revoked keys or
  missing roles.
- SDK 0.2.2: the `signed-key` strategy and binary response bodies.
- Sanitized report fixtures and offline parser and contract tests.

## Out of scope

- App management or any write operation, except creating analytics report
  requests during the explicit enablement step
- Ratings and reviews in the first scope: they come later from an optional
  second key with the Customer Support role (#190, optional stretch; ADR 0014)
- Subscription and financial reports, and financial reconciliation
- Currency conversion (an opt-in display currency with ECB reference rates
  is a follow-up, #191)
- Analytics backfill through one-time snapshots, and sessions and crash
  reports
- In-app purchase server notifications and provisioning APIs

## Implementation slices

Tracked in the GitHub milestone "08 App Store Connect":

1. SDK 0.2.2: the `signed-key` strategy and binary response bodies (#177).
2. Host signed-key credentials: validation, storage, JWT signing and
   rotation (#170). Depends on #177.
3. Connector: app discovery and the key, role and vendor check (#171).
   Depends on #170.
4. Sales and Trends sync: downloads, units and proceeds (#172). Depends on
   #171 and #173.
5. Per-currency amounts, the `currency_minor` unit (#173). Independent;
   it can start at once.
6. Analytics Reports with one-time Admin enablement (#174). Depends on
   #172.
7. Connect wizard, rotation and revocation states, and connector docs
   (#175). Depends on #170 and #171.
8. Exit gate, hosted and self-hosted (#176). Depends on #172–#175.
9. Optional stretch, not part of the exit gate: ratings and reviews with a
   second key (#190). Depends on #171.

```text
#177 ─ #170 ─ #171 ─┬─ #172 ─ #174 ─┐
                    └─ #175 ────────┤
#173 ──── (#172) ───────────────────┴─ #176
```

## Security invariants

- The private key is never returned, downloaded or shown after submission.
- Key material and signed JWTs never appear in logs, job payloads, error
  details, audit events or API responses. Presigned report URLs are
  redacted too.
- Connector code receives only a short-lived JWT, never the key.
- JWTs live 10 minutes or less (Apple's ceiling is 20) and are minted for
  each call.
- The stored key needs only the Sales (or Finance) role. An Admin key is
  used once, in memory, to enable analytics, and is never persisted.
- Removing a connection erases its envelope, and the UI points to the key's
  revocation in App Store Connect.

## Verification

- Malformed, mismatched and wrong-role keys fail before persistence, with
  actionable least-privilege messages.
- Parser fixtures cover reordered, extra and missing columns, refunds,
  unknown product types, several currencies, locale-independent numbers and
  missing reports.
- Replaying a report does not duplicate observations, and revised days
  update them.
- Several App Store Connect teams can coexist in one workspace.
- The connector reaches only its declared hosts.

## Exit gate

Run this with a real App Store Connect team that has several iOS apps,
hosted and self-hosted:

1. Create a Sales-role team key with the wizard and connect it with the
   vendor number.
2. Select the apps and backfill a year of sales.
3. Enable analytics with a temporary Admin key, then revoke that key.
4. Show downloads, proceeds, impressions and product page views on a
   dashboard and on a TV.
5. Rotate the key and revoke the old one. Syncs continue.
6. Revoke the active key. The connection shows an actionable "upload a new
   key" state and recovers after a new upload.
