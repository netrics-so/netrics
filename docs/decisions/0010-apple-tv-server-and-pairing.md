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

**Server choice.** On first start the app offers:

- **netrics cloud** (default): the hosted service, no input needed.
- **Your own server**: the user enters its URL once. The iPhone keyboard
  helps with this. Before pairing, the app checks a public, unauthenticated
  endpoint that identifies a netrics server and its API version, and refuses
  incompatible or unrelated servers with a clear message. The chosen server
  is stored with the device credentials and can be changed only by
  unpairing.

There is no relay through our cloud and no network discovery: a self-hosted
TV talks only to its own server.

**Pairing.** Unchanged in substance for both kinds of server (#55): the TV
shows a short single-use code and a QR code. The code is approved by a
signed-in owner or admin in the web app of _that_ server, and the TV then
receives device-scoped, rotating credentials.

- The hosted service shows the short address **netrics.tv/link**. It is part
  of the hosted deployment, not of the code, and forwards to the web app's
  approval page with the code prefilled.
- A self-hosted server shows its own URL (`<server>/devices/approve`). The
  API reports the pairing URL to show, so the app never builds it.

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
- The hosted service needs the netrics.tv domain and a redirect from
  `/link` to the web app's approval page. This is configured in the private
  infrastructure repositories.
- Self-hosters on a local network without a certificate can use a TV only
  after deliberately enabling the setting on that TV.
