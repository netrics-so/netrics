# netrics for Apple TV

The native tvOS app (#58, ADR 0007, ADR 0010, ADR 0011). It pairs with a
netrics server by code and shows one workspace dashboard full screen.

## Layout

- `NetricsKit/` is a Swift package with all protocol and formatting logic
  and no UI. It builds for tvOS 18 and macOS 15, so its tests run on a Mac.
- `NetricsTV/` is the SwiftUI app. It only renders what NetricsKit reports.
- `NetricsTV.xcodeproj` builds the app. Its sources are a synchronized
  folder, so adding a file to `NetricsTV/` needs no project change.
- `Config/Signing.xcconfig` is the base configuration of the app target
  (see Signing below).
- `Design/icon/` holds the SVG sources of the app icon and Top Shelf images
  and `render.sh`, which writes them into the asset catalog.

Apple frameworks only: SwiftUI, Swift Charts, Security, CryptoKit,
CoreImage and URLSession.

## Build and test

```sh
cd apps/tvos/NetricsKit && swift test

xcodebuild -project apps/tvos/NetricsTV.xcodeproj -scheme NetricsTV \
  -destination 'generic/platform=tvOS Simulator' -configuration Debug \
  build CODE_SIGNING_ALLOWED=NO
```

To run it, open `NetricsTV.xcodeproj` in Xcode and pick an Apple TV
simulator. Simulator builds need no signing team.

The simulator reaches the Mac's `localhost`. With the local stack running
(`pnpm dev`), choose "Your own server", enter `http://localhost:3000` and
turn on "Allow insecure connections". Debug builds also accept launch
arguments, so a simulator can be driven without a remote:

```sh
xcrun simctl launch <udid> tv.netrics -NetricsDebugServer http://localhost:3000 \
  -NetricsDebugInsecure YES -NetricsDebugAutoConnect YES
```

`-NetricsDebugSettings YES` opens the settings screen after launch.

## Signing

The repository is public, so it holds no Apple team ID. The app target's
base configuration, `Config/Signing.xcconfig`, leaves `DEVELOPMENT_TEAM`
empty and includes `Config/Signing.local.xcconfig` if it exists. That file
is git-ignored. To sign for a device:

```sh
cp apps/tvos/Config/Signing.local.xcconfig.example \
  apps/tvos/Config/Signing.local.xcconfig
# set DEVELOPMENT_TEAM to your team ID
xcodebuild -project apps/tvos/NetricsTV.xcodeproj -scheme NetricsTV \
  -destination 'generic/platform=tvOS' -allowProvisioningUpdates build
```

Signing is automatic. Xcode creates the development profile once the team
has at least one registered Apple TV: pair it in Xcode > Devices and
Simulators first. A fork signs with its own team and, because bundle
identifiers are unique across teams, also sets its own
`PRODUCT_BUNDLE_IDENTIFIER` in the local file (`tv.netrics` belongs to the
netrics team). Never set the team in `project.pbxproj`: Xcode's Signing &
Capabilities tab writes it there, so pick the team in the local file instead.

## App icon and Top Shelf

The icon is two layers for the tvOS parallax effect: an opaque back layer
(dark background and chart grid) and a front layer with a rising sparkline
on transparency. The Top Shelf images carry the wordmark. The artwork is a
draft until netrics has a logo.

Edit the SVGs in `Design/icon/`, then run `apps/tvos/Design/icon/render.sh`.
It needs Google Chrome (headless, also for the system font of the wordmark)
and ImageMagick, renders every slot of the asset catalog at its exact size,
drops the alpha channel of opaque images and checks the sizes.

## How it works

- **Server choice.** netrics cloud (`NetricsCloud.baseURL` in
  `ServerConfig.swift`) or the user's own server. `GET /v1/server` must
  answer `product: "netrics"` and a supported `deviceApiVersion`. The
  server is stored with the credentials and changes only by unpairing.
- **Pairing.** The TV shows the code, the pairing URL the server reports and
  a QR code of `approveUrl`. It polls at `pollIntervalSeconds` and starts a
  new pairing when the code expires or is gone.
- **Credentials.** Tokens and the server live in the Keychain (this device
  only, after first unlock). A new token pair is saved before it is used.
  One refresh runs at a time, 2 minutes before expiry and once after a 401.
  A 401 on refresh means the TV was revoked: it forgets its credentials and
  shows a new code.
- **Dashboard.** Polled with `If-None-Match` every `refreshAfterSec`. The
  last payload is cached in the Caches directory, so an offline start shows
  it at once. Failures back off 5, 10, 20, 40, then 60 seconds, and the
  header shows "Offline — last update HH:MM".
- **Heartbeat.** Every 5 minutes: app version, uptime and the last error.
- **Settings.** Press Play/Pause, or press and hold the clickpad, on the
  dashboard. The pairing screen has a Settings button. Unpair clears the
  Keychain and the cache.

`DeviceClient` follows the browser kiosk (`apps/web/src/lib/kiosk-client.ts`)
rule for rule, and its tests cover the same cases. Number formatting, tile
notices and the grid follow `format-metric.ts`, `tile-status.ts` and
`tv-grid.ts`.

## Transport security

HTTPS with a valid certificate is the default. "Allow insecure connections"
is off by default and labelled "not recommended". While it is on, the server
screen, the pairing screen and settings say so. It allows two things:

- Plain HTTP, but only to local-network hosts: private IPv4 ranges,
  loopback, IPv6 unique-local and link-local addresses, `localhost` and
  `.local` names. Plain HTTP to any other host is refused in code, with or
  without the setting. `Info.plist` sets only `NSAllowsLocalNetworking`,
  never `NSAllowsArbitraryLoads`.
- A self-signed certificate, trusted on first use during the server check.
  The SHA-256 of its leaf certificate is pinned. If the server later shows a
  different certificate, the app stops with a warning instead of
  connecting, until the TV is unpaired.

Redirects are not followed: the device API never redirects, and following
one could leave these rules.

## Not done yet

- Final app icon and Top Shelf artwork (the current ones are a draft).
- App Store Connect record and TestFlight.
- A run on a physical Apple TV, and the exit gate of milestone 06.
- Check on a device that App Transport Security lets a pinned self-signed
  certificate through on a host outside the local network. Local hosts are
  exempt from ATS, so they work.
- The hosted domain in `NetricsCloud.baseURL` once it is live.
