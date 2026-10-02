# 0012 — OAuth authorization-code platform for connectors

Status: accepted (2026-10-02, milestone 07)

## Context

Google Search Console (milestone 07) is the first connector whose user
authorizes netrics at the provider instead of pasting a token. Later
connectors will do the same, so the flow is built once, in the host.

Product rules:

- On the hosted service every integration connects in a few clicks through an
  OAuth app that netrics owns. Users never register an app at the provider.
- A self-hosted administrator registers their own OAuth app per provider.
  The same image must work for both: nothing is decided at build time.
- Where a provider has no OAuth for the data (Vercel Web Analytics, App Store
  Connect keys, Apple Ads), the token or key path stays, with guided setup.

Existing ground: credentials are AES-256-GCM envelopes bound to their
workspace and connection (`apps/server/src/credentials.ts`); connector code
reaches the network only through `runtime.fetch` and the manifest's
`outboundDomains`; the browser talks only to the web origin, which proxies
`/v1/*` to the API (ADR 0005); the job queue runs at most one job per
connection at a time (ADR 0006), but API requests (preview, discovery,
checks) can run beside a job.

## Decision

**Providers and connectors are separate.** A _provider definition_ is
trusted host code in `apps/server/src/oauth/providers/`: authorization,
token and revocation endpoints, PKCE and OpenID Connect support, extra
authorization parameters, and how to read the linked account. Google is the
first:

- authorization `https://accounts.google.com/o/oauth2/v2/auth` with
  `access_type=offline`, `prompt=consent` (so every grant returns a refresh
  token) and `include_granted_scopes=true`;
- token `https://oauth2.googleapis.com/token`, revocation
  `https://oauth2.googleapis.com/revoke`;
- identity scopes `openid` and `https://www.googleapis.com/auth/userinfo.email`.

A _connector_ only names a provider and the scopes it needs, through a new
auth strategy in its manifest:
`{ strategy: "oauth2", provider: "google", scopes: [...] }`. Search Console
asks for `https://www.googleapis.com/auth/webmasters.readonly` and nothing
else. The change is additive: `SDK_VERSION` becomes 0.2.1 and existing
`^0.2.0` connectors keep loading. Community connectors (milestone 11) can use
a provider but never define one, so endpoints and client secrets stay out of
connector code.

**Instance configuration from the environment.** Each provider is configured
by `NETRICS_OAUTH_<PROVIDER>_CLIENT_ID` and
`NETRICS_OAUTH_<PROVIDER>_CLIENT_SECRET` (Google:
`NETRICS_OAUTH_GOOGLE_CLIENT_ID`, `NETRICS_OAUTH_GOOGLE_CLIENT_SECRET`), both
or neither. The redirect URI is derived, never taken from a request:
`<WEB_ORIGIN>/oauth/<provider>/callback`. The API logs at startup which
providers are configured and their redirect URIs (never the secret). A
connector whose provider is not configured is listed in the marketplace as
unavailable, with a note for administrators and a link to the setup guide;
creating a connection with it is refused. An admin UI for provider settings
is not part of this decision; the environment is the instance setting.

**Starting an authorization.** `POST
/v1/workspaces/:id/oauth/authorizations` (role: `connections:create` for a
new connection, `connections:update` to reauthorize) takes the connector,
optionally the connection to reauthorize, and a return path. It writes an
`oauth_authorizations` row, a workspace table under RLS:

- user, workspace, provider, connector, target connection (null for a new
  connection), purpose (`connect` or `reauthorize`), whether a different
  account is allowed, return path (a relative path inside the web app,
  validated against an allowlist of app routes);
- the SHA-256 of the `state` (256 random bits), the OpenID `nonce`, and the
  PKCE verifier (S256), the verifier sealed in a credential envelope bound to
  the row;
- `expires_at` (10 minutes) and `consumed_at`.

