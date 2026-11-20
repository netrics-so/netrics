# Apple Ads connector

Reads the spend, impressions, taps and installs of your App Store campaigns
from [Apple Ads](https://ads.apple.com/), one ad account per connection, in
the ad account's currency and time zone
([ADR 0020](../decisions/0020-apple-ads-platform-api-token-exchange.md)).
It uses the Apple Ads Platform API 1.0 (`api.ads.apple.com/v1`), not the
Campaign Management API v5, which Apple sunsets on 2027-01-26.

> Status: available (milestone 10). The key exchange (#369), the generated
> key pair (#371), ad-account discovery (#373), the campaign report sync
> (#374), the guided setup (#375), ad groups (#376, #394) and keywords
> (#396) are tested against documented response shapes and against shapes
> captured from a real account (#370). The exit gate (#378) passed on the
> hosted service and on a self-hosted install on 2026-11-20, so Apple Ads
> is available on every installation without any setting. A leftover
> `NETRICS_PREVIEW_CONNECTORS=apple-ads` only logs a warning and can be
> removed (see
> [Preview connectors](../../deploy/compose/README.md#preview-connectors)).
> Points marked _to be confirmed_ below are still open.

## Connect

Apple Ads has no open "Sign in with Apple" for other services, so netrics
reads it as an **API user** of your own Apple Ads account. netrics
generates the key pair for you: you paste its public key in Apple Ads, and
the private key never leaves netrics, not even to be shown once. The wizard
(Add connection → Apple Ads) has four steps:

1. **Use an API user.** An Account Admin invites a user under
   **Account Settings → User Management** with the role
   **API Account Read Only**, or the limited-access role **API Read Only**
   to share only some campaign groups (see [Roles](#roles)). The user
   accepts the invitation and signs in to Apple Ads. An existing API user
   works too. An Admin login cannot be the API user: under Account
   Settings → API an Admin sees only the list of service providers with
   access, and no field for a public key.
   Apple explains invitations in
   [Inviting users](https://ads.apple.com/help/advanced/0011-invite-users-to-your-account/).
2. **Paste the public key.** netrics shows the generated public key with a
   **Copy** button. Signed in as the API user, open **Account Settings →
   API**, choose **Generate API Client** (German UI: **API-Client
   generieren**), paste it and save. The pending private key
   is kept encrypted for you, in this workspace, for 24 hours; after that,
   generate a new pair.
3. **Enter the IDs.** Once the key is pasted, Apple Ads shows `clientId`,
   `teamId` and `keyId`; the team ID can be the same as the client ID.
   Copy them into the three fields; pasting the whole
   block into any of them fills in all three. The fields are checked as you
   type: client ID and team ID start with `SEARCHADS.` followed by an ID,
   and the key ID is an ID with dashes.
4. **Choose the ad accounts.** **Check key and find ad accounts** exchanges
   the key with Apple and lists the ad accounts the API user can read, each
   with its currency and time zone. Tick the ones to connect: each becomes
   its own connection. Apple Maps ad accounts are listed but cannot be
   chosen yet.

**I already have a private key**: instead of generating a pair, paste an
EC P-256 private key whose public key you saved in Apple Ads, for example
one made with `openssl` as in
[Apple's guide](https://developer.apple.com/documentation/apple-ads-platform-api/implementing-oauth-for-the-apple-ads-platform-api).
PKCS#8 (`BEGIN PRIVATE KEY`) and SEC1 (`BEGIN EC PRIVATE KEY`) are
accepted; netrics stores it as PKCS#8.

Before anything is stored, netrics checks the key with Apple:

1. It signs a client secret (ES256, valid for 10 minutes, never stored) and
   exchanges it at `appleid.apple.com` for an access token. Apple answering
   `invalid_client` means the IDs do not match the public key, or the key
   was removed.
2. `GET /v1/acls` lists the API user's ad accounts and roles, and
   `GET /v1/ad-accounts/{id}` each account's currency, time zone and kind.
3. For each chosen ad account: it must be in the API user's list, with an
   API role, and be an App Store ad account.

If one chosen ad account fails, nothing is created and the generated key
stays usable, so you can untick that account and try again.

The connection stores, encrypted (AES-GCM, bound to the connection), the
private key with the client ID, team ID and key ID. Its configuration holds
the ad account's ID, name, currency and time zone, as Apple reported them
when you connected. The connection page shows these, and the client ID,
team ID and key ID, which are not secret; the private key shows only as
"stored".

## Roles

| Role (Apple Ads UI)               | Works | Notes                                                                                              |
| --------------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| API Account Read Only             | Yes   | Recommended: reads every campaign of the ad account, changes nothing.                              |
| API Read Only (limited access)    | Yes   | Reads only the campaign groups shared with the user.                                               |
| API Account Manager               | Yes   | Works, but can change campaigns. netrics never writes; avoid it.                                   |
| API Read & Write (limited access) | Yes   | As above, for some campaign groups.                                                                |
| Account Admin                     | No    | Not as the API user: Apple Ads offers an Admin no public-key field. An Admin invites the API user. |
| Any other role                    | No    | Apple refuses API access. netrics says the user needs an API role.                                 |

The role is per ad account: an API user may read one ad account and not
another. The API's names differ from the UI's: for a user invited with
API Account Read Only, `GET /v1/acls` answers the role `API Read Only`
(#370). netrics accepts that and the names in Apple's documentation
(`API Account Read Only`, `Limited Access: API Read Only`, …). _To be
confirmed_: the strings Apple returns for the limited-access and
read-and-write roles.

## Several ad accounts

One connection reads one ad account, so currency and time zone are one per
connection. To connect several, tick them all in step 4: one request
creates a connection per ad account from the same key, all or none.

Connections created this way share the key. Their pages say which other
connections use it. **Replace key** on any of them replaces it in all of
them, after the new key has been checked with each one's ad account; if it
fails for one, nothing changes.

To add an ad account later, for example after an Account Admin gave the
API user a role in another one, use **Add another ad account** on the page
of a connection with that API user's key. netrics asks Apple with the
stored key which ad accounts it reads and marks those the workspace has
connected already; the ones you tick become connections with the same
stored key, in one request, all or none. The key stays on the server, the
new connections then share it as above, and the audit log records that
the key was shared and from which connection. Only a connection of the
same workspace lends its key
(`GET` and `POST /v1/workspaces/{workspaceId}/connections/{connectionId}/shared-key/…`).

Do not run the wizard again for an API user that already has a
connection: it generates a new key pair, and pasting its public key for
the same API user replaces the earlier one in Apple Ads. The `keyId` stays
the same, and Apple then refuses the earlier key with `invalid_client`
(seen at the exit gate, #378), so the earlier connections stop until
they get the new key.

Ad accounts of different API users have separate keys and connections;
they can sit side by side in one workspace.

## Rotating or revoking the key

- **Rotate**: on the connection page choose **Replace key**, generate a new
  pair (or paste a private key), paste the public key in Apple Ads and enter
  the IDs Apple Ads shows. They usually stay the same: saving a new public
  key for the same API user replaces the old one under the same `keyId`
  (#378), and the client ID and team ID belong to the API user. netrics
  checks the new key with Apple first; if the check fails, the stored key
  stays as it is and syncing continues. When it passes, the new key
  replaces the old one, in every connection that shared it, and the cached
  access token is dropped. Since Apple Ads replaced the public key in
  place, there is usually nothing to remove; only if it still lists the
  old public key as a separate key under Account Settings → API, remove it
  there.
- **Removed key or lost access**: when Apple refuses the key (the public key
  was removed, the API user lost its API role or the ad account), the
  connection is paused in "Auth failed" with Apple's reason, in the
  viewer's language, and the page offers **Set up a new key**. Syncing
  restarts as soon as a new key passes the check; the data collected so
  far is kept. If the refusal had stopped the first 12-month read before
  it finished, the new key queues it again, for every connection that
  shares the key.
- **A removed key is noticed at the next token exchange.** netrics caches
  the access token for up to 1 hour (ADR 0020), and Apple does not revoke
  tokens it has already issued. Syncs can therefore still succeed for up
  to an hour after you remove or replace the public key in Apple Ads; the
  first exchange after that is refused and the connection goes to "Auth
  failed".
- **Delete the connection**: netrics deletes its copy of the private key and
  the cached token. Then remove the public key under **Account Settings →
  API** in Apple Ads, unless another connection still uses the same key;
  the page says which.

## When numbers arrive

- Widgets show which day the numbers go up to
  ([ADR 0025](../decisions/0025-data-freshness.md)). For Apple Ads that is
  **yesterday in the ad account's time zone**, once a sync has read every
  campaign: today is still running. The day is the ad account's, as in
  Apple Ads; a viewer in another time zone sees the same date.
- The last 3 days still change while Apple attributes installs; the widget
  does not mark that, the values are replaced on each sync.
- Apple names no time at which a day is complete, so netrics shows no
  "next" time for Apple Ads; the connection syncs every 6 hours.
- The first sync reads the last **12 months**, newest first, capped by what
  Apple keeps (_to be confirmed_: the account checked in #370 had no
  campaigns old enough to show where Apple's history ends). It reads
  whole calendar months in requests of at most 90 days. A range without
  numbers is an empty answer, not an error.
- After that, netrics syncs every **6 hours** and reads the last **3 days**
  again each time, because Apple attributes installs late
  (_to be confirmed_: whether the day before yesterday still changes needs
  two captures on consecutive days).
- A day with no campaign activity counts as zero only once it is older than
  those 3 days. Apple answers such a day with its date alone, and netrics
  stores nothing for it in a month without any activity. An ad account
  with no activity in a widget's period still shows 0 (spend in the ad
  account's currency, impressions, taps, installs), not "No data yet"
  (#378), when:
  - the history was read completely: the last backfill succeeded, and the
    period starts on or after where it started (12 months back);
  - the period starts no later than the day the widget's numbers go up
    to (so not "today");
  - the widget filters by nothing but the currency. A country, keyword,
    ad group or app filter (or a slide scoped to an app) keeps "No data
    yet": countries and keywords are stored as the top ones plus
    "Others", and an app may not have been read.

  Cost per install then has no value ("–"), since nothing was installed.
  "No data yet" also stays while the history is loading, and the change
  against the previous period is left out.

- Ad groups and keywords are read per campaign over the same days, only
  for campaigns with numbers in them, 10 campaigns per sync step (fewer
  when Apple answers slowly, so a step stays within its time limit): an
  account with many campaigns takes a few more steps. Per campaign and
  step netrics reads one page of the 1,000 keywords with the most spend.

## Time zone and currency

- **Days are the ad account's days**, as in the Apple Ads UI (Apple's
  `ORTZ` reports). A day in `America/Los_Angeles` is stored as that date,
  whatever your workspace's time zone, and tiles carry the label "Days in
  America/Los_Angeles, as in Apple Ads".
- **Spend stays in the ad account's currency.** Apple reports it as a
  decimal string with up to four decimals (`3.8127`); netrics stores whole
  minor units of that currency (cents, yen, fils), rounded half to even per
  day and row, never through floating point. A month's sum can therefore
  differ from Apple's total by a few cents. A campaign's countries, ad
  groups and keywords of a day, with their "Others", share the campaign's
  rounded total by largest remainder (#378): each row gets its exact
  amount rounded down, and the cents left go to the rows with the largest
  remainders. Their sums equal the campaign's to the cent, and "Others" is
  never below zero; a row can be a cent below its own rounding (2.7075 +
  1.1052 EUR on a 3.8127 EUR campaign day are 2.71 + 1.10). Should Apple's
  rows add up to more than its campaign total, "Others" is 0 and the rows
  with the smallest remainders give the difference back. Before this
  (#378), such a day could store "Others" as -1 cent; a sync that reads the
  day again writes 0 over it. For days older than the 3-day lookback, use
  **Reload history** once. Amounts in
  different currencies are separate series and never add up; the display
  currency of a dashboard converts only for display, at daily ECB
  reference rates, labelled approximate.
- Currency and time zone are kept as Apple reported them when you
  connected. If Apple changes either for an ad account, connect it again.
- **Comparing with Apple Ads**: use **Insights**. Its numbers matched
  netrics exactly for a campaign day at the exit gate (#378), and its
  footer names the report time zone, which should be the ad account's.
  The campaign list (**Manage campaigns**) cuts days differently: the same
  date there shows other numbers, while the sum of two days matches.

## Configuration

| Setting         | Meaning                                                  |
| --------------- | -------------------------------------------------------- |
| Ad account      | The ad account's ID, chosen in the setup.                |
| Ad account name | Its name in Apple Ads when you connected (a label only). |
| Currency        | Its currency (ISO 4217), as Apple Ads reports it.        |
| Time zone       | Its time zone (IANA), which the reporting days follow.   |

These come from Apple during the setup and cannot be edited; to read
another ad account, add a connection (**Add another ad account**).

## Metrics

All `delta` values per day, summed. The main metrics are by campaign and
country or region:

| Metric                    | Unit             | Dimensions                               |
| ------------------------- | ---------------- | ---------------------------------------- |
| `apple_ads.spend`         | `currency_minor` | resource, campaign, country, currency    |
| `apple_ads.impressions`   | `impressions`    | resource, campaign, country              |
| `apple_ads.taps`          | `taps`           | resource, campaign, country              |
| `apple_ads.installs`      | `installs`       | resource, campaign, country, attribution |
| `apple_ads.new_downloads` | `downloads`      | resource, campaign, country, attribution |
| `apple_ads.redownloads`   | `downloads`      | resource, campaign, country, attribution |

The same quantities by ad group have keys of their own, as App Store
Connect's `downloads_by_territory` beside `downloads`, so an unfiltered
sum of either set is the ad account's total and spend is never counted
twice. There is no country breakdown by ad group.

| Metric                                | Unit             | Dimensions                                |
| ------------------------------------- | ---------------- | ----------------------------------------- |
| `apple_ads.spend_by_ad_group`         | `currency_minor` | resource, campaign, ad_group, currency    |
| `apple_ads.impressions_by_ad_group`   | `impressions`    | resource, campaign, ad_group              |
| `apple_ads.taps_by_ad_group`          | `taps`           | resource, campaign, ad_group              |
| `apple_ads.installs_by_ad_group`      | `installs`       | resource, campaign, ad_group, attribution |
| `apple_ads.new_downloads_by_ad_group` | `downloads`      | resource, campaign, ad_group, attribution |
| `apple_ads.redownloads_by_ad_group`   | `downloads`      | resource, campaign, ad_group, attribution |

The same quantities by keyword (#396), again in keys of their own: the 20
keywords with the most spend per campaign and calendar month (in the ad
account's days) by name, the rest of the campaign under "Others".

| Metric                               | Unit             | Dimensions                               |
| ------------------------------------ | ---------------- | ---------------------------------------- |
| `apple_ads.spend_by_keyword`         | `currency_minor` | resource, campaign, keyword, currency    |
| `apple_ads.impressions_by_keyword`   | `impressions`    | resource, campaign, keyword              |
| `apple_ads.taps_by_keyword`          | `taps`           | resource, campaign, keyword              |
| `apple_ads.installs_by_keyword`      | `installs`       | resource, campaign, keyword, attribution |
| `apple_ads.new_downloads_by_keyword` | `downloads`      | resource, campaign, keyword, attribution |
| `apple_ads.redownloads_by_keyword`   | `downloads`      | resource, campaign, keyword, attribution |

- `resource` is the promoted app's Apple ID, as in the App Store Connect
  connector, so ad installs and App Store downloads of one app sit on one
  dashboard.
- `campaign` and `ad_group` are Apple's IDs; names are labels. netrics
  reads the names of the apps, campaigns and ad groups at most once a day
  after a sync (ad groups in one account-wide query of up to 20 pages of
  1,000), so a renamed campaign or ad group shows its new name from then
  on, and a removed one keeps its last known name. One ID can be an app, a
  campaign and an ad group at once; each keeps its own name. What a
  campaign's ad groups leave out of its total (a deleted campaign Apple no
  longer reports ad groups for) is the ad group "Others", so ad-group sums
  equal campaign sums.
- `keyword` is Apple's keyword ID; the name is the keyword's text, read
  with the ad groups' names for the ad groups discovery found (at most
  10,000 keywords, and only for a few seconds). One text can be several
  keywords (one per ad group and match type), each its own series. Values
  are daily like every other key, so any period and the compare widget
  work; the top 20 are ranked over the whole calendar month, so a day has
  the same keywords whichever sync wrote it, and a keyword that drops out
  of a running month's top 20 is set to 0 there (its numbers move to
  "Others"), so nothing is counted twice. "Others" holds the other
  keywords, Search Match and anything without a keyword report (a deleted
  campaign), so keyword sums equal campaign sums every day. A removed
  keyword keeps its history.
- `country` is the country or region (ISO 3166-1 alpha-2): the 10 with the
  most spend per campaign and calendar month, plus "Others", so an
  unfiltered sum is the ad account's total.
- `attribution` is `tap` or `view` (view-through). The headline number is
  the sum of both, as the Apple Ads UI shows by default.
- Ratios (TTR, CPT, CPM, CPI, install rates) are not stored: daily ratios do
  not add up. The compare widget computes spend ÷ installs and spend ÷ taps.

## Dashboards

The Overview template (New dashboard → from a template) gives each Apple
Ads connection a slide "Apple Ads": spend over 30 days in the ad account's
currency (filtered to it, so never converted, and the title names it),
installs (the total of tap and view), cost per install as a compare widget
(spend ÷ installs), the top campaigns by spend, spend by country or region,
installs after a tap or a view, and a note "Days in America/Los_Angeles, as
in Apple Ads". With App Store Connect or Vercel connected too, the Overview
starts with a slide "At a glance": App Store downloads, Apple Ads installs
and Vercel visitors over 7 days side by side, with their 30-day trends.
There is no Brand template for an ad account.

## Limits

Apple publishes no fixed quota. Seen in practice (#370): `RateLimit-Limit`
200 per second on most calls (`RateLimit-Reset` 1), and 3,000 per minute
on `POST /v1/campaigns/query` (reset 59). Responses carry
`RateLimit-Remaining`;
netrics ends a sync early when only a few requests are left and pauses the
connection until `RateLimit-Reset` (a minute without one). A 429 is retried
after a short `Retry-After`; a longer one pauses the connection until then.
Syncing continues where it stopped. A server error is retried with a
backoff. The limit belongs to the API user, so connections that share a key
share it.

## When something goes wrong

| What you see                                                                | What to do                                                                                               |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| "Client ID starts with SEARCHADS. …" / "Key ID is an ID such as …"          | Copy the values from Account Settings → API; the key ID has no `SEARCHADS.` prefix.                      |
| "Apple Ads refused the key: the client ID, team ID and key ID do not match" | The IDs belong to another key, or the public key was removed. Check them, or set up a new key.           |
| Numbers differ from the campaign list in Apple Ads                          | Compare with Apple Ads Insights, in the ad account's time zone; the campaign list cuts days differently. |
| "The Apple Ads API user needs an API role"                                  | An Account Admin gives the user API Account Read Only in that ad account (User Management).              |
| "This Apple Ads API user has no ad accounts"                                | The user has no role in any ad account yet. Ask an Account Admin to add one.                             |
| "Apple Maps ads are not supported yet"                                      | Choose an App Store ad account. Apple Maps ad accounts follow later.                                     |
| "no longer has access to ad account …"                                      | The API user lost that ad account. Restore its role, or set up a new key on the connection page.         |
| "The generated key pair is no longer available"                             | Generate a new key pair and paste its public key in Apple Ads again.                                     |
| "Apple Ads' request limit for this API user is used up"                     | Nothing: netrics retries automatically.                                                                  |

## Self-hosted

The same flow, with no instance configuration: no app to register with
Apple, no client ID or secret in the environment. The server needs outbound
HTTPS to the two hosts below.

## Network access

The connector talks only to `api.ads.apple.com`. The token exchange is done
by the netrics server, not by connector code, and reaches only
`appleid.apple.com`. The connector receives only the access token, never
the key or the client secret; the access token is cached encrypted for the
connection and never appears in logs, errors, responses or job payloads.
