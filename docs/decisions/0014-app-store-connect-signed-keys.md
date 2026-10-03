# 0014 — App Store Connect: signed-key credentials and report sources

Status: accepted (2026-10-03, milestone 08)

## Context

App Store Connect (milestone 08) is the first connector whose credential is a
private key the user uploads. netrics signs short-lived tokens with it. Apple
Ads (milestone 09) signs its client secret with a private key in the same
way, so whatever we build here gets used again.

Product rules:

- On the hosted service every integration should take a few clicks, and the
  user should never have to register an app at the provider. Where the
  provider offers no delegated authorization, the key path is as guided as
  we can make it (ADR 0012, "Where a provider has no OAuth").
- Self-hosted and hosted work the same way: the user brings their own key,
  and there is no instance-level provider app to configure.
- Secrets never appear in logs, errors, API responses or job payloads.
  Credentials are AES-GCM envelopes bound to their connection.

### What Apple offers (checked 2026-10-03)

- **No OAuth or delegated flow.** The App Store Connect API is authorized
  only by API keys and JWTs signed with them. Apple's own guidance for
  third-party reporting tools is that the customer creates a team key with a
  reporting role and hands it over
  ([Creating API keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api),
  [Downloading Analytics Reports](https://developer.apple.com/documentation/appstoreconnectapi/downloading-analytics-reports)).
  We found no announcement of a third-party authorization flow. Re-check
  this before milestone 16.
- **Keys.** There are two kinds:
  - _Team keys_ cover every app of the team and carry the role chosen at
    creation.
  - _Individual keys_ carry the access of the user who owns them. They
    "aren't able to use Provisioning endpoints, access Sales and Finance, or
    notaryTool"
    ([Creating API keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)),
    so they cannot read sales reports.

  Only the Account Holder or an Admin can generate team keys. The Account
  Holder must first request API access once. A key's role cannot be edited:
  to change it, revoke the key and create a new one. Apple keeps no copy of
  the private key, so the `.p8` file downloads only once
  ([App Store Connect API overview](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)).
  The keys live under Users and Access → Integrations → App Store Connect
  API (`https://appstoreconnect.apple.com/access/integrations/api`). The
  issuer ID is shown above the key list and the key ID in each row.
  Revocation is permanent
  ([Revoking API keys](https://developer.apple.com/documentation/appstoreconnectapi/revoking-api-keys)).

- **Tokens** are ES256 JWTs:
  - header `alg: ES256`, `kid: <key id>`, `typ: JWT`;
  - claims `iss` (issuer ID), `iat`, `exp`, `aud: "appstoreconnect-v1"` and
    an optional `scope`.

  A token living longer than 20 minutes (`exp − iat`) is rejected, except
  scoped GET-only tokens for a few resources that do not include reports
  ([Generating tokens](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests)).

- **Roles that matter** ([Role permissions](https://developer.apple.com/support/roles/),
  [Analytics Reports API](https://developer.apple.com/help/app-store-connect-analytics/overview/analytics-reports-api)):

  | Need                                                       | Roles                                                                                |
  | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
  | Sales and Trends reports (`/v1/salesReports`)              | Sales ("Sales and Reports"), Finance, Admin, Account Holder                          |
  | Read analytics reports that were already requested         | Sales, Finance, Admin                                                                |
  | Request an analytics report for the first time (POST)      | **Admin** only                                                                       |
  | Read ratings and reviews (`/v1/apps/{id}/customerReviews`) | Customer Support, Developer, Marketing, App Manager, Admin; **not** Sales or Finance |

- **Rate limit.** About 3,500 requests per key per rolling hour, reported in
  `X-Rate-Limit: user-hour-lim:…;user-hour-rem:…;`. Above it Apple answers
  429 `RATE_LIMIT_EXCEEDED`
  ([Identifying rate limits](https://developer.apple.com/documentation/appstoreconnectapi/identifying-rate-limits)).

## Decision

### Credential: one team key, uploaded once, signed by the host

**A new, additive auth strategy, `signed-key`.** A connector declares
`{ strategy: "signed-key", provider: "app-store-connect" }`. As with OAuth
providers (ADR 0012), a _signed-key provider_ is trusted host code in
`apps/server/src/signed-keys/providers/`. It defines:

- the credential fields and how to validate them;
- the JWT header and claims (`aud`, lifetime);
- the hosts the validation may reach;
- the wizard's setup copy and deep links.

The connector never sees the private key. Before each check, discovery or
sync call, the host signs a fresh JWT and hands the connector
`credentials: { accessToken }`, the same shape as OAuth. Community connectors
(milestone 11) may name a provider but never define one. `SDK_VERSION`
becomes 0.2.2, and `^0.2.0` connectors keep loading. Apple Ads (milestone 09) adds a provider that signs a client-secret JWT and exchanges it for an
access token; no new strategy is needed.

**Fields.** The form has three fields:

- **Issuer ID**: a UUID.
- **Key ID**: 10 uppercase alphanumerics.
- **Private key**: the `.p8` file, chosen with a file picker or pasted.
  At most 4 KiB, PEM `PRIVATE KEY` (PKCS#8). It must parse with
  `crypto.createPrivateKey` as an EC key on P-256.

The vendor number is not a secret; it lives in the connection config (see
below). Only team keys are accepted. Individual keys cannot read sales
reports. A JWT with `sub: "user"` would also need a different claim set, and
Apple ties an individual key to one person who may leave the team.

**Validation before anything is stored.** Preview and create fail before
persistence, with a specific message, when:

1. the fields are malformed: not a UUID, a wrong key-ID shape, not PKCS#8,
   or not P-256 (an RSA key or a certificate gets a message that names
   what was pasted);
2. `GET /v1/apps?limit=1` answers 401. Apple does not say which part is
   wrong, so the message is "issuer ID, key ID and private key do not belong
   together, or the key was revoked";
3. `GET /v1/salesReports` for the latest available day of the configured
   vendor number answers 403 or a vendor error. The message names the
   missing role ("This key needs the Sales or Finance role. Admin also
   works, but grants more than netrics needs") or says that the vendor
   number is wrong. A 404 for "no sales that day" counts as success.

**Storage.** `{ issuerId, keyId, privateKey }` is stored as JSON in the
existing envelope (`connections.credentials_encrypted`, AES-256-GCM, bound
to workspace and connection). There is no new table. No API response ever
contains it: the contracts already keep credentials input-only. The upload
body is size-limited and never logged. The redaction pass (key names
matching `key`, plus value redaction of every credential string) covers
`privateKey`, the PEM body and signed JWTs. Tests assert that a key in a
failing request does not appear in the log output or the error.

**Signing.** Signing uses Node's `crypto` only: `createPrivateKey` on the
PEM, then `crypto.sign("sha256", …, { dsaEncoding: "ieee-p1363" })` to get
the raw `r‖s` signature that JOSE ES256 requires
([Node crypto.sign](https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback),
RFC 7518 §3.4). No new dependency is added. The token lives 10 minutes:
`iat` is now − 60 s to tolerate clock skew and `exp` is now + 9 min, so
`exp − iat` stays under Apple's 20-minute ceiling. Each connector call
(60 s budget) gets its own token. Tokens are not cached across calls and
never enter job payloads. We do not use the `scope` claim: it must list
exact request strings, including `filter[reportDate]`, which changes every
day.

**Rotation and revocation.**

- _Rotating_ means uploading a new key to the existing connection with the
  existing credential update (`PATCH …/connections/:id` with `credentials`).
  The new key is validated as above before it replaces the envelope; the old
  envelope is overwritten in the same statement. The event is audited as
  `connection.credentials_updated` without key material. The wizard then
  tells the user to revoke the old key in App Store Connect. netrics cannot
  revoke it, because Apple has no API for that.
- A _revoked or deleted key_ answers 401 on every call. A 401 from a
  freshly signed token puts the connection in `auth_failed` with the
  reason "key revoked or invalid". The UI shows "Upload a new App Store
  Connect key", which opens the same form. A 403 after a working key (the
  role was lowered, or access was removed) is also `auth_failed`, with the
  role message. The scheduler skips `auth_failed` connections as it does
  today.
- _Disconnecting_ deletes the envelope with the connection. The UI links to
  the keys page and suggests revoking the key there.

### Data sources and first scope

| Source                                                     | First scope (milestone 08)        | Later                        |
| ---------------------------------------------------------- | --------------------------------- | ---------------------------- |
| (a) Sales and Trends, `GET /v1/salesReports` SALES/SUMMARY | Yes: downloads, units, proceeds   | Subscription reports         |
| (b) Analytics Reports API                                  | Yes, behind a one-time Admin step | Sessions, crashes, retention |
| (c) Customer reviews and ratings                           | Optional stretch (#190)           | Second key, see (c) below    |

**(a) Sales and Trends** works with the least-privilege Sales key and
backfills a year, so it is the core.

- **Request.** One call per reporting day:
  `GET /v1/salesReports?filter[frequency]=DAILY&filter[reportType]=SALES&filter[reportSubType]=SUMMARY&filter[vendorNumber]=…&filter[reportDate]=YYYY-MM-DD&filter[version]=…`.
  The version is pinned in the connector. Apple's API reference lists
  `1_0` and the reporting help lists `1_3`; #172 settles it against a
  real account and pins it.
- **Response.** A gzip file (`application/a-gzip`) of tab-separated rows
  ([salesReports](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-salesreports),
  [Summary Sales report](https://developer.apple.com/help/app-store-connect/reference/reporting/summary-sales-report)).
  One report covers every app of the vendor, so a day costs one request
  however many apps are selected.
- **Parsing.** Columns are matched by header name, never by position. The
  parser fails when a required column is missing and ignores new columns.
  Numbers are parsed locale-independently. Units can be negative (refunds).
- **Product types** come from
  [Product type identifiers](https://developer.apple.com/help/app-store-connect/reference/product-type-identifiers),
  and an unknown identifier is counted in no metric and logged by code:

  | Metric           | Product types                                            |
  | ---------------- | -------------------------------------------------------- |
  | first downloads  | `1`, `1-B`, `F1-B`, `1E`, `1EP`, `1EU`, `1F`, `1T`, `F1` |
  | redownloads      | `3`, `3F`                                                |
  | updates          | `7`, `7F`, `7T`, `F7`                                    |
  | in-app purchases | `IA1`, `IA1-M`, `FI1`, `IA9`, `IA9-M`, `IAY`, `IAY-M`    |

  Restorations (`IA3`) are not counted.

- **Proceeds** are Units × Developer Proceeds per row, summed per app and
  _currency of proceeds_. Several currencies are normal (see "Currency").
- **Availability.** Daily reports are "generally available by 8 a.m.
  Pacific Time" the next day, and daily reports are kept for one year
  ([Sales and Trends availability](https://developer.apple.com/help/app-store-connect/reference/reporting/sales-and-trends-reports-availability)).
- **Vendor number.** Required. It is a config field, shown in Payments and
  Financial Reports under the legal entity name. A team can have more than
  one, for example after a legal-name change; one connection reads one
  vendor number. No API lists vendor numbers, so the wizard explains where
  to find it, and the validation probe confirms it.

**(b) Analytics Reports API** gives store reach: impressions, product page
views and downloads by source. Reading it works with the Sales key, but each
report type has to be requested once with an Admin key. The chain is
request (`accessType: ONGOING`) → reports → instances (daily) → segments
(gzip, tab-separated). The first data arrives 1–2 days after the request,
and a day is complete about 2 days later. An ONGOING request that nobody
reads for a long time stops (`stoppedDueToInactivity`) and has to be made
again
([Downloading Analytics Reports](https://developer.apple.com/documentation/appstoreconnectapi/downloading-analytics-reports)).

The trade-off is between storing an Admin key, which can change apps,
users and pricing, and asking for a second key. We decide:

- netrics never stores an Admin key. "Enable App Store analytics" is a
  separate, optional wizard step. The user uploads a temporary Admin team
  key, which is used in memory for one request. Per selected app, netrics
  lists the existing requests (`GET /v1/apps/{id}/analyticsReportRequests`)
  and creates an ONGOING one only if none exists. A 409 means another tool
  already requested it, and that request is reused. The key is then
  discarded: it is not persisted, enqueued or logged. The step is audited,
  and the UI tells the user to revoke the temporary key.
- If a request already exists (created by another tool or by hand), nothing
  needs Admin rights and the step is skipped.
- Sync reads the instances with the connection's Sales key. A request that
  stopped or disappeared shows "App Store analytics paused — enable again",
  while sales metrics keep syncing.
- First reports used: "App Store Discovery and Engagement" (standard) for
  impressions and product page views, and "App Downloads" (standard) for
  downloads by source. Exact report names and columns are confirmed with a
  real account in #174 and recorded in the fixtures.
- History: ONGOING data starts at the request. A ONE_TIME_SNAPSHOT
  backfill is later, because forum reports say it is limited to about once
  per 31 days and its depth varies
  ([forum](https://developer.apple.com/forums/thread/759773)).

**(c) Ratings and reviews come from the official API with a second,
optional key.** They are not in the first milestone 08 scope or its exit
gate; #190 tracks them as an optional stretch. Sales never require this key.

- **Role.** "View ratings and reviews" is granted to Account Holder, Admin,
  App Manager, Developer, Marketing and Customer Support, and not to Sales
  or Finance; key roles are the same as user roles
  ([Role permissions](https://developer.apple.com/support/roles/),
  [Creating API keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api),
  checked 2026-10-03). No role reads reviews read-only. **Customer
  Support** grants the fewest other permissions (it can also edit App Store
  details and respond to reviews), so the wizard recommends it. Developer
  and Marketing also work but grant much more (builds, certificates, in-app
  purchases, pricing visibility).
- **Credential.** An optional second signed-key credential on the same
  `app-store-connect` connection, not a second connection. The envelope
  JSON gains an optional `reviews: { keyId, privateKey }` member; the issuer
  ID is team-wide and shared. Same envelope, field validation and redaction
  as the main key, and no new table.
- **Probe.** Before it is stored, the reviews key must answer
  `GET /v1/apps/{id}/customerReviews?limit=1` for a selected app. 401 and
  403 get the same kind of specific messages as the main key, naming the
  Customer Support role.
- **Signing.** The host signs a separate short-lived token for the reviews
  key and passes it as an additive credential field (for example
  `reviewsAccessToken`). The connector sees neither private key.
- **Failure isolation.** A revoked or under-privileged reviews key pauses
  only the review metrics ("App Store reviews paused — upload a new
  reviews key"). The connection does not become `auth_failed`.
- **Data.** Review counts and the sum of star ratings per app and day; the
  average is derived (milestone 10) or computed by the tile. Review text
  and nicknames are not stored. The API has no aggregate store rating, so
  the UI does not present these numbers as the App Store's star rating.

### Metrics, identity and dimensions

One connection holds one key and one vendor number. The apps are its
resources, as projects are for Vercel:

- **Discovery.** `GET /v1/apps`, paginated, with `fields[apps]=name,bundleId,sku`.
  The platform comes from `filter[appStoreVersions.platform]` and is shown
  only as a label.
- **Identity.** The resource id is the numeric Apple ID, which is also the
  sales report's `Apple Identifier`. The user selects one or more apps.
- **Breakdowns.** Every series carries the `resource` dimension. Breakdowns
  add `territory` (ISO 3166-1 alpha-2 `Country Code`) or `device` (the
  report's `Device`: iPhone, iPad, Desktop, Apple TV, Apple Vision, …).
  - Territory keeps the 10 largest territories per app and calendar month,
    and groups the rest as "Others" (Vercel's rule), so a series count
    stays bounded at about 11 per metric and app.
  - Device has fewer than 10 values and is kept whole.

| Metric key                                 | Unit             | Dimensions          | Source |
| ------------------------------------------ | ---------------- | ------------------- | ------ |
| `app_store_connect.downloads`              | `downloads`      | resource            | (a)    |
| `app_store_connect.downloads_by_territory` | `downloads`      | resource, territory | (a)    |
| `app_store_connect.downloads_by_device`    | `downloads`      | resource, device    | (a)    |
| `app_store_connect.redownloads`            | `downloads`      | resource            | (a)    |
| `app_store_connect.updates`                | `updates`        | resource            | (a)    |
| `app_store_connect.iap_units`              | `purchases`      | resource            | (a)    |
| `app_store_connect.proceeds`               | `currency_minor` | resource, currency  | (a)    |
| `app_store_connect.impressions`            | `impressions`    | resource            | (b)    |
| `app_store_connect.product_page_views`     | `views`          | resource            | (b)    |
| `app_store_connect.store_downloads`        | `downloads`      | resource, source    | (b)    |

All of them are `delta` metrics at `day` granularity, summed. Conversion
(downloads ÷ product page views) is a derived metric (milestone 10), like
Search Console's weighted CTR. It is not stored as a daily ratio here.

**Currency.** Proceeds stay in their currency of proceeds. There is no FX
conversion; Apple Ads takes the same position (milestone 09). Apple's own
UI converts with "a rolling average of the previous month's exchange
rates", which the API does not provide
([Sales and Trends metrics](https://developer.apple.com/help/app-store-connect/reference/reporting/sales-and-trends-metrics-and-dimensions)).
A manifest's unit is static, so this needs one additive convention: unit
`currency_minor` means integer minor units, with the ISO 4217 code in the
observation's `currency` dimension. ADR 0008's `<ISO>_minor` stays for
single-currency metrics. The query service refuses to aggregate a
`currency_minor` metric across currencies: a tile picks one currency, and
the default is the one with the largest proceeds. Minor units follow ISO
4217 exponents (JPY has 0). Apple Ads reuses the convention for
organization currencies.

**Display currency (follow-up, #191).** Per currency stays the default and
the exact view. A workspace, or a single tile, may instead show amounts
converted into a chosen display currency:

- Rates are the [ECB euro foreign exchange reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html):
  published around 16:00 CET on TARGET working days, base EUR, 29
  currencies on 2026-10-02, as XML without a key
  (`eurofxref-daily.xml`, `eurofxref-hist.zip`). The ECB publishes them
  "for information purposes only". Its
  [reuse terms](https://www.ecb.europa.eu/services/disclaimer/html/index.en.html)
  allow free use when the ECB is cited as the source and modified data is
  marked as such.
- A host job, not a connector, fetches them on a schedule into a global,
  non-tenant table. Stored observations never change; conversion happens
  at query time with each reporting day's rate, or the last published rate
  before it (weekends, holidays).
- Converted values are labelled approximate and cite the ECB. Currencies
  the ECB does not publish (Apple pays proceeds in some, for example TWD,
  SAR or AED) stay unconverted and are shown separately, never dropped.
- Self-hosters can turn the job and the option off at runtime; then no
  request goes to the ECB.

### Time zones, backfill and latency

- **Reporting days are Pacific Time.** Apple says so for Sales and Trends
  ([Download and view reports](https://developer.apple.com/help/app-store-connect/measure-app-performance/download-and-view-reports)).
  The analytics report dates are taken as given. Following ADR 0008, a
  value for Apple's reporting date D is stamped `D T00:00:00Z`, as Search
  Console does. Neither the workspace time zone nor UTC shifts it. A tile's
  "yesterday" in the workspace zone can therefore be a day Apple has not
  reported yet; the connector docs and tile tooltip explain this.
- **Backfill** covers 365 days of daily sales reports (`backfillDays: 365`,
  Apple's retention), at one request per day, a tenth of the hourly limit.
  Analytics has no backfill in this milestone.
- **Incremental** syncs re-read the last 3 reporting days, so revisions
  upsert per ADR 0008.
- **404 has two meanings.** A day whose report should exist (D + 1 at 12:00
  PT has passed) and answers 404 is a day without sales: nothing is stored,
  and the cursor moves on. A more recent day answering 404 is not yet
  available: the cursor stays before it, and the next sync retries.
- **Latency in the UI.** The connection and the tiles show "App Store sales
  arrive the next morning, Pacific Time; analytics about two days later".
  The last reporting day ingested comes from existing sync state.

### Network, binary bodies and rate limits

- **`outboundDomains`.** It contains `api.appstoreconnect.apple.com` and
  the analytics segment host. Segment URLs are presigned S3 URLs valid for
  5 minutes
  ([segments](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-analyticsreportinstances-_id_-segments)).
  Apple's example host is `…s3.us-west-2.amazonaws.com`, a QA bucket, and
  the production bucket is not documented. #174 records the host from a
  real response and pins the narrowest pattern that matches it: the bucket
  host itself if it is stable, otherwise `*.s3.us-west-2.amazonaws.com`.
  It never pins `*.amazonaws.com`. A segment URL outside the allowlist
  fails that analytics read with a clear error, and sales keep syncing.
  Presigned URLs are bearer credentials and are redacted from errors and
  logs.
- **Binary bodies.** `runtime.fetch` currently decodes every body as UTF-8.
  SDK 0.2.2 adds `ConnectorResponse.bytes(): Uint8Array`, which is additive.
  Connectors decompress with `node:zlib` `gunzipSync` and a
  `maxOutputLength` (64 MiB), so a gzip bomb fails as a provider error.
  Over a future process boundary, the bytes travel as base64.
- **Rate limit.** The manifest hint is
  `{ maxRequests: 3500, windowSeconds: 3600, scope: "key" }`. A 429, or a
  low `user-hour-rem`, throws a retryable error, so the job backs off.
  Several connections that share one key share Apple's budget; the
  connector docs say so.

### Fixtures and tests

Contract tests run offline against sanitized fixtures:

- gzip sales reports for several apps, territories, devices, currencies,
  refunds, unknown product types, reordered and extra columns, a missing
  column, and a 404 day;
- JSON:API pages for apps and analytics;
- `.csv.gz` segments;
- 401, 403, 409 and 429 errors.

App names, Apple IDs, SKUs and vendor numbers are synthetic. No private
key is committed. Tests generate a P-256 key pair at runtime and verify the
JWT header, claims, lifetime and signature with the public key. Egress
tests assert that the connector cannot reach any other host.

## Alternatives considered

- **Connector signs the JWT itself.** That is simpler, but the connector
  would see the private key, which is long-lived and team-wide. The host
  approach matches ADR 0012 (the connector sees only short-lived tokens)
  and is reused by Apple Ads.
- **Accept individual keys.** They cannot read sales reports, and they
  belong to one person.
- **Store an Admin key for analytics.** It would give netrics write access
  to apps, prices and users for a read-only product. A one-time step keeps
  the stored key read-only.
- **Leave analytics out of milestone 08.** It would drop impressions and
  product page views, which need only one Admin step per app.
- **Ratings from the public lookup** (`itunes.apple.com/lookup`,
  `averageUserRating`, `userRatingCount`). Not part of Apple's documented
  API, per storefront, and without a key; rejected in favour of the
  official API.
- **One broader key for sales and reviews** (Admin or App Manager). It
  would make every connection carry write rights to apps; a second,
  optional key keeps the main key at the Sales role.
- **Always convert proceeds to one currency.** The API exposes no rates,
  and Apple's own conversion (a rolling average of the previous month) is
  not available. Conversion is an opt-in display choice with labelled
  approximate values instead (#191).
- **Sales and Trends only.** It misses impressions and product page views,
  the most useful store metrics after downloads.
- **The `scope` claim.** It cannot express daily report requests.

## Consequences

- SDK 0.2.2 adds the `signed-key` strategy and `ConnectorResponse.bytes()`.
  The host gains a signed-key provider registry, a credential form (three
  fields and a file upload) and the `currency_minor` unit convention in
  contracts, query and tiles.
- No new tables. The key lives in the existing envelope; analytics request
  ids are re-discovered from Apple and not stored.
- Hosted and self-hosted are identical: nothing is configured per instance.
- Users must have an Account Holder or Admin create the key. The wizard
  links to the keys page, names the Sales role and explains the vendor
  number. Enabling analytics needs an Admin key once.
- Ratings and reviews (#190, optional second key), display-currency
  conversion (#191), subscription reports, and analytics backfill through a
  snapshot are follow-ups.

## Decision record (owner, 2026-10-03)

1. **Analytics enablement.** Accepted as proposed: a temporary Admin key,
   used in memory once to create the ONGOING report requests, and never
   stored. #174 proceeds.
2. **Ratings.** From the official API with a second, optional key that has
   a review-reading role (Customer Support recommended), stored on the same
   connection with its own probe, never required for sales. Not in the
   first milestone 08 scope: #190, optional stretch in milestone 08.
3. **Currency.** The user chooses per workspace or per tile: amounts per
   currency (default, exact), or converted into a display currency with
   daily ECB reference rates, labelled approximate, and switchable off for
   self-hosters. #191, no milestone yet (milestone 10 lists currency
   exchange as out of scope).
4. **Role names and sales report version.** Confirmed with a real account
   at the exit gate (#176), which records them.

### Open checks for the exit gate (#176)

- The role names shown when creating a key (Sales, Finance, Admin,
  Customer Support) match this ADR and the wizard copy.
- The pinned Sales and Trends report version (currently `1_0`; the
  reporting help also lists `1_3`) returns the expected columns.
