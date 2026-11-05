# Google Play connector

One Google authorization connects multiple Android apps. netrics retains typed
report rows and original provider columns for editable preparations and measures.
This connector supplies datasets, rather than legacy observation metrics.

## Connect and choose apps

1. Choose Google Play in Sources and sign in with the Google account that can
   read your Play Console reports. A self-hosted operator first configures the
   [Google OAuth client](../../deploy/compose/google-oauth.md).
2. Copy your private report bucket URI from the Play Console report downloads
   into Report URI. Both `gs://pubsite_prod_rev_…` and `gs://pubsite_prod_…`
   bucket names are accepted; a pasted path is ignored.
3. Choose the rating country (US by default). Advanced settings include listing
   language, an optional earliest import date, and package names for apps not
   automatically discovered.
4. Choose **Check access and find apps**. This uses the stored authorization;
   it does not save settings or import reports. Partial financial/statistics
   permissions are shown explicitly.
5. Follow all current and future apps, or choose a searchable app list. Save
   settings and selection together to start the first import. Later changes
   use the same credentials. An empty selection stops new app data collection;
   it does not delete retained history or revoke the Google grant.

The connector receives only a short-lived access token. It asks for read-only
Cloud Storage and Play Developer Reporting access, plus the host's identity
scopes. Reporting API discovery supplies names; report package IDs and optional
manual package names cover apps missing from that listing. Private app names
are never cached across connections.

## Data and interpretation

| Dataset         | Retained data                                                                                 | Suggested use                                                            |
| --------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `install_rows`  | App/day/country, daily user and device installs, original columns                             | Sum the chosen install field over a reporting period                     |
| `earning_rows`  | Signed merchant amount/currency, transaction type/day, billing report month, original columns | Sum all signed merchant amounts by app and currency                      |
| `store_ratings` | App/country/language/default form factor/day snapshot, score/count, availability              | Latest scoped score and count per app                                    |
| `report_status` | App/report type/month, availability, checked time, object names and unmapped row count        | Distinguish missing, inaccessible and invalid reports from zero activity |

Provider reporting details are described in Google's
[downloadable report reference](https://support.google.com/googleplay/android-developer/answer/6135870?hl=en).
Installs come from country reports. Financial rows retain charges, fees, taxes,
refunds and adjustments, including additional adjustment archives. Their dates
are Pacific reporting dates; billing month is a separate replacement key.
Reports arrive after the activity they describe; earnings are monthly, not live.

The net amount is a report-derived merchant amount, not a bank payout or gross
sales. Currencies remain separate. Rows with no identifiable package remain in
an explicit account-level `__unmapped` partition when following all apps; they
are never distributed across apps. A chosen-app import reports the omitted
unmapped count. Blank install values remain null, not zero. Aggregates with
some missing inputs expose a partial status; an explicit preparation filter
can deliberately exclude those inputs.

Ratings use the public Play listing's structured data, without authentication,
for the configured country/language and its default form factor. This is a
best-effort public presentation source, **not a documented aggregate-rating
API**. A site change, blocking response or incomplete listing yields missing
availability. There is no fallback to written-review averages or a different
country. Historical snapshots start when connected. Scores cannot be added or
averaged across apps, days or stores into an overall store score. Google's
[rating explanation](https://support.google.com/googleplay/android-developer/answer/138230?hl=en)
describes how the published rating differs from a lifetime average.

## Refresh, correction and retention

The default first import requests one year. An optional earliest date can
request older available reports; provider availability still applies. Syncs run
every six hours and revisit recent reporting windows and recently changed old
objects. Continuation cursors pin the import window and object generation;
changed content restarts the pending partition. An app/report-month replacement
publishes only after every page is committed. A missing, inaccessible or corrupt
report updates status and keeps previously published records.

Retained rows default to until deleted, subject to configurable workspace or
installation retention. Earnings original columns may contain order identifiers
and postal data, so that JSON field is classified personal. Losing Google
authorization pauses future ingestion; it does not remove workspace history.

## Current implementation boundaries

There is no fixed app or retained-history count. Account discovery and dataset
pages resume through host execution budgets. The current parser downloads and
parses whole provider files; SDK HTTP response limits and a 64 MiB archive
inflation safeguard still apply. ZIP64 archives are rejected explicitly.
Monthly files may be downloaded again while paging. Large-report streaming and
warehouse-scale load acceptance remain open; uncapped storage policy does not
imply unbounded file or query processing. Raw generation publication currently
copies retained records.

Editable portfolio templates, confirmed Apple/Google identity mappings and
provider status beside every dependent dashboard widget are separate 11E work;
this connector alone does not complete that customer journey.
