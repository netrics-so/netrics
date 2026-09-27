# 0009 — API principals: users, service accounts, devices

Status: accepted (milestone 03.2, #61)

## Context

The only credential was the web session cookie. Three kinds of clients need
API access without a browser session:

- The Apple TV app and browser kiosks (milestone 06). They act for one
  workspace and read one assigned dashboard.
- Operator tooling: the hosted operations console, tenant administration and
  support tools. Self-hosters' instance administrators need the same.
- Later, customer automation (workspace API keys).

Without a common model, each client would bring its own auth path.

## Decision

- **Principal kinds.** `user` (session cookie), `service` (installation-level
  service account) and `device` (bound to one workspace, milestone 06). A
  route declares which kinds it accepts. Existing routes accept users only, so
  a bearer token gets 401 there.
- **Tokens.** Opaque bearer tokens `nt_<256-bit base64url>`. The prefix makes
  a leaked token recognizable to secret scanners. Only the SHA-256 is stored,
  in `principal_tokens` with kind, name, scopes, optional workspace (devices),
  expiry, `last_used_at` (minute resolution) and `revoked_at`.
- **Resolution.** An `Authorization` header is authoritative. A malformed,
  unknown, revoked or expired token is a hard 401 and never falls back to a
  cookie on the same request. The application role has no grant on
  `principal_tokens`; it resolves tokens only through the SECURITY DEFINER
  function `resolve_principal_token(hash)`.
- **Scopes.** Service tokens carry installation scopes (`@netrics/domain`
  `INSTALLATION_SCOPES`, starting with `installation:workspaces:read`).
  Workspace data stays behind memberships and roles.
- **Instance administrators.** `users.is_instance_admin`. The account created
  through first-run setup becomes one; a database trigger sets it. A guard
  trigger rejects any change to the column made as `netrics_app`, so no
  application code path can grant it.
- **Admin API.** `/v1/admin/*` accepts an instance-admin session or a service
  token holding the route's scope. The same endpoints serve self-hosters and
  the hosted console; private services never touch the database
  (architecture: "Private cloud control plane").
- **Issuing tokens.** The operator CLI in the server image
  (`node dist/admin-cli.js create-service-token | list-tokens |
revoke-token`) runs with the owner connection, like `migrate`. A token is
  printed once. Device tokens are issued by pairing (#55/#56).

## Consequences

- Device pairing adds the `device` kind's issuance and scope checks without a
  new auth mechanism.
- Revocation and expiry take effect on the next request; there is no cache.
- An admin UI for instance administrators and API keys for customers are
  later additions on the same model.
