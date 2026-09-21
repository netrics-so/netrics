# Milestone 06 — Screens and Apple TV

## Outcome

A native Apple TV app can be paired with a workspace, assigned a playlist
remotely, and reliably display server-rendered dashboards.

## Dependencies

- Milestone 05

## In scope

- S3-compatible snapshot-storage interface and local-volume implementation
- Protected fixed-viewport dashboard render route
- Playwright renderer jobs and image versioning
- Device, pairing session, playlist, and assignment records
- Short-lived, rotating, single-use pairing codes
- Device-scoped access and refresh credentials
- Playlist manifest with ETag/version support
- Browser kiosk client using the same device APIs
- Native SwiftUI tvOS application
- Offline last-known snapshot cache
- Remote playlist changes and heartbeat diagnostics
- Device revocation and credential rotation
- Initial 30–60 second snapshot refresh target

## Out of scope

- Native chart rendering
- Sub-second live animation
- Mobile iOS application
- General digital-signage media playback
- Public dashboard sharing

## Implementation slices

1. Add storage abstraction and local/SaaS implementations.
2. Build protected render sessions and deterministic snapshot jobs.
3. Create device, playlist, manifest, and assignment APIs.
4. Implement secure pairing and device-token rotation.
5. Build a browser kiosk reference client.
6. Build the tvOS pairing and full-screen playback application.
7. Add caching, offline behavior, heartbeat, and remote reassignment.
8. Test 1080p and 4K layouts, token revocation, and renderer failures.

## Security invariants

- Pairing codes expire quickly, are rate-limited, and work once.
- Device credentials grant access only to that device's assigned manifest and
  snapshots.
- Rendering uses short-lived internal tokens rather than public share links.
- Snapshot object names reveal no workspace or dashboard secrets.
- Revocation prevents manifest refresh and snapshot retrieval.

## Verification

- Pairing works using only the TV code and an authenticated browser.
- A playlist change appears without touching the TV.
- Restarting offline shows the last complete playlist.
- Expired snapshots refresh without blanking the screen.
- Revoked devices stop receiving updates.
- Renderer retries do not create conflicting snapshot versions.

## Exit gate

Pair a physical or simulator Apple TV, assign two dashboards, observe rotation
and a remote assignment change, interrupt the network, confirm cached playback,
restore the network, and revoke the device.
