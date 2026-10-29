# Apple Ads connector

Reads the spend, impressions, taps and installs of your App Store campaigns
from [Apple Ads](https://ads.apple.com/), one ad account per connection, in
the ad account's currency and time zone
([ADR 0020](../decisions/0020-apple-ads-platform-api-token-exchange.md)).
It uses the Apple Ads Platform API 1.0 (`api.ads.apple.com/v1`), not the
Campaign Management API v5, which Apple sunsets on 2027-01-26.

> Status: preview (milestone 10). The key exchange (#369), the generated key
> pair (#371), ad-account discovery (#373), the campaign report sync (#374)
> and the guided setup (#375) are in place, tested against documented
> response shapes. Apple Ads is available in development only until the
> owner's captured responses (#370) and the exit gate (#378) confirm them.
> Wording marked _to be confirmed_ below is checked against the real Apple
> Ads UI at the exit gate.

## Connect

Apple Ads has no open "Sign in with Apple" for other services, so netrics
reads it as an **API user** of your own Apple Ads account. netrics
generates the key pair for you: you paste its public key in Apple Ads, and
the private key never leaves netrics, not even to be shown once. The wizard
(Add connection → Apple Ads) has four steps:

1. **Use an API user.** An Account Admin invites a user under
   **Account Settings → User Management** with the role
   **API Account Read Only**, or **Limited Access: API Read Only** to share
   only some campaign groups (see [Roles](#roles)). The user accepts the
   invitation and signs in to Apple Ads. An existing API user works too.
   Apple explains invitations in
   [Inviting users](https://ads.apple.com/help/advanced/0011-invite-users-to-your-account/).
2. **Paste the public key.** netrics shows the generated public key with a
   **Copy** button. Signed in as the API user, open **Account Settings →
   API**, paste it under **Public key** and save. The pending private key
   is kept encrypted for you, in this workspace, for 24 hours; after that,
   generate a new pair.
3. **Enter the IDs.** Apple Ads then shows `clientId`, `teamId` and `keyId`
   above the public key. Copy them into the three fields; pasting the whole
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

| Role (Apple Ads)                 | Works | Notes                                                                 |
| -------------------------------- | ----- | --------------------------------------------------------------------- |
| API Account Read Only            | Yes   | Recommended: reads every campaign of the ad account, changes nothing. |
| Limited Access: API Read Only    | Yes   | Reads only the campaign groups shared with the user.                  |
| API Account Manager              | Yes   | Works, but can change campaigns. netrics never writes; avoid it.      |
| Limited Access: API Read & Write | Yes   | As above, for some campaign groups.                                   |
| Admin                            | Yes   | Works, but grants far more than netrics needs.                        |
| Any non-API role                 | No    | Apple refuses API access. netrics says the user needs an API role.    |

The role is per ad account: an API user may read one ad account and not
another. _To be confirmed_ (#370): the exact role strings Apple returns.

## Several ad accounts

One connection reads one ad account, so currency and time zone are one per
connection. To connect several, tick them all in step 4: one request
creates a connection per ad account from the same key, all or none.

Connections created this way share the key. Their pages say which other
connections use it. **Replace key** on any of them replaces it in all of
them, after the new key has been checked with each one's ad account; if it
fails for one, nothing changes.

Connect all the ad accounts of one API user in one go. A second run of the
wizard generates a new key pair, and if you paste its public key for the
same API user, the earlier key may stop working (_to be confirmed_ at #378:
whether Apple Ads keeps more than one public key per API user).

Ad accounts of different API users have separate keys and connections;
they can sit side by side in one workspace.

## Rotating or revoking the key

- **Rotate**: on the connection page choose **Replace key**, generate a new
  pair (or paste a private key), paste the public key in Apple Ads and enter
  the new IDs. netrics checks the new key with Apple first; if the check
  fails, the stored key stays as it is and syncing continues. When it
  passes, the new key replaces the old one, in every connection that shared
  it, and the cached access token is dropped. If Apple Ads still lists the
  old public key under Account Settings → API, remove it there.
- **Removed key or lost access**: when Apple refuses the key (the public key
  was removed, the API user lost its API role or the ad account), the
  connection is paused in "Auth failed" with Apple's reason, and the page
  offers **Set up a new key**. Syncing restarts as soon as a new key passes
  the check; the data collected so far is kept.
- **Delete the connection**: netrics deletes its copy of the private key and
  the cached token. Then remove the public key under **Account Settings →
  API** in Apple Ads, unless another connection still uses the same key;
  the page says which.

## When data arrives

- The first sync reads the last **12 months**, newest first, capped by what
  Apple keeps (_to be confirmed_ by #370). It reads whole calendar months
  in requests of at most 90 days.
- After that, netrics syncs every **6 hours** and reads the last **3 days**
  again each time, because Apple attributes installs late
  (_to be confirmed_ by #370: whether the day before yesterday still
  changes).
- A day with no campaign activity counts as zero only once it is older than
  those 3 days.
- Ad groups are read per campaign over the same days, only for campaigns
  with numbers in them, 10 campaigns per sync step: an account with many
  campaigns takes a few more steps.

## Time zone and currency

- **Days are the ad account's days**, as in the Apple Ads UI (Apple's
  `ORTZ` reports). A day in `America/Los_Angeles` is stored as that date,
  whatever your workspace's time zone, and tiles carry the label "Days in
  America/Los_Angeles, as in Apple Ads".
- **Spend stays in the ad account's currency.** Apple reports it as a
  decimal string; netrics stores whole minor units of that currency
  (cents, yen, fils) without rounding through floating point. Amounts in
  different currencies are separate series and never add up; the display
  currency of a dashboard converts only for display, at daily ECB
  reference rates, labelled approximate.
- Currency and time zone are kept as Apple reported them when you
  connected. If Apple changes either for an ad account, connect it again.

## Configuration

| Setting         | Meaning                                                  |
| --------------- | -------------------------------------------------------- |
| Ad account      | The ad account's ID, chosen in the setup.                |
| Ad account name | Its name in Apple Ads when you connected (a label only). |
| Currency        | Its currency (ISO 4217), as Apple Ads reports it.        |
| Time zone       | Its time zone (IANA), which the reporting days follow.   |

These come from Apple during the setup and cannot be edited; to read
another ad account, add a connection.

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

- `resource` is the promoted app's Apple ID, as in the App Store Connect
  connector, so ad installs and App Store downloads of one app sit on one
  dashboard.
- `campaign` and `ad_group` are Apple's IDs; names are labels. What a
  campaign's ad groups leave out of its total (a deleted campaign Apple no
  longer reports ad groups for) is the ad group "Others", so ad-group sums
  equal campaign sums.
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

Apple publishes no fixed quota. Responses carry `RateLimit-Remaining`;
netrics ends a sync early, and retries later, when only a few requests are
left. A 429 is retried after Apple's `Retry-After`, a server error with a
backoff. The limit belongs to the API user, so connections that share a key
share it.

## When something goes wrong

| What you see                                                                | What to do                                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| "Client ID starts with SEARCHADS. …" / "Key ID is an ID such as …"          | Copy the values from Account Settings → API; the key ID has no `SEARCHADS.` prefix.              |
| "Apple Ads refused the key: the client ID, team ID and key ID do not match" | The IDs belong to another key, or the public key was removed. Check them, or set up a new key.   |
| "The Apple Ads API user needs an API role"                                  | An Account Admin gives the user API Account Read Only in that ad account (User Management).      |
| "This Apple Ads API user has no ad accounts"                                | The user has no role in any ad account yet. Ask an Account Admin to add one.                     |
| "Apple Maps ads are not supported yet"                                      | Choose an App Store ad account. Apple Maps ad accounts follow later.                             |
| "no longer has access to ad account …"                                      | The API user lost that ad account. Restore its role, or set up a new key on the connection page. |
| "The generated key pair is no longer available"                             | Generate a new key pair and paste its public key in Apple Ads again.                             |
| "Apple Ads' request limit for this API user is used up"                     | Nothing: netrics retries automatically.                                                          |

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
