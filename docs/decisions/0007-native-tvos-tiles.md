# 0007 — Apple TV MVP: native SwiftUI tiles from a JSON endpoint

Status: accepted (replaces the snapshot-first plan for milestone 06)

## Context

The architecture planned Apple TV as a thin client that shows server-rendered
PNG snapshots produced by a Playwright renderer. Getting a first number on a
TV that way requires:

- A working headless Chromium image (the current Alpine-based renderer image
  cannot run Playwright's bundled browser)
- Protected render routes with internal render tokens
- Object storage (local volume and S3), snapshot versioning and invalidation
- A finished browser dashboard worth screenshotting

That is the slowest path to a working TV. It is also the most expensive to
host per tenant, and the hardest part of the stack for self-hosters to run.

The security-relevant parts do not depend on the rendering choice: pairing,
device-scoped credentials, rotation and revocation are needed either way.

## Decision

For the MVP, the tvOS app renders dashboards natively:

- `GET /v1/device/dashboard` returns a versioned JSON read model (tiles with
  label, value, unit, change, sparkline points, status, updatedAt) with
  `ETag`/`304` support. It is computed by the same metric query service as the
  browser dashboard and scoped by RLS to the device's workspace.
- The SwiftUI app draws tiles (Swift Charts sparklines), polls on
  `refreshAfterSec`, and caches the last payload on disk for offline starts.
- The same endpoint powers a browser kiosk for non-Apple screens.
- Pairing and device credentials follow the milestone 06 security invariants.

Server-rendered snapshots are deferred. They return only if customers need
arbitrary layouts on devices that cannot render natively.

## Consequences

- The renderer process leaves the release and deployment path until snapshots
  are scheduled. Self-hosting needs no Chromium.
- Tile types must be implemented twice (web and SwiftUI). The tile set stays
  deliberately small: big number, change and sparkline.
- The OpenAPI spec becomes the contract for the Swift client, so it is
  generated and checked in CI.
- TV typography and layout are native, which improves readability at a
  distance.
