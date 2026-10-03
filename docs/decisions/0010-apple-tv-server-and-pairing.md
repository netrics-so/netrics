# 0010 — Apple TV: one App Store app for the hosted service and self-hosted servers

Status: accepted (2026-09-28, milestone 06)

## Context

The Apple TV app ships once, through the App Store. Most users run the hosted
service; self-hosters run the same server on their own domain, sometimes
only on a local network. Everyone should connect a TV the same way: a code on
the screen, approved in the browser. Nobody types a password with a TV
remote, and no user session ever lives on the TV (milestone 06 security
invariants, ADR 0009 device principals).

## Decision

**Server choice.** On first start the app connects to **netrics cloud** at
once and shows the pairing code: the hosted service needs no input, and most
TVs pair with it. Until the TV is paired, the pairing screen offers **Use
your own server** (and that screen offers the way back):

- **netrics cloud** (default): the hosted service, no input needed. If it is
  unreachable, the app says so and retries by itself.
- **Your own server**: the user enters its URL once. The iPhone keyboard
  helps with this. Before pairing, the app checks a public, unauthenticated
  endpoint that identifies a netrics server and its API version, and refuses
  incompatible or unrelated servers with a clear message. The chosen server
  is stored with the device credentials. Once the TV is paired, the server
  changes only by unpairing, which starts over with netrics cloud.

_Amended 2026-10-03: the first version showed a choice screen before
pairing; the app now starts pairing with netrics cloud directly, so a new
TV shows its code without any input._

There is no relay through our cloud and no network discovery: a self-hosted
TV talks only to its own server.

**Pairing.** Unchanged in substance for both kinds of server (#55): the TV
shows a short single-use code and a QR code. The code is approved by a
signed-in owner or admin in the web app of _that_ server, and the TV then
receives device-scoped, rotating credentials.

- The hosted service shows the short address **netrics.tv**, and its QR code
  opens `netrics.tv/<CODE>`. The web app itself lives at app.netrics.so.
  netrics.tv points at the same web service, which redirects every request
  on that host to the approval page on the app origin, with the code
  prefilled when the path or `?code=` holds one.
- A self-hosted server shows its own URL (`<server>/devices/approve`), and
  its QR code adds `?code=<CODE>`. The API reports both the pairing URL and
  the QR code's URL, so the app never builds them.
- The TV shows the pairing URL without scheme or trailing slash.

**Transport security.** HTTPS with a valid certificate is required by
default. A setting, off by default, labelled as not recommended and shown on
the server screen while active, allows:

- plain HTTP to local-network addresses (private IP ranges and `.local`
  names), which Apple permits through its local-networking exception;
- a self-signed certificate on any server, trusted on first use: the
  certificate is pinned, and a later change stops the app with a warning
  instead of connecting.

Plain HTTP across the public internet is not possible. It would need Apple's
blanket exception, which App Review questions, and it would send device
credentials in the clear.

## Consequences

- #55 and #58 include server choice, the compatibility check, the
  reported pairing URL and the transport setting.
- The server needs a public identification endpoint (name, API version,
  pairing URL) for the app's check. It reveals no workspace data.
- The hosted service is configured, not coded: the API sets
  `NETRICS_PAIRING_URL=https://netrics.tv` (a URL without a path puts the
  code in the path), and the web service sets
  `NETRICS_PAIRING_HOST=netrics.tv` and
  `NETRICS_APP_ORIGIN=https://app.netrics.so`. Requests on any other host
  are redirected (308) to the same path on the app origin, except health
  checks and the device API (with the browser kiosk and its assets). Without
  these, the web app redirects nothing, so self-hosted servers are
  unaffected.
- The redirect is temporary (302) and passes on only a well-formed code,
  normalized to `XXXX-XXXX`; anything else lands on the empty form.
- Self-hosters on a local network without a certificate can use a TV only
  after deliberately enabling the setting on that TV.