It returns the authorization URL, and the browser navigates there. The start
is a JSON call, not a form post, because the web app's CSP `form-action
'self'` would block a form redirect to Google.

**Callback.** Google redirects to the web app,
`/oauth/<provider>/callback`. That route is a thin server-side handler: it
forwards the query (`state`, `code`, or `error`) with the session cookie to
`POST /v1/oauth/:provider/callback` on the API (through `NETRICS_API_URL`,
like the `/v1` proxy), then answers 303 to the relative path the API returns.
The page sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
The code is exchanged by the API; tokens never reach the web server's
responses or the browser. This works unchanged if the web frontend moves to
Vercel (#123), because it only needs the API URL the proxy already uses.

The API validates in this order and fails closed:

1. The state is looked up by hash and consumed in one statement by a
   SECURITY DEFINER function (the pattern of `resolve_principal_token`, ADR
   0009), because the callback does not know the workspace yet. Unknown,
   expired or already consumed states fail: replays get nothing.
2. The signed-in user must be the user who started it, and must still hold
   the role in that workspace. A callback opened in another user's session
   is refused (login CSRF).
3. `error=access_denied` (or any `error`) ends the flow with nothing stored;
   a reauthorization leaves the connection as it was. The user returns to the
   start page with a message.
4. The code is exchanged with the verifier. The ID token comes straight from
   the token endpoint over TLS; its `iss`, `aud` (our client id), `nonce` and
   expiry are checked, and `sub` and `email` are read from it.
5. The granted scopes must include every scope the connector requires.
   Google lets users untick scopes; a partial grant is refused and revoked.
6. For a reauthorization the target connection must still exist in the
   state's workspace with the same connector, and the Google `sub` must match
   the linked account unless the user chose "use a different Google account"
   when starting. Credentials can therefore only land on the connection and
   workspace bound into the state.

A new connection is created by the callback in a _setup_ state: it holds the
grant but no property yet, is not scheduled, and the web app shows "Finish
setup" until a property is chosen. This keeps all secrets on the connection
row they are bound to, with no pending grant elsewhere.

**Token storage.** The refresh token stays in the existing envelope in
`connections.credentials_encrypted`, bound to workspace and connection. A
1:1 table `connection_oauth` (RLS, workspace-scoped) holds the provider,
the linked account (`sub`, email), the granted scopes, the access token in
its own envelope (associated data names it as an access token, so the two
envelopes cannot be swapped) and its expiry. The email is shown on the
connection ("Connected as …"); it is not a secret but never appears in logs.

**Refresh, serialized per connection.** Connector code never sees the refresh
token or the client secret. Before each check, discovery or sync the host
hands the connector `credentials: { accessToken }`. The host's token service:

1. reads the cached access token; if it is valid for at least 5 more
   minutes, uses it;
2. otherwise locks the `connection_oauth` row (`SELECT … FOR UPDATE`, as the
   device token exchange does in ADR 0011), reads it again, and refreshes only
   if it is still stale; then stores the new access token (and a rotated
   refresh token, for providers that rotate) and commits.

A concurrent caller waits on the lock and then finds the fresh token, so
Google sees one refresh. The refresh request has a short timeout, so the lock
is never held for long. A 401 from the provider API with a fresh token
invalidates the cache, and the job's retry refreshes once more.

**Reauthorization state.** `connection_state.auth_state` gains
`needs_reauthorization`, with an `auth_reason`: `invalid_grant` (revoked,
expired, password changed), `scope_missing` (the connector now needs more
scopes than were granted). The scheduler skips the connection, as it does
for `auth_failed`, and the UI shows a "Reconnect Google" action that runs
the reauthorization flow. While the hosted Google app is in testing,
Google expires refresh tokens after 7 days; this surfaces as the same
state, with copy that says so. A provider API refusing access to the chosen
property (403 after a valid token) stays `auth_failed`: the user fixes
permissions in Search Console or picks another property.

**Scope upgrades.** When a connector version requires a scope the stored
grant lacks, the connection moves to `needs_reauthorization`
(`scope_missing`); reauthorization asks for the union with
`include_granted_scopes`.

**Disconnect.** Google is believed to revoke the whole grant of one Google
account for our client, not only the token sent, so revoking for one
connection would also stop every other connection that account authorized on
this instance, in any workspace. Deleting an OAuth connection therefore
revokes at the provider only when it held the last grant for that provider
and account `sub`:

1. In the deleting transaction, the API decrypts the refresh token, then
   calls `oauth_release_grant(provider, sub, connection_id)`, a SECURITY
   DEFINER function (the pattern of ADR 0009). It takes a transaction
   advisory lock on (provider, sub), so two deletions for one account
   serialize, and returns only a boolean: whether any other
   `connection_oauth` row on the instance has the same provider and `sub`.
   It returns no ids, workspaces or counts. An index on (provider, sub)
   backs it.
2. The connection is deleted and the transaction commits.
3. If no other connection holds a grant, the refresh token is revoked at the
   provider (best effort, short timeout). Otherwise only the stored tokens
   are gone.

If the revocation fails, the deletion stands and the UI links to the
provider's account permissions page. #133 verifies Google's revocation
scope. If it turns out to be per token, the check is kept anyway: it never
revokes a grant another connection still uses, and the disconnect message
only notes that access stays listed in the Google account while other
netrics connections use it.

**Egress.** Host-side token calls use the same guarded fetch as connectors,
limited to the provider's domains (`oauth2.googleapis.com`; the browser, not
the server, visits `accounts.google.com`). The Search Console connector's
`outboundDomains` is only `searchconsole.googleapis.com`, so connector code
cannot reach the token endpoints.

**Logging.** Codes, states, verifiers, access and refresh tokens, ID tokens
and the client secret never appear in logs, errors, audit events or API
responses. Provider errors are reduced to their `error` code. The callback
URL with its query is never logged. Connecting, reauthorizing, account
changes and disconnecting are audited without token material.

**Tests.** The OAuth client takes its fetch as a dependency. Server tests run
a fixture provider in process (token exchange, refresh, rotation,
`invalid_grant`, revocation, ID tokens with right and wrong `aud` or
`nonce`); connector contract tests replay sanitized Search Console fixtures
offline, like Vercel. Outside production a `fixture` provider can be enabled
so the browser flow can be exercised end to end without Google.

## Alternatives considered

- **Callback on the API origin.** The browser would need to reach the API
  directly, which ADR 0005 avoids, and the redirect URI would change if the
  API moves.
- **Proxying the callback through the generic `/v1` proxy as a GET with an
  API redirect.** Possible, but it makes a browser redirect endpoint part of
  the API contract; a JSON callback endpoint plus a thin web route keeps the
  API testable and the redirect decision in one place.
- **Keeping the grant in a pending record until the wizard completes.** It
  needs a second place for secrets and a cleanup path for abandoned grants
  that still exist at Google. The setup-state connection reuses delete and
  revoke.
- **A library (openid-client, simple-oauth2).** The flow is small, the
  provider set is ours, and the egress guard, envelopes and RLS would need
  adapting anyway. The provider module can adopt one later without changing
  the tables.
- **Advisory locks or a lease column for refresh.** A row lock on the token
  row is simpler, released by commit or crash, and already proven by the
  device token exchange.
- **Per-workspace OAuth apps on the hosted service.** Contradicts the
  few-clicks rule; per-instance apps already cover self-hosting.

## Consequences

- New tables `oauth_authorizations` and `connection_oauth`, a new
  `auth_state` value, and SECURITY DEFINER functions for consuming states and
  for the shared-grant check on disconnect.
- Hosted operation needs a verified, published Google app. Until it is
  published, connections need reauthorization every 7 days.
- Self-hosters register a Google OAuth app, set two variables and register
  the derived redirect URI. The
  [setup guide](../../deploy/compose/google-oauth.md) documents this,
  including the testing-mode limit.
- The next OAuth connector adds a provider module and a manifest entry, no
  new tables or flows.
