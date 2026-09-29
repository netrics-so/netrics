# 0011 — Device pairing and credentials

Status: accepted (2026-09-28, milestone 06, #55/#56)

## Context

Apple TVs and browser kiosks show one workspace's dashboard (ADR 0007). They
must never hold a user session (ADR 0009), nobody types a password with a TV
remote, and a stolen or retired screen must be cut off without touching
anyone's account. ADR 0010 fixed the user flow: the TV shows a code, a
signed-in owner or admin approves it in the web app of that server.

## Decision

**Records.**

- `devices` is a workspace table under RLS, like dashboards: name, the
  assigned dashboard, who approved it, `last_seen_at`, `revoked_at`.
- `device_pairings` is installation-level: before approval a pairing belongs
  to no workspace. It stores only hashes of the code and of the device's
  poll secret, the expiry, the approving workspace and device, and when the
  credentials were handed out.

**Pairing.**

1. The TV calls `POST /v1/device/pairings` (no authentication) and gets a
   code, a poll secret, the expiry (10 minutes), the poll interval and the
   URL to show. At most 10 pairings per client IP per 10 minutes.
2. The code has 8 characters from a 25-character alphabet without
   look-alikes (no 0/O, 1/I/L, 2/Z, 5/S, 8/B), shown as `XXXX-XXXX`:
   25⁸ ≈ 1.5·10¹¹ codes.
   Approval normalizes case, spaces and dashes.
3. An owner or admin approves the code with
   `POST /v1/workspaces/:id/devices/approve`, naming the device and choosing
   its dashboard. This creates the device. Unknown, expired and already
   approved codes get the same 404, and failed attempts count against the
   user: 10 per 15 minutes, then 429.
4. The TV polls `POST /v1/device/pairings/poll {pairingId, pollSecret}`. Once
   approved, the first poll receives the credentials; the pairing is then
   spent and later polls get 410, as do expired pairings.

Credentials are generated at that poll, so their plain text is never stored,
and claiming is a single conditional update, so two polls cannot both receive
them.

**Credentials.** Device tokens are `principal_tokens` rows of kind `device`
(ADR 0009), now linked to their device:

- an **access token** (scope `device:read`, 1 hour) for the device API, whose
  routes accept nothing else: no session, no service token, no refresh token;
- a **refresh token** (scope `device:refresh`, 90 days) that only
  `POST /v1/device/token` accepts.

**Rotation.** Each refresh returns a new pair and retires the refresh token
it was given. TVs lose responses on bad networks, so a retired token may come
back once more as a retry: within 5 minutes, while none of its successors has
been used. The retry revokes the unused successors and issues a new pair.
Any other return of a retired token means someone else holds a copy: every
token of the device is revoked, the device is marked revoked, and the event
is audited. The token row is locked during the exchange, so concurrent
refreshes of one token serialize.

The application role still cannot touch `principal_tokens`. It issues and
revokes device tokens through SECURITY DEFINER functions that check the
device belongs to the given workspace and is not revoked.

**Revocation.** Revoking a device sets `revoked_at` and revokes all of its
tokens in one transaction, so the next request gets 401. Approval and
revocation are audited.

**Server identification.** `GET /v1/server` (public) returns the product
name, the API version and the pairing URL. The pairing URL is configuration:
`NETRICS_PAIRING_URL` for the hosted service (`https://netrics.tv/link`),
otherwise `<WEB_ORIGIN>/devices/approve`. The approval page accepts
`?code=`.

## Consequences

- A device holds no user identity. Its tokens reach nothing outside its
  workspace, and only the routes that accept the `device` kind.
- A lost TV is cut off from the web app, with no account changes.
- The hosted `netrics.tv/link` redirect and a self-hosted server's own URL
  behave the same for the app, which only shows what the API reports.
