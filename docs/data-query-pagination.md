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
remove or change groups halfway through that session. Repeating a token returns
the same page while its inputs remain available. The last page has no
`nextPageToken`. `totalRows` and `offset` retain their ordinary meanings.

Every continuation requires current workspace query authorization. The session
is bound to its workspace, model, release and query inputs, including the entire
effective filter. Server-added fixed scope must remain part of that filter.
A token cannot be used to change measures, grouping, filters or page size.
Draft previews do not support pinned paging.

The session stores generation identities, without copying result/source rows.
Each page reauthorizes and evaluates those inputs under the current execution
policy. Removing a source, expiring retained records, deleting a pinned prepared
cache or removing the session causes an explicit failure. Resource catalogs and
legacy observations have fingerprints rather than retained historical rows;
changes to those adapters also cause a continuation to fail. The server never
silently restarts against current data or falls back to another vector. After
an unavailable/expired session, a caller may explicitly start a new query and
replace its displayed pages.

Session expiry is the earliest of the configured query-snapshot lifetime,
retained input expiry and pinned prepared-cache expiry. Following a token does
not renew that deadline. Shortening the current snapshot lifetime applies to
existing sessions on read. Retention changes can invalidate sessions immediately.

Page sessions share `querySnapshotCount` capacity with last-valid query snapshots.
The server preserves existing sessions when capacity is full. A new pinned
request then returns its ordinary first result with
`immutable_pagination_unavailable` and no token. Pending/incomplete inputs and
last-valid fallback results also cannot start a session. Setting
`querySnapshotCount` or `querySnapshotSeconds` to `0` disables storing and reusing
query snapshots, including last-valid fallback. Other data/execution quotas
remain positive or `null`.

Ordinary queries do not allocate page sessions. Existing `limit`/`offset`
callers continue to read current generations per request. Pinning pages bounds
consistency and transport; it does not provide streaming execution or reduce
the executor's full-input memory use. The wider scale and real-account acceptance
work in milestone 11 remains open.
