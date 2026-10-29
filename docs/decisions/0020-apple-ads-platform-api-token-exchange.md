# 0020 — Apple Ads: Platform API, token exchange and ad metrics

Status: accepted (2026-10-29, owner decision; milestone 10, #368). Extends
ADR 0014 (signed-key credentials).

## Context

Milestone 10 connects Apple Ads. ADR 0014 expected Apple Ads to add "a
provider that signs a client-secret JWT and exchanges it for an access
token; no new strategy is needed". This ADR says what that exchange means
for the host, which Apple API we target, how a customer gets a credential
to netrics, and how ad metrics are stored.

Product rules, as in ADR 0012 and ADR 0014:

- On the hosted service every integration takes a few clicks, and the user
  never registers an app at the provider. Where the provider has no open
  delegated authorization, the key path is as guided as we can make it.
- Hosted and self-hosted work the same way.
- Secrets never appear in logs, errors, API responses or job payloads.

### What Apple offers (checked 2026-10-29)

- **Two APIs.** "The Apple Ads Campaign Management API is deprecated and
  will be sunset on January 26, 2027. Use the Apple Ads Platform API
  instead"
  ([Campaign Management API 5](https://developer.apple.com/documentation/apple_ads/apple-search-ads-campaign-management-api-5)).
  The Platform API 1.0 came out in August 2026. Its base URL is
  `https://api.ads.apple.com/v1/`; it has a new account model (org → ad
  accounts → campaigns) and new request and response shapes, and it covers
  App Store ads and Apple Maps ads
  ([Platform API](https://developer.apple.com/documentation/apple-ads-platform-api),
  [changelog](https://developer.apple.com/documentation/Apple-Ads-Platform-API/changelog-apple-ads-platform-api),
  [Calling the API](https://developer.apple.com/documentation/Apple-Ads-Platform-API/calling-apple-ads-platform-api)).
- **Authentication** is an OAuth 2 client-credentials grant whose
  `client_secret` is an ES256 JWT: header `alg ES256`, `kid` key ID; claims
  `iss` team ID, `sub` client ID, `aud https://appleid.apple.com`, `iat`,
  and `exp` at most 180 days after `iat`. The JWT is posted to
  `https://appleid.apple.com/auth/oauth2/token` with
  `grant_type=client_credentials` and `scope=searchadsorg`. The answer is an
  access token valid for one hour (`expires_in: 3600`); there is no refresh
  token
  ([Implementing OAuth](https://developer.apple.com/documentation/Apple-Ads-Platform-API/implementing-oauth-for-the-apple-ads-platform-api)).
- **The user makes the key pair, not Apple.** An API user creates an EC
  P-256 key pair (Apple's guide uses `openssl`), pastes the **public** key
  under Account Settings → API, and gets a client ID and a team ID (both
  `SEARCHADS.<uuid>`) and a key ID. Apple never holds the private key.
- **Access.** `GET /v1/me` returns `{userId, orgId}`; `GET /v1/acls` returns
  one entry per ad account with `{adAccount{id,name,orgId}, roles[]}`. Roles
  include `API Account Read Only` and `Limited Access: API Read Only`.
  `GET /v1/ad-accounts/{id}` returns `timezone`, `currency`,
  `productFeatures` (`APPSTORE_APP_MANUAL` or `BUSINESS_BRAND_MANUAL`; an
  account is App Store or Maps, never both) and `systemStatus`. Calls in an
  ad account carry `X-AP-Context: adAccountId=<id>`; `/v1/me`, `/v1/acls`
  and `/v1/orgs/{id}` need no context header
  ([Access overview](https://developer.apple.com/documentation/Apple-Ads-Platform-API/access-overview),
  [UserAcl](https://developer.apple.com/documentation/Apple-Ads-Platform-API/UserAcl),
  [Get current user](https://developer.apple.com/documentation/Apple-Ads-Platform-API/Get-current-user-details),
  [Get org](https://developer.apple.com/documentation/Apple-Ads-Platform-API/GET-orgs-_id_),
  [AdAccount](https://developer.apple.com/documentation/Apple-Ads-Platform-API/AdAccount)).
  Users are invited under Account Settings → User Management
  ([Inviting users](https://ads.apple.com/help/advanced/0011-invite-users-to-your-account/)).
- **Third-party OAuth exists but is gated.** Providers can be authorized
  "through the use of a secure Apple sign in"; developers "contact
  ads-registration@group.apple.com" to register "a third-party OAuth 2
  application", and an account "can grant access to only one third-party
  service provider per Apple Ads account at a time". The grant type, URLs
  and token lifetimes are not public
  ([Apple Ads help](https://ads.apple.com/app-store/help/campaigns/0022-use-the-apple-ads-platform-api)).
- **Reports** are
  `POST /v1/reports/apps/{campaigns|adgroups|ads|keywords|searchterms}/query`.
  Ad-group, ad, keyword and search-term reports require a `campaignId`
  filter. The body has `timeRange{start,end,timeZone UTC|ORTZ,granularity}`,
  `filters[]`, `sorting[]`, `groupBy[]`, `pagination{offset,pageSize}`
  (`pageSize` at most 5000) and `options.includeRows`. `DAILY` covers at
  most 90 days per request; `HOURLY` at most 7 days within the last 365.
  Campaign and ad-group reports allow `groupBy` `countryOrRegion` among
  others. Search terms are ORTZ only, have no `HOURLY`, and suppress
  low-volume terms. Responses carry `result.rows[]` (with `metadata`,
  `totalMetrics` and `granularMetrics[]`), `summary.grandTotal` and
  `pagination{totalCount}`
  ([Reports](https://developer.apple.com/documentation/Apple-Ads-Platform-API/reports),
  [Report objects](https://developer.apple.com/documentation/Apple-Ads-Platform-API/apps-reports-objects),
  [Reporting request](https://developer.apple.com/documentation/Apple-Ads-Platform-API/AppsReportingRequest),
  [Campaign reports](https://developer.apple.com/documentation/Apple-Ads-Platform-API/Get-app-campaign-reports),
  [Search-term reports](https://developer.apple.com/documentation/Apple-Ads-Platform-API/Get-app-search-term-reports)).
- **Metrics** (`AppsMetrics`): `localSpend{amount,currency}` with the amount
  as a string, in the account's reporting currency; `impressions`, `taps`;
  tap-, view- and total installs, new downloads and redownloads; ratios
  (`ttr`, `cpt`, `cpm`, CPI, install rates); pre-order counts
  ([AppsMetrics](https://developer.apple.com/documentation/Apple-Ads-Platform-API/AppsMetrics)).
- **Rate limits.** Responses carry `RateLimit-Limit`, `RateLimit-Remaining`
  and `RateLimit-Reset`; a 429 `rate_limit_exceeded` carries `Retry-After`.
  No fixed quota is published. Errors are `{error:{code,message,details[]}}`
  ([Rate limits](https://developer.apple.com/documentation/Apple-Ads-Platform-API/rate-limits)).
- **Not documented:** how long daily data is kept, and when a day's numbers
  are final.

## Decision record (owner, 2026-10-29)

0. **API.** The Apple Ads Platform API 1.0 (`api.ads.apple.com/v1`), not
   Campaign Management API v5, which is sunset on 2027-01-26. The owner's
   rule: always the newest API.
1. **Report levels.** Campaign and ad group are in the exit gate. Keywords
   (top 20 by spend per campaign and month) are a stretch. The ad
   (creative) level is out.
2. **Search terms.** Later, outside milestone 10.
3. **Time zone.** Reports in the ad account's time zone (ORTZ); the zone is
   shown as a label.
4. **Currency.** Each account keeps its currency (`currency_minor`); the
   existing ECB display currency (#191) applies. No conversion on ingest.
5. **ADR.** This new ADR, rather than an amendment of ADR 0014.
6. **Credential path.** v1 is the customer's own API user with a key pair
   netrics generates, hosted and self-hosted. The owner applies to Apple
   for a third-party OAuth app in parallel (#379). No netrics-owned Apple
   Account that customers invite.
7. **Attribution.** One metric per quantity with an `attribution`
   dimension (`tap`, `view`); the headline is the total.
8. **Ratios.** Not stored; the compare widget (ADR 0019) and derived
   metrics (milestone 11) compute them.
9. **Connection unit.** One ad account per connection.
10. **Backfill.** 12 months, capped by the retention Apple turns out to
    have.
11. **Token storage.** A separate encrypted token store, not the key
    envelope.
12. **Apple Maps ad accounts.** Later.
13. **Order.** Milestone 10 starts now, beside the open exit gates of 06 to
    09.3; the roadmap rule "complete one milestone before opening the
    next" is relaxed for it, as for 09.x.

## Decision

### 1. Target the Platform API

The connector speaks only Platform API 1.0. A v5 connector would stop
working about three months after it shipped. The word for the unit we
connect is **ad account**, not "organization" (the v5 word).

### 2. Token exchange in signed-key providers

`SignedKeyProviderDefinition` gains an optional `exchange`: the token
endpoint, the form body (client ID from the fields, the signed JWT as
`client_secret`, scope), the response schema, and the token host in
`serverDomains`. Providers without `exchange` (App Store Connect) are
unchanged.

- **Client secret.** Signed per exchange with `iat` now − 60 s and `exp`
  now + 10 min, and never stored. Apple allows up to 180 days, but a host
  that signs on demand never needs a long-lived secret.
- **Async acquisition.** `mintTokens()` becomes `acquireTokens()`, and
  `callWithSignedKey` awaits it. The connector still receives only
  `credentials: { accessToken }`; the SDK contract does not change.
- **Cache.** The access token and its expiry live in a separate encrypted
  token store bound to the connection (an AES-GCM envelope in its own
  column or row, like the OAuth token store of ADR 0012), with RLS and
  `workspace_id` predicates. A refresh never rewrites the key envelope. A
  token valid for at least 5 more minutes is reused.
- **Serialized refresh.** Otherwise the host locks the row
  (`SELECT … FOR UPDATE`), reads it again, exchanges, stores and commits,
  as for OAuth refresh in ADR 0012. Two concurrent jobs cause one exchange.
  Key replacement and connection deletion clear the cached token.
- **Errors.** A connector 401 with a cached token clears it and retries
  once with a fresh exchange; a second 401 is `auth_failed`. An exchange
  answered with `invalid_client` is `auth_failed` ("key removed, or the IDs
  do not match the key"); 5xx and timeouts are retryable. Redaction covers
  the client secret, the token and the token response body.
- **Probes** and the wizard preview use the same exchange, without caching
  for candidate keys.

### 3. Key pair generated by netrics

Because Apple asks for a public key, netrics generates the EC P-256 pair on
the server (`node:crypto`). The wizard shows the public key PEM with a Copy
button; the private key is never shown, not even once.

- `POST /v1/workspaces/{workspaceId}/signed-keys/{provider}/key-pairs`
  returns the public key and an opaque pending-key ID. The private key is
  stored encrypted as a **pending key**, bound to the workspace and the
  user, with RLS. Pending keys expire after 24 hours and a job deletes
  them.
- Creating a connection, or replacing its key, names the pending-key ID;
  the key moves into the connection's envelope.
- Providers opt in with `generatedKeyPair: true`. App Store Connect does
  not, because Apple generates its keys.
- Pasting an existing private key stays possible (PKCS#8, or SEC1
  `EC PRIVATE KEY`, converted to PKCS#8 on the server).

### 4. Credential path

The customer's Account Admin invites an API user with **API Account Read
Only** (or Limited Access: API Read Only for some campaign groups). That
user pastes the netrics public key under Account Settings → API and enters
the client ID, team ID and key ID in netrics. This is the same on the
hosted service and self-hosted, with no instance configuration.

A registered third-party OAuth app would make the hosted service a few
clicks with no key. It needs Apple's approval and takes the account's one
provider slot, so the owner applies in parallel (#379), and the key path
stays even once OAuth exists (for self-hosted, and for accounts whose slot
is taken).

### 5. Connection model

One ad account per connection, as App Store Connect has one team per
connection, so currency and time zone are one per connection. Discovery
lists `/v1/acls` and `/v1/ad-accounts/{id}`; the wizard can add several
connections with one key. Every call after discovery sends
`X-AP-Context: adAccountId=<config>`, and each sync checks the configured
account against `/v1/acls` (gone → `auth_failed`). App Store accounts only:
Apple Maps accounts (`BUSINESS_BRAND_MANUAL`) are listed but cannot be
selected; they use other metrics and `groupBy` values.

### 6. Metrics, identity and dimensions

All `delta` at `day`, summed:

| Key                 | Unit             | Dimensions                                    |
| ------------------- | ---------------- | --------------------------------------------- |
| `ads_spend`         | `currency_minor` | `campaign`, `ad_group`, `country`, `currency` |
| `ads_impressions`   | count            | `campaign`, `ad_group`, `country`             |
| `ads_taps`          | count            | `campaign`, `ad_group`, `country`             |
| `ads_installs`      | count            | + `attribution` (`tap`, `view`)               |
| `ads_new_downloads` | count            | + `attribution`                               |
| `ads_redownloads`   | count            | + `attribution`                               |

- The headline installs number is the total, the sum over `attribution`,
  as Apple's UI shows by default.
- `campaign` and `ad_group` use Apple's stable IDs as identity and names as
  labels. `country` is `countryOrRegion` (ISO 3166-1 alpha-2) with top 10
  per campaign and month plus "Others". `keyword` is added only by the
  stretch.
- The promoted app's Apple ID is kept so Apple Ads installs and App Store
  downloads of the same app sit on one dashboard (#370 confirms the field).
- No stored ratios (TTR, CPT, CPM, CPI, install rates): daily ratios do not
  aggregate. The compare widget (ADR 0019) shows spend ÷ installs and spend
  ÷ taps now; derived metrics follow in milestone 11. Pre-order metrics are
  not in v1.

### 7. Money

`localSpend.amount` is a decimal string. An exact parser in
`packages/domain` turns it into minor units with ISO 4217 exponents (JPY 0,
EUR 2, KWD 3), with no float; extra decimals are rounded half-even and
logged once; negative amounts (credits) are kept. The account's currency is
a dimension; amounts in different currencies never sum. The display
currency of #191 (daily ECB reference rates, labelled approximate) applies
unchanged. Nothing is converted on ingest.

### 8. Days, backfill and lookback

- Reports use `timeZone ORTZ`, so numbers match the Apple Ads UI. Apple's
  day D is stored as `D T00:00:00Z` (ADR 0008), and the ad account's zone
  is kept on the connection and shown as a label ("Days in
  America/Los_Angeles, as in Apple Ads"), as App Store Connect keeps
  Pacific days.
- Backfill: 12 months, capped by retention, in 90-day `DAILY` chunks from
  the newest backwards, `pageSize` 1000 with pagination to `totalCount`.
- Incremental syncs re-read the last 3 days because attribution settles
  late. No `EMPTY_METRICS`; a missing day counts as zero only once it is
  older than the lookback.
- Ad-group reports fan out per campaign (the `campaignId` filter is
  required), bounded per sync page with a cursor per campaign; campaigns
  without spend in the range are skipped.

### 9. Network and rate limits

The connector reaches only `api.ads.apple.com`; the host's token exchange
reaches only `appleid.apple.com`. 429 is retryable with `Retry-After`
honoured; 5xx is retryable; 403 is `auth_failed` with the role message.
Because no quota is published, the connector reads `RateLimit-Remaining`
and ends a sync early, retryable, below a threshold.

### 10. Fixtures and tests

Contract tests run offline on sanitized fixtures captured from the owner's
account (#370): IDs and names replaced, amounts kept in shape. Cases: one
ad account; several in two orgs and two currencies; a Maps account; a lost
ACL; each error; chunking, pagination, replay and revised days. Fixtures
from documented shapes are allowed while building, but #373 and #374 do not
merge before the captures confirm them.

## Alternatives considered

- **Campaign Management API v5.** Better known, but sunset on 2027-01-26.
- **Exchange on every call.** Simple, but one exchange per sync page and no
  bound on calls to `appleid.apple.com`.
- **Store a long-lived client secret** (up to 180 days). Saves a signature
  per hour, but stores a bearer credential the host can recreate at will.
- **Cache the token in the key envelope.** Every refresh would rewrite the
  long-lived key; a separate store mirrors ADR 0012.
- **User generates the key pair with `openssl`.** Apple's documented path;
  it stays as the "I already have a key" option, but the default should
  need no tools.
- **A netrics-owned Apple Account invited by each customer.** Every
  customer needs a manual invite acceptance at netrics, one identity would
  reach every customer's account, and Apple does not say whether one Apple
  Account can join many unrelated orgs. Rejected.
- **Third-party OAuth only.** Gated on Apple's approval, flow undocumented,
  and one provider per account; pursued in parallel, not as the only path.
- **All accessible ad accounts in one connection.** Mixes currencies and
  time zones in one connection; rejected for one account per connection.
- **UTC days.** Numbers would not match the Apple Ads UI, and search terms
  allow only ORTZ.
- **Separate metrics per attribution type** (`ads_tap_installs`, …). The
  dimension keeps one metric per quantity and makes the total the natural
  headline.

## Consequences

- The signed-key host becomes async and gains an optional token exchange,
  an encrypted token store and pending generated keys (two migrations with
  RLS). App Store Connect is unchanged; the SDK contract is unchanged.
- Hosted and self-hosted are identical, with no instance configuration.
- Customers need an Account Admin to invite an API user once. The wizard
  links to User Management and Account Settings → API.
- Search terms, the ad level, keywords beyond the stretch, Apple Maps
  accounts, pre-orders, hourly data and third-party OAuth are follow-ups.

## Open checks (#370 and the exit gate #378)

- How many months of daily data Apple keeps (backfill cap).
- Which `metadata` field names the promoted app and its Apple ID.
- The `RateLimit-Limit` values seen in practice.
- Whether the day before yesterday still changes (lookback of 3 days).
- Whether the owner's account has pre-orders.
- The role names and Apple Ads UI labels match the wizard copy.
