# Google Search Console connector

Reads clicks, impressions, click-through rate and average position in Google
Search from [Google Search Console](https://search.google.com/search-console/about)
for one property per connection.

## Connect

You authorize netrics at Google; there is no token to paste
([ADR 0012](../decisions/0012-oauth-authorization-code-platform.md)).

- netrics asks only for read-only Search Console access
  (`https://www.googleapis.com/auth/webmasters.readonly`), plus your Google
  account's email address so the connection can show which account it uses.
- After you authorize, choose the property to read. Both kinds of property
  work: URL-prefix properties (`https://example.com/`) and domain properties
  (`sc-domain:example.com`). Properties you have not verified, or that are
  only listed for your account without access, are not offered.
- On a self-hosted instance an administrator registers a Google OAuth app
  first. Until then the connector is listed as unavailable.

netrics never sees your Google password. The refresh token is stored
encrypted (AES-GCM, bound to the connection); the connector itself only
receives a short-lived access token.

## Configuration

| Setting      | Meaning                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| Property     | The Search Console property (`siteUrl`), e.g. `https://example.com/` or `sc-domain:example.com`.      |
| Breakdown    | Optional: none, or one or two of page, query, country and device (`dimensions`, e.g. `query,device`). |
| Rows per day | How many breakdown rows to keep per day, highest clicks first: 1 to 5,000 (default 1,000).            |

A breakdown with more than two dimensions, or more than 5,000 rows per day,
is rejected. The daily totals are always collected; the breakdown is extra.

## What is collected

Every value is daily, dated by Search Console's reporting day (Search Console
reports in Pacific Time; netrics stores the date as reported), for web search
results.

| Metric                    | Meaning                                                    |
| ------------------------- | ---------------------------------------------------------- |
| Clicks                    | Clicks from Google Search results                          |
| Impressions               | Times a page of the property appeared in results           |
| Click-through rate        | Clicks ÷ impressions for that day (0–1)                    |
| Average position          | Average topmost position in results for that day (1 = top) |
| Position sum              | Average position × impressions (for weighted averages)     |
| Clicks by breakdown       | Clicks per day for each breakdown row                      |
| Impressions by breakdown  | Impressions per day for each breakdown row                 |
| Position sum by breakdown | Average position × impressions per breakdown row           |

Breakdown rows carry the dimensions `page` (URL), `query` (search text),
`country` (ISO 3166-1 alpha-3, lower case, e.g. `usa`) and `device`
(`DESKTOP`, `MOBILE`, `TABLET`), as Search Console reports them.

### Rates and averages over several days

Clicks and impressions add up over days and rows. Click-through rate and
average position do not:

- The click-through rate of a week is the week's clicks divided by its
  impressions, not the average of seven daily rates.
- The average position of a week is weighted by impressions: the sum of
  "Position sum" divided by the sum of impressions.

So click-through rate and average position are stored as daily readings
(tiles show the latest day, or the lowest or highest day) and are never
summed or plainly averaged. The weighted values over any period come with
derived metrics (milestone 10), which divide clicks by impressions and
position sum by impressions. Breakdowns store only values that add up
(clicks, impressions, position sum); a rate or position per page, query,
country or device is derived the same way.

### Why breakdowns add up to less than the totals

- Search Console hides rare queries to protect searchers' privacy
  ("anonymized queries"). Totals include them, a breakdown by query does not.
- Only the configured number of rows per day is kept (highest clicks first);
  the long tail is left out.
- Totals are counted per property, breakdowns by page are counted per page
  (Search Console's aggregation), so impressions by page can differ from the
  property's impressions.

## History, latency and refresh

- The first sync reads 16 months back, as far as Search Console keeps data.
- Search Console publishes final data about 2–3 days after the day ends.
  netrics reads final data only (`dataState: final`): a stored value does not
  shrink or jump later, and the newest two or three days appear only once
  Google has finalized them. Today and yesterday are therefore usually empty.
- Afterwards the connection syncs every 6 hours and re-reads the last 5
  days, so each day is picked up when Google finalizes it. A changed value
  replaces the stored one.

## Limits and quotas

- At most two dimensions besides date per breakdown, and at most 5,000 rows
  per day; each day's rows are fetched in pages of 2,500 (`startRow`).
- Search Console allows about 1,200 queries per minute per property and
  user. When Google answers with a quota error (429, or 403 with a rate-limit
  reason), netrics waits briefly and retries; a longer wait or the daily
  quota ends the sync, which is retried later. The dashboard keeps the last
  values meanwhile.

## When something goes wrong

| What you see                                               | What to do                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| "Choose a Search Console property to finish setup"         | Pick the property for this connection.                                                                                            |
| "The connected Google account has no verified access to …" | Ask an owner of the property to add the account in Search Console (Settings → Users and permissions), or choose another property. |
| "Search Console refused access to …"                       | The account lost access to the property. Restore the permission in Search Console, or choose another property.                    |
| "Reconnect Google"                                         | The authorization was revoked or expired. Reconnect Google from the connection.                                                   |
| "quota is used up" / "not answering"                       | Nothing: netrics retries automatically.                                                                                           |

## Network access

The connector only talks to `searchconsole.googleapis.com`. Token refresh and
revocation are done by the netrics server, not by connector code.
