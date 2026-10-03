# App Store Connect connector

Reads your apps' App Store sales (downloads, in-app purchases and proceeds)
from [App Store Connect](https://appstoreconnect.apple.com/), for one team
and one vendor number per connection, and, once enabled, App Store
analytics (impressions, product page views, downloads by source)
([ADR 0014](../decisions/0014-app-store-connect-signed-keys.md)).

> Status: the key check, app discovery (#171), the daily sales sync (#172)
> and App Store analytics (#174) are in place. The exit gate (#176) checks
> them against a real account.

## Connect

Apple offers no "Sign in with Apple" for its API. You create an API key in
App Store Connect and upload it to netrics once. The wizard (Add connection
→ App Store Connect) shows these steps with links:

1. Sign in to App Store Connect as the Account Holder or an Admin and open
   [Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api).
   The first time, the Account Holder has to request API access there.
2. Under **Team Keys**, generate a key named "netrics" with the **Sales**
   role (see [Roles](#roles)).
3. Download the `.p8` file right away: Apple offers it only once. Copy the
   **Key ID** from the key's row and the **Issuer ID** shown above the list.
4. Find your **vendor number** in
   [Payments and Financial Reports](https://appstoreconnect.apple.com/itc/payments_and_financial_reports),
   under your legal entity name.
5. In netrics, enter the issuer ID, choose the `.p8` file (or paste its
   content), and enter the vendor number. When the file keeps Apple's name
   `AuthKey_<Key ID>.p8`, the key ID is filled in from it.

The file is read in your browser and sent to netrics once. After that,
netrics never shows the private key again: the connection page shows only
"stored" with the issuer ID and key ID, which are not secret.

Before anything is stored, netrics checks the values against Apple:

1. `GET /v1/apps?limit=1`: the issuer ID, key ID and private key must belong
   together, and the key must not be revoked.
2. The daily sales report of your vendor number for the latest published
   day: the key must have a role that reads sales reports, and the vendor
   number must belong to the team. A day without sales is fine.

Each failed check is shown next to the field it is about (issuer ID, key
ID, private key, vendor number), or for the key as a whole (wrong
combination, role, agreements, rate limit). Then netrics lists the apps of
the key's team; untick the ones you do not want, and create the connection.

netrics stores the key encrypted (AES-GCM, bound to the connection) and
signs a short-lived token (10 minutes) for every call. The connector itself
never sees the key, only the token.

## Roles

A team key carries the role chosen when it was created; Apple does not let
you change it later.

| Role             | Works | Notes                                                                                   |
| ---------------- | ----- | --------------------------------------------------------------------------------------- |
| Sales            | Yes   | Recommended: reads sales reports and nothing it does not need.                          |
| Finance          | Yes   | Also reads sales reports.                                                               |
| Admin            | Yes   | Works, but can change apps, users and pricing. netrics does not need that; avoid it.    |
| Developer, other | No    | Cannot read sales reports. netrics refuses the key with "This key cannot read sales …". |
| Individual key   | No    | Individual keys cannot read sales reports.                                              |

## Rotating or revoking the key

- **Rotate**: create a new team key, then on the connection page choose
  **Replace key** and upload it. netrics checks the new key with Apple
  first. If the check fails, the stored key stays as it is and syncing
  continues. When it passes, the new key replaces the old one, and the page
  reminds you to revoke the old key (by its key ID) in App Store Connect.
  netrics cannot revoke keys for you: Apple has no API for that.
- **Revoked or downgraded key**: when Apple refuses the stored key (it was
  revoked, or its access was removed), the connection is paused in "Auth
  failed" with Apple's reason, and the page offers **Upload a new App Store
  Connect key**. Syncing restarts as soon as a new key passes the check; the
  data collected so far is kept.
- **Delete the connection**: netrics deletes its copy of the key. The key
  stays valid at Apple until you revoke it under
  [Users and Access → Integrations](https://appstoreconnect.apple.com/access/integrations/api);
  netrics links there after deleting.

## When data arrives

- **Sales** for a day are published by Apple the next morning, Pacific Time
  (generally by 8 a.m. PT). A day's sales appear in netrics at
  the first sync after Apple publishes them.
- **App Store analytics**, once enabled, start 1–2 days after the request,
  and a day is complete about two days later than its sales (see
  [App Store analytics](#app-store-analytics)).
- **Reporting days are Pacific Time days.** A sale at 23:30 PT on the 1st
  counts on the 1st, even if your workspace's time zone already shows the
  2nd. netrics does not shift Apple's days into the workspace time zone.
- The connection page shows the latest reporting day collected.
- Apple keeps daily reports for one year, which bounds what can be read
  back.

## App Store analytics

Impressions, product page views and downloads by source are not in the
sales reports. They come from Apple's
[Analytics Reports API](https://developer.apple.com/documentation/appstoreconnectapi/downloading-analytics-reports),
which generates reports only for apps someone has requested them for.
Reading them works with the Sales key netrics stores, but **requesting**
them needs a key with the **Admin** role, once per app. netrics never stores
an Admin key, so this is a separate, optional step.

### Enable App Store analytics

On the connection page, the **App Store analytics** card lists the
connection's apps and their state. When an app is not requested yet:

1. In App Store Connect, under
   [Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api),
   generate a team key named "netrics analytics (temporary)" with the
   **Admin** role, and download its `.p8` file.
2. Choose **Enable App Store analytics** and upload it (the same form as
   the key: issuer ID, key ID, `.p8` file or paste). The issuer ID must be
   the one of the stored key: both keys belong to the same team.
3. netrics uses the key **in memory, for this one request**: per app it
   lists the existing analytics report requests
   (`GET /v1/apps/{id}/analyticsReportRequests`, access type `ONGOING`) and
   creates one (`POST /v1/analyticsReportRequests`) only when none is
   running. Apple's 409 ("already exists") counts as requested. The key is
   not stored, not put in a job and not logged; the audit log records
   `connection.analytics_enabled` with the app IDs only.
4. **Revoke the temporary key** right afterwards; the page reminds you,
   with its key ID. Nothing needs it any more.

When a request already exists (made by hand or by another tool), nothing is
needed: the card shows the app as requested, and the step is skipped.
Running the step again creates nothing new.

| State on the card                         | Meaning                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Not enabled                               | No `ONGOING` request for the app: use **Enable App Store analytics**.                   |
| Requested — data pending                  | Apple has the request; its first reports take 1–2 days.                                 |
| Available through _day_                   | netrics has analytics data up to that reporting day.                                    |
| App Store analytics paused — enable again | Apple stopped the request (`stoppedDueToInactivity`). Enabling again creates a new one. |

Apple stops an `ONGOING` request whose reports nobody reads for a long
time. netrics reads them on every sync, so this happens mainly when a
connection was paused; sales keep syncing either way.

### How analytics are read

Every sync, after the sales, reads per app (two apps per sync step) with
the Sales key: the app's running request → its reports → `DAILY` instances
→ segments → the segment files. Two reports, in their **standard** variant
(the detailed ones add fields netrics does not use and stricter privacy
thresholds):

| Report (API name)                             | Category               | Fields used                                                    |
| --------------------------------------------- | ---------------------- | -------------------------------------------------------------- |
| `App Store Discovery and Engagement Standard` | `APP_STORE_ENGAGEMENT` | Date, App Apple Identifier, Event, Page Type, Counts           |
| `App Downloads Standard`                      | `COMMERCE`             | Date, App Apple Identifier, Download Type, Source Type, Counts |

Field names and values follow Apple's reference:
[App Store Discovery and Engagement](https://developer.apple.com/documentation/analytics-reports/app-store-discovery-and-engagement)
and [App Store Downloads](https://developer.apple.com/documentation/analytics-reports/app-download).
The report names are the API's (`name` attribute, with the `Standard` or
`Detailed` suffix, as in Apple's
[example](https://developer.apple.com/documentation/appstoreconnectapi/downloading-analytics-reports)).
Columns are matched by name, unknown columns are ignored, and a missing
column fails the analytics of that app (sales go on).

| Metric                                 | Unit          | Dimensions       | What it counts                                                                                   |
| -------------------------------------- | ------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `app_store_connect.impressions`        | `impressions` | resource         | Event "Impression": the app's icon shown in a list (search results, charts, Today, Apps, Games)  |
| `app_store_connect.product_page_views` | `views`       | resource         | Event "Page view" on the "Product page" or a "Store sheet" (the product page inside another app) |
| `app_store_connect.store_downloads`    | `downloads`   | resource, source | Download Type "First-time download", per Source Type                                             |

- **Source types** are Apple's: App Store search, App Store browse, App
  referrer, Web referrer, App Clip, Notification, Institutional purchase,
  Unavailable (also for an empty value). A source Apple adds later is
  counted as "Other", so an app has at most nine source series.
- Redownloads, updates and restores are not first-time downloads and are
  not counted in `store_downloads`. The sales metric
  `app_store_connect.downloads` counts first-time downloads too, from the
  sales report; the two can differ slightly (different pipelines). Views of
  in-app event pages, version history and other pages are not product page
  views.
- **Days** are Apple's report dates, stored at D 00:00 UTC like the sales
  (Pacific Time days, ADR 0008).
- **Late data.** An instance (processing day P) holds data up to P,
  including late events of earlier days. Every sync reads the instances
  processed in the last 7 days and adds up all of them per day. A day older
  than the oldest instance read is left alone, since an older instance may
  hold part of it; when no older instance exists (a new request), every day
  in the files is used. Revisions replace stored values.
- **History** starts with the request: `ONGOING` reports do not go back.
  A one-time snapshot backfill is a later step.
- **Downloads and checks.** Segment files are presigned links valid for 5
  minutes, downloaded right after listing, without the App Store Connect
  token. Each file is checked against Apple's MD5 `checksum`, inflated with
  a 64 MiB bound (gzip; the files are tab-separated despite their `.csv.gz`
  name, and comma-separated files are read too), and parsed. Any failure (a
  checksum mismatch, a host outside the allowlist, an unreadable file) skips
  that app's analytics for this sync and is logged without the link; sales
  and other apps continue. A rate limit postpones the remaining analytics to
  the next sync.
- **Cost.** About 20–40 requests per app and sync, depending on how many
  instances and segments there are.

### Segment host

The segment files are downloaded from Amazon S3. The egress allowlist
contains the bucket host exactly, never a wildcard such as
`*.amazonaws.com`:

| Host                                       | Recorded                                                                                                                                                                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asp-us-west-2.s3.us-west-2.amazonaws.com` | 2026-10-03, from production segment URLs (`/reports/<app id>/<report>/daily/ongoing/<date>/….csv.gz`) recorded by other integrations in Aug/Sep 2026. Apple's documentation only shows its QA bucket, `asp-qa-us-west-2.s3.us-west-2.amazonaws.com`. |

netrics has not yet seen a live response of its own; the exit gate (#176)
confirms the host against a real account and records the date here. If
Apple serves a segment from another host, that app's analytics fail with
"App Store analytics segment is hosted on …, which netrics does not allow",
and sales keep syncing.

## Currencies

Apple reports proceeds per row in a currency of proceeds, so one day
often has several currencies.
netrics keeps one amount per currency and never converts or adds up
different currencies; a tile shows one currency at a time.

## Configuration

| Setting       | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| Vendor number | The number in Payments and Financial Reports, under your legal entity name (digits only). |
| Apps          | The apps to collect, chosen from the apps of the key's team.                              |

The vendor number is not a secret, so it is part of the connection's
configuration, not of the key. A team with several vendor numbers (for
example after a legal-name change) uses one connection per vendor number.

Apps are identified by their numeric Apple ID, the same ID the sales
reports use. The platforms (iOS, macOS, tvOS, visionOS) are shown as a
label from the app's App Store versions; an app that never had a version is
listed as "app".

Connections of different teams can live side by side in one workspace, each
with its own key and vendor number.

## Metrics

All values come from Apple's daily Sales and Trends report (SALES,
SUMMARY, version `1_0`): one gzip file per vendor number and reporting day
that covers every app of the vendor. One request per day reads all selected
apps. Every metric is a daily sum per app (`resource` is the app's Apple
ID).

| Metric                                     | Unit             | Dimensions          | What it counts                                                                     |
| ------------------------------------------ | ---------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `app_store_connect.downloads`              | `downloads`      | resource            | First-time downloads: free, paid, bundle and custom apps                           |
| `app_store_connect.downloads_by_territory` | `downloads`      | resource, territory | First-time downloads for the 10 largest territories of the month, plus "Others"    |
| `app_store_connect.downloads_by_device`    | `downloads`      | resource, device    | First-time downloads per device (iPhone, iPad, Desktop, Apple TV, Apple Vision, …) |
| `app_store_connect.redownloads`            | `downloads`      | resource            | Downloads by people who had the app before                                         |
| `app_store_connect.updates`                | `updates`        | resource            | App updates                                                                        |
| `app_store_connect.iap_units`              | `purchases`      | resource            | In-app purchases and subscriptions, counted for their app                          |
| `app_store_connect.proceeds`               | `currency_minor` | resource, currency  | Units × developer proceeds, in each currency of proceeds                           |

How report rows become values:

- **Product types** decide the metric, following Apple's
  [product type identifiers](https://developer.apple.com/help/app-store-connect/reference/reporting/product-type-identifiers):
  first downloads `1`, `1-B`, `F1-B`, `1E`, `1EP`, `1EU`, `1F`, `1T`, `F1`;
  redownloads `3`, `3F`; updates `7`, `7F`, `7T`, `F7`; in-app purchases
  `IA1`, `IA1-M`, `FI1`, `IA9`, `IA9-M`, `IAY`, `IAY-M`. Restored purchases
  (`IA3`) are not counted. A type netrics does not know is counted in no
  metric and noted in the server log by its code.
- **Apps.** App rows belong to their `Apple Identifier`. An in-app purchase
  names its app by SKU (`Parent Identifier`); netrics matches it to the
  app's Apple ID from the same reports, or from the team's app list. Rows of
  apps you did not select are left out.
- **Refunds** are rows with negative units. They are included, so a day's
  value can be lower than its sales, or negative.
- **Proceeds** are units × developer proceeds per unit, summed per app, day
  and currency of proceeds, and stored as whole minor units of that
  currency (cents for USD, yen for JPY, which has no minor unit). Amounts in
  different currencies are separate series and are never added up; netrics
  does not convert currencies. Apple's own Sales and Trends view converts at
  a monthly average rate, so its totals differ.
- **Territories.** `downloads_by_territory` keeps the 10 territories with
  the most first-time downloads per app and calendar month, and adds up the
  rest as "Others", so a month has about 11 series per app. While a month is
  running its ranking can still change; a territory that drops out moves
  into "Others" for the days netrics reads again (and shows 0 on its own
  series for those days), so no download is counted twice. Devices are kept
  whole.

### Reporting days and latency

- Reporting days are **Pacific Time**. A value for Apple's day D is stored at
  D 00:00 UTC, whatever your workspace's time zone, so "yesterday" in a tile
  can be a day Apple has not reported yet.
- Apple publishes day D the next morning (generally by 8 a.m. Pacific Time).
  netrics expects D from 12:00 Pacific Time on D + 1. Until then, a missing
  report means "not published yet": netrics keeps its place and asks again
  on the next sync. After that, a missing report means the day had no sales,
  and netrics stores zeros for it.
- Every sync reads the last 3 reporting days again, so Apple's corrections
  replace the stored values instead of adding to them.
- The first sync goes back **365 days**, Apple's retention for daily
  reports. It reads one calendar month per step (one request per day), about
  365 requests in all: roughly a tenth of the key's hourly budget. Later
  syncs read the current month up to the latest day (at most about 31
  requests), because the territory ranking needs the whole month.

## Limits

Apple allows about 3,500 requests per key and rolling hour, and reports the
rest in the `X-Rate-Limit` header. netrics stops a sync when fewer than 100
requests are left, and retries later; a 429 or a server error from Apple is
retried the same way. The limit belongs to the key, not to the connection:
connections (or other tools) that share one key share Apple's budget, so
give netrics its own key.

## When something goes wrong

| What you see                                                                           | What to do                                                                                                |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "the issuer ID, key ID and private key do not belong together, or the key was revoked" | Check the three values, or create a new team key and upload it.                                           |
| "This key cannot read sales reports"                                                   | The key's role lacks sales access. Create a team key with the Sales role (roles cannot be changed later). |
| "App Store Connect does not know vendor number …"                                      | Copy the vendor number from Payments and Financial Reports.                                               |
| "requires an agreement that is missing or has expired"                                 | The Account Holder accepts the latest agreements in App Store Connect (Business).                         |
| "Upload a new App Store Connect key"                                                   | The key was revoked or its access removed after connecting. Upload a new key on the connection page.      |
| "hourly request limit" / "not answering"                                               | Nothing: netrics retries automatically.                                                                   |
| "This key cannot request App Store analytics"                                          | Enabling analytics needs a team key with the Admin role, once. Use a temporary one and revoke it after.   |
| "App Store analytics paused — enable again"                                            | Apple stopped the report request. Enable App Store analytics again with a temporary Admin key.            |

## Network access

The connector only talks to `api.appstoreconnect.apple.com` and the
analytics segment bucket `asp-us-west-2.s3.us-west-2.amazonaws.com` (see
[Segment host](#segment-host)). Token signing is done by the netrics server,
not by connector code; the App Store Connect token is never sent to the
bucket. The one-time analytics step runs on the server, also only against
`api.appstoreconnect.apple.com`.
