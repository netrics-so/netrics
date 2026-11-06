# Build a campaign dashboard from advertising and website data

Combine advertising costs and website revenue through confirmed campaign identities,
then share campaign, market and day filters across a dashboard. This example uses
synthetic CSV imports and the normal data preparation/model tools. It does not
require app-store data or add an advertising-service connector.

The example deliberately includes several ad rows and website rows for the same
campaign/day, different campaign IDs in each source, and two unmapped campaigns.
The correct Spring launch result is **30.00 EUR spend, 150.00 EUR revenue and
120.00 EUR contribution**. Joining the two fact tables directly would duplicate
values; relate them to shared dimensions and aggregate each fact independently.

## Import the example tables

Open **Data & measures → Enter reference data**. For each file, expand **Paste CSV
or a tab-separated table**, paste its contents and choose **Import table**. Set
column types and the unique key before saving. Text columns remain text, including
campaign IDs and the EUR currency code. These tables use **Until deleted** for
this example; your installation/workspace retention policy still applies.

| Table name                 | CSV                                                     | Unique key  | Type changes                                                            |
| -------------------------- | ------------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| Campaigns                  | [campaigns.csv](./campaign-dashboard/campaigns.csv)     | Campaign ID | None                                                                    |
| Confirmed campaign mapping | [mapping.csv](./campaign-dashboard/mapping.csv)         | Source key  | None                                                                    |
| Advertising rows           | [advertising.csv](./campaign-dashboard/advertising.csv) | Row ID      | Day: Date; Spend: Exact decimal                                         |
| Website campaign rows      | [website.csv](./campaign-dashboard/website.csv)         | Row ID      | Day: Date; Visits and Conversions: Whole number; Revenue: Exact decimal |
| Reporting days             | [days.csv](./campaign-dashboard/days.csv)               | Day         | Day: Date                                                               |
| Currencies                 | [currencies.csv](./campaign-dashboard/currencies.csv)   | Currency    | None                                                                    |

Open **Column options** for Spend and Revenue and choose **Currency** as the
currency column. This declares currency amounts and requires a non-missing currency
identity. Set **Decimal places (optional)** to 2 to enforce at most two fractional
digits. Keep both amounts as exact decimal values; avoid floating-point types for
money. This example uses EUR throughout. Importing another currency requires a
matching Currencies row and compatible source metadata; grouping by currency keeps
totals separate and does not perform exchange-rate conversion.

Column IDs are assigned by the editor. Use field-name insertion in formulas and
choose columns from the dropdowns; do not copy internal IDs from a test fixture.
Renaming a display name preserves the underlying field identity.

The mapping links `search-42`, `social-99` and `spring-landing` to `launch` only
because the customer confirms those identities. The `ads:` and `web:` prefixes
keep identical source IDs from different systems separate. Names do not create
links. The unmapped source campaigns remain visible until they are explicitly
assigned.

## Prepare advertising and website rows

Select Advertising rows and choose **Prepare this data**. Add the following steps,
preview each one, then save and publish as **Advertising campaigns**. The readable
formulas below use the displayed column names; insert fields from the form when
names include a prefix.

1. **Calculate a column** named Source key:
   `CONCAT("ads:", [Source campaign])`.
2. **Merge columns** from Confirmed campaign mapping on Source key. Set **Rows to keep** to
   **All rows in this data** and **Expected matches** to
   **One match per source row**. Set **Prefix for merged column names** to
   `Mapping / `. This retains rows without a mapping and gives the joined
   Campaign ID a recognizable name.
3. **Calculate a column** named Campaign ID:
   `COALESCE([Mapping / Campaign ID], [Source key])`.
4. **Merge columns** from Campaigns on Campaign ID with the same row/match choices. Set the
   merged-column name prefix to `Campaign / `.
5. **Calculate a column** named Campaign name:
   `COALESCE([Campaign / Campaign name], CONCAT("Unmapped ads · ", [Source campaign]))`.
6. **Calculate a column** named Market:
   `COALESCE([Campaign / Market], "Unassigned")`.

Create **Website campaigns** from Website campaign rows with the same steps,
using `"web:"` in Source key and `"Unmapped web · "` in the fallback name. Add one
more calculated column, **Has conversions**, with `[Conversions] > 0`.

A failed many-to-one join means the reference side contains duplicate keys. Fix
the mapping; changing the join to duplicate rows would inflate totals. Retain the
original columns, including spend/revenue and their Currency column, in both
published outputs.

## Build shared dimensions

Create a short preparation from Advertising campaigns using **Choose columns** to retain only
Campaign ID, Campaign name and Market. Publish it as **Advertising campaign
identities**. Do the same for Website campaigns and publish **Website campaign
identities**. The three corresponding columns must have matching types.

Prepare Advertising campaign identities and choose **Append rows** with Website campaign identities.
Under **Match columns**, explicitly match the website Campaign ID, Campaign name
and Market to the corresponding advertising columns. Independently created columns
have different internal IDs, even when their displayed names agree. Confirm all
three matches in the preview, then **Remove duplicates** on Campaign ID and publish as
**Shared campaign identities**.
Every confirmed ID must have one consistent name and market. This dimension also
includes fallback identities such as `ads:new-77` and `web:unknown-77`, so unmapped
and future campaigns remain recognizable.

Create a model named **Campaign performance** with Advertising campaigns, Website
campaigns, Shared campaign identities, Reporting days and Currencies. Add these
single-direction **many-to-one** relationships:

