# Pinned semantic result pages

`POST /v1/workspaces/:workspaceId/data/models/:modelId/query` supports an
explicit immutable page session. Start with the normal measure, grouping and
filter inputs, a page size, and `pinPages: true`:

```json
{
  "measureIds": ["revenue"],
  "groupBy": ["campaign"],
  "limit": 100,
  "pinPages": true
}
```

When further rows exist and a session can be retained, the response includes
`nextPageToken` and `pageExpiresAt`. Repeat the same measure IDs, grouping,
filter and page size with that token. Omit `offset`; `pinPages` need not be
repeated. Treat tokens as opaque strings.

```json
{
  "measureIds": ["revenue"],
  "groupBy": ["campaign"],
  "limit": 100,
  "pageToken": "<nextPageToken from the preceding response>"
}
```

Continuations evaluate the original model release, pinned preparation definitions
and source generations. A later correction or model publication cannot insert,
remove or change groups halfway through that session. This includes the
lookback rows of rolling and period-offset measures: a correction dated before
the requested range changes new queries, not an open session. Lookback rows
never add result rows, so they do not change `totalRows` or the page count. Repeating a token returns
the same page while its inputs remain available. The last page has no
`nextPageToken`. `totalRows` and `offset` retain their ordinary meanings.

Every continuation requires current workspace query authorization. The session
is bound to its authenticated caller, workspace, model, release and query inputs,
including the entire effective filter. Server-added fixed scope must remain part of that filter.
A token cannot be used to change measures, grouping, filters or page size.
Draft previews do not support pinned paging. The data API takes caller identity
from the authenticated domain user, never a request-body owner or bearer-token
string. Tabs, browser sessions and renewed login credentials for the same user
share the same caller limit. Another workspace member cannot continue that user's
token. Internal calls without an authenticated page owner cannot request pinned
paging; ordinary dashboard and device queries remain unchanged.

The session stores generation identities, without copying result/source rows.
Each page reauthorizes and evaluates those inputs under the current execution
policy. Removing a source, expiring retained records, deleting a pinned prepared
cache or removing the session causes an explicit failure. Resource catalogs and
legacy observations have fingerprints rather than retained historical rows;
changes to those adapters also cause a continuation to fail. The server never
silently restarts against current data or falls back to another vector. After
an unavailable/expired session, a caller may explicitly start a new query and
replace its displayed pages. Every such continuation failure returns `409
data_page_unavailable`; the new query reports the underlying cause.

Session expiry is the earliest of the configured query-snapshot lifetime,
retained input expiry and pinned prepared-cache expiry. Following a token does
not renew that deadline. Shortening the current snapshot lifetime applies to
existing sessions on read. Retention changes can invalidate sessions immediately.

Page sessions and last-valid query snapshots have separate aggregate
`querySnapshotCount` capacities per workspace/model release, each defaulting to
100 identities. These remain aggregate limits across all callers. Setting the
caller limit to `null` does not remove the aggregate session limit.

`queryPageSessionsPerCaller` additionally limits new page sessions for one
authenticated caller within that release, defaulting to 10. A busy caller cannot
consume the entire default 100-session pool alone. This is an admission limit,
not a reservation of slots: several callers can still fill the aggregate pool,
and a global capacity of one cannot guarantee another caller a slot. Lowering a
positive caller limit preserves already admitted continuations and their
original deadlines. `null` removes only the caller admission limit; `0` disables
starting and continuing pinned pages. Neither setting disables ordinary queries
or their last-valid fallback snapshots.

Existing sessions are preserved when either admission limit is full. A new
pinned request then returns its ordinary first result with
`immutable_pagination_unavailable` and no token. Requests with `pinPages: true`
never create or update ordinary last-valid fallback entries, including when
session admission is refused. They may read an existing fallback after an
evaluation failure, but that stale result cannot start a page session. Pending
or incomplete inputs also cannot start a session. Every loaded prepared output
needs a retained cache identity; a prepared-cache refusal prevents admission.
Expired snapshot identities free capacity on the next successful query without
waiting for scheduled maintenance.

New pinned requests for one release are admitted one at a time, so concurrent
first pages never fail with `409 version_conflict` because of each other. A
request that keeps losing the admission race to other new sessions (a burst of
first pages) is retried a few times and then answered like a full pool: its
ordinary first result with `immutable_pagination_unavailable` and no token.

Setting `querySnapshotCount` or `querySnapshotSeconds` to `0` disables storing
and reusing both query snapshot pools, including last-valid fallback. Other
data/execution quotas remain positive or `null`.

Caller-bound session keys use a new private namespace in the existing snapshot
table; no SQL schema migration is required. Tokens created before this change
return `409 data_page_unavailable`; start a fresh pinned query. The next successful
new query removes known legacy unowned page identities for its workspace/release,
so they cannot keep occupying session capacity. Ordinary fallback entries and
current caller-bound sessions are preserved.

Ordinary queries do not allocate page sessions. Existing `limit`/`offset`
callers continue to read current generations per request. Pinning pages bounds
consistency and transport; it does not provide streaming execution or reduce
the executor's full-input memory use. The wider scale and real-account acceptance
work in milestone 11 remains open.
