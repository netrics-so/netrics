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
pages resume through host execution budgets. The first read downloads and parses whole provider files; the normal 10 MiB
buffered HTTP limit and a 64 MiB archive inflation safeguard still apply. ZIP64
archives are rejected explicitly.

The worker durably stages parsed report sets as per-app transport pages. A
continuation reads only its required page, including after a worker/connector
restart, while the pinned stage remains available. Earnings archives are shared
across the selected apps in that report task. Every continuation still lists
current metadata and re-authorizes exact object generations through metadata-only
GETs; it does not reuse cached private data after object access is withdrawn.
Changed generations, app/configuration scope or parser versions use a new stage
and restart the pending app partition.

Staging lasts at most 24 hours, shortened by source/workspace retention, and reads
never renew it. Missing or expired staging causes a real provider re-read and
restarts the incomplete partition. Resumed publication keeps the original source
collection time and retention deadline. Atomic staging publication, digest checks,
forced RLS and connection-scoped access apply; temporary bytes count toward the
separate workspace connector-cache admission budget until the stage expires.
`maxConnectorStagingBytes` defaults to 128 MiB in aggregate; `0` refuses new
stages and `null` removes the aggregate ceiling. Lowering it does not evict
already admitted live stages. Raw pages and records count toward
`maxWorkspaceBytes`; total raw, staging and prepared storage can exceed that raw
cap. If the host refuses a stage (size, quota or storage error), the report task
stays buffered through its remaining app/page continuations. A rebuilt stage
restarts only the pending app partition; apps already
completed in the task are not emitted again. A stage is bounded to 128 MiB of serialized JSONB and
metadata to 1 MiB, with the normal per-page/record transport limits. The scheduler
prunes expired pages in batches. See [ADR 0023](../decisions/0023-connector-dataset-staging.md).

The persisted fixture in `apps/server/src/sync/staging.test.ts` covers 20,001
install rows from a 1,698,034-byte UTF-16 provider report, two selected apps and
earnings/adjustment archives. Fresh connector instances on every turn return 24
parsed pages with exactly four media downloads, one per provider object. The
local run on 2026-11-05 took about 2.1 seconds and retained 10,197,736 staged JSONB
bytes. RSS samples rose from about 209 MiB to 410 MiB; these are process samples,
not isolated peak allocation measurements. This verifies bounded restart/reuse
behavior, not production capacity or concurrent customer load. The test also
covers corrections, cache expiry, object permission loss, quota, cancellation,
retention, tenant isolation and cleanup.

Large-report streaming and warehouse-scale load acceptance remain open; uncapped
storage policy does not imply unbounded file or query processing. Raw generation
publication currently copies retained records.

Editable portfolio templates, confirmed Apple/Google identity mappings and
provider status beside every dependent dashboard widget are separate 11E work;
this connector alone does not complete that customer journey.