| From                                | To                                       |
| ----------------------------------- | ---------------------------------------- |
| Advertising campaigns → Campaign ID | Shared campaign identities → Campaign ID |
| Website campaigns → Campaign ID     | Shared campaign identities → Campaign ID |
| Advertising campaigns → Day         | Reporting days → Day                     |
| Website campaigns → Day             | Reporting days → Day                     |
| Advertising campaigns → Currency    | Currencies → Currency                    |
| Website campaigns → Currency        | Currencies → Currency                    |

Add dimensions:

- **Campaign:** Shared campaign identities → Campaign ID; use Campaign name as
  its display-name column.
- **Campaign market:** Shared campaign identities → Market.
- **Day:** Reporting days → Day. Choosing a Date column automatically uses
  reporting-date alignment.
- **Currency:** Currencies → Currency.

Then add reusable measures. Choose **Aggregate a column** for the aggregate rows
and **Calculate from measures** for the calculation rows:

| Measure                  | Definition                                   |
| ------------------------ | -------------------------------------------- |
| Ad spend                 | Sum Advertising campaigns → Spend            |
| Website revenue          | Sum Website campaigns → Revenue              |
| Visits                   | Sum Website campaigns → Visits               |
| Conversions              | Sum Website campaigns → Conversions          |
| Has conversions          | Any true Website campaigns → Has conversions |
| Contribution             | `[Website revenue] - [Ad spend]`             |
| Revenue / ad spend       | `[Website revenue] / [Ad spend]`             |
| Revenue exceeds ad spend | `[Contribution] > ([Ad spend] * 0)`          |

The zero in the last formula takes the currency context from Ad spend. It is a
boolean measure, rather than formatted text. Missing revenue or spend remains
missing; the example does not assume that no matching rows means zero activity.
Division by zero also stays missing with a warning.

Preview by Campaign and Currency before publishing. The expected rows include:

| Campaign                  | Spend     | Revenue    | Contribution | Revenue / ad spend | Visits  | Has conversions |
| ------------------------- | --------- | ---------- | ------------ | ------------------ | ------- | --------------- |
| Spring launch             | 30.00 EUR | 150.00 EUR | 120.00 EUR   | 5                  | 150     | True            |
| Brand                     | 8.00 EUR  | 0.00 EUR   | −8.00 EUR    | 0                  | 20      | False           |
| Unmapped ads · new-77     | 2.00 EUR  | Missing    | Missing      | Missing            | Missing | Missing         |
| Unmapped web · unknown-77 | Missing   | 12.50 EUR  | Missing      | Missing            | 10      | True            |

## Create and filter the dashboard

Create a blank dashboard in Studio. Add a **Measure** table bound to Campaign
performance, grouped by Campaign and Currency, with Ad spend, Website revenue,
Contribution, Revenue / ad spend, Visits and Has conversions. Add a value widget
for Revenue exceeds ad spend.

Add three shared filters and map each to the corresponding model dimension:
Campaign and Campaign market as text choices, and Day as a date range. Start with
All values. The same choices apply to the table and boolean widget.

Select Spring launch, Campaign market EU and Day from **2026-11-01** through
**2026-11-01**. Expected values are **20.00 EUR spend, 100.00 EUR revenue,
80.00 EUR contribution, ratio 5 and 100 visits**. Date bounds are inclusive.

Duplicate the dashboard for a Spring launch screen. In its Campaign filter, set
**Fixed scope** to Spring launch. Viewer choices intersect this scope. Choosing
Brand cannot broaden the screen to another campaign; it produces no matching
rows. Fixed scope also applies to the server-calculated results sent to devices.

## Check corrections and reusable publication

Edit Website campaign rows. Change row `w3` Revenue from `50.00` to `60.10` and
save. The reference editor publishes a complete new snapshot after every upload
page is accepted. Spring launch becomes **160.10 EUR revenue and 130.10 EUR
contribution**, without republishing the model. Source-generation changes
invalidate dependent prepared/query results.

Edit the model's Contribution formula to
`[Website revenue] - ([Ad spend] * 2)`. Save the draft and check both dashboards:
they still use **130.10 EUR**. Preview the draft, then publish the model. Both
dashboards now show **100.10 EUR**. Model publication is shared; editing one widget
is not necessary.

For a preparation-definition change, published models keep their pinned
preparation versions. Publish the preparation, then open the dependent model,
preview its updated inputs and choose **Publish updated inputs** to adopt the
changed definition. Source-data corrections use newer compatible generations
without that extra definition publication.

## Reject unsupported detail

Advertising rows include Keyword, but Website campaign rows do not attribute
revenue to individual keywords. To check the restriction, add an optional
**Advertising keyword** dimension from Advertising campaigns → Keyword. Preview
Ad spend grouped by Advertising keyword: the shoes row is **20.10 EUR**. Then
request Website revenue or Contribution with that grouping or a keyword filter.
The preview must fail as an incompatible dimension. Do not copy a campaign's
revenue into every keyword or invent an allocation rule.

Likewise, joining Advertising campaigns directly to Website campaigns on Campaign
ID fails the declared many-to-one cardinality check because several website rows
match each campaign. Add relationships to the shared dimensions instead. Two
competing relationship paths to a dimension are ambiguous and are rejected.

The integration proof is
[apps/server/src/data/campaign-workflow.test.ts](../../apps/server/src/data/campaign-workflow.test.ts).
It runs the persisted import, preparation, model and dashboard services under the
workspace application role, with correction/retry, publication and isolation
checks. The synthetic files demonstrate the architecture through existing import
controls; scheduled ingestion from a real advertising or website account remains
a connector-specific capability and acceptance task.
