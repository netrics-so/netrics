# netrics TV

The native viewer app for Apple TV (#58, ADR 0007, ADR 0010, ADR 0011) and,
from milestone 10.1, iPad and iPhone (ADR 0021). It pairs with a netrics
server by code and shows one workspace dashboard. Both platforms are one
App Store app, "netrics TV", with the bundle identifier `tv.netrics`
(universal purchase).

## Layout

- `NetricsKit/` is a Swift package with two libraries. `NetricsKit` holds
  all protocol and formatting logic and imports no UI framework.
  `NetricsUI` is the SwiftUI rendering the tvOS app and the later iOS app
  share (ADR 0021): widget views, the Signal design, the slide canvas and
  its chrome (header, refresh countdown, slide footer), the slideshow
  player (`SlideshowPlayer`: format, pages, rotation), the schema 1 tile
  grid, the scroll view, the demo, the app's String Catalog, and
  `DeviceSession`, the state both apps run on (server choice, pairing,
  unpair). Both build for tvOS
  26, iOS 27 and macOS 26, so their tests run on a Mac.
- `NetricsTV/` is the tvOS app: the slideshow with the Siri Remote's
  commands, focus handling, pairing, server and settings screens. It only
  renders what NetricsKit reports, with NetricsUI's views.
- `NetricsTVTouch/` is the iPhone and iPad app (iOS and iPadOS 27, #410):
  the same server choice and pairing on touch, with "Open approval page",
  "Share link" and "Copy code" (#411), the settings sheet, and the
  dashboard (`TouchDashboardView`): on iPad in screen view sized to the
  window (`PadDashboardView`, #412), on iPhone scroll view in portrait and
  screen view in landscape (`PhoneDashboardView`, #413). Touch in screen
  view is `TouchSlideshowView` (#414): swipes, a widget's detail sheet
  (`WidgetDetailSheet`, worded by NetricsKit's `WidgetDetail` from the
  payload), and chrome that a tap shows and `TouchChrome` hides again;
  scroll view (`TouchScrollView`) opens the same sheet from a card and
  keeps the settings button in the corner. It reports the
  platform `ios` or `ipados` when it pairs. Its
  iOS-only strings (the local network prompt) are in
  `NetricsTVTouch/InfoPlist.xcstrings`.
- `NetricsTV.xcodeproj` builds both apps: the targets `NetricsTV` (tvOS)
  and `NetricsTVTouch` (iPhone and iPad), each with a shared scheme. Their
  sources are synchronized folders, so adding a file to `NetricsTV/` or
  `NetricsTVTouch/` needs no project change.
- `Config/Signing.xcconfig` is the base configuration of both app targets
  and `Config/NetricsTV.entitlements` their entitlements (see Signing
  below).
- `Design/icon/` holds the SVG sources of the app icons and Top Shelf images
  and `render.sh`, which writes them into the tvOS asset catalog and the
  iOS icon.

Apple frameworks only: SwiftUI, Swift Charts, Security, CryptoKit,
CoreImage and URLSession.

## Build and test

Needs Xcode 27 (Swift 6.4 toolchain, the 27 SDKs); the apps target tvOS 26
and iOS/iPadOS 27 and later, in the Swift 6 language mode. CI's `netrics-tv` job runs the
commands below on GitHub's `xcode-27` runner image.

```sh
cd apps/netrics-tv/NetricsKit && swift test

cd apps/netrics-tv/NetricsKit && xcodebuild -scheme NetricsUI \
  -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO

xcodebuild -project apps/netrics-tv/NetricsTV.xcodeproj -scheme NetricsTV \
  -destination 'generic/platform=tvOS Simulator' -configuration Debug \
  build CODE_SIGNING_ALLOWED=NO

xcodebuild -project apps/netrics-tv/NetricsTV.xcodeproj -scheme NetricsTVTouch \
  -destination 'generic/platform=iOS Simulator' -configuration Debug \
  build CODE_SIGNING_ALLOWED=NO
```

`StudioLayout.swift` ports the slide layout and readability rules of
`packages/domain/src/studio-layout.ts` (ADR 0015, section 8). Its tests read
the shared vectors in `packages/domain/test-vectors/studio-layout.json`
straight from the repository, so a change on either side must keep both
suites green; `pnpm vectors:studio` regenerates the vectors from the
TypeScript. Compact numbers ("12.9K", German "12,9 Tsd.", narrow "12,3K")
follow `packages/domain/src/compact-format.ts` the same way:
`MetricFormat.compactAmount` runs
`packages/domain/test-vectors/compact-numbers.json`, which
`pnpm vectors:compact` regenerates.

To run it, open `NetricsTV.xcodeproj` in Xcode and pick an Apple TV
simulator (scheme `NetricsTV`) or an iPhone or iPad simulator (scheme
`NetricsTVTouch`). Simulator builds need no signing team. The iOS app takes
the same debug arguments. A build with `CODE_SIGNING_ALLOWED=NO` has no
Keychain entitlement, so in the simulator it cannot keep its server and
credentials across launches; Xcode's own simulator builds ("Sign to Run
Locally") can.

The simulator reaches the Mac's `localhost`. With the local stack running
(`pnpm dev`), choose "Your own server", enter `http://localhost:3000` and
turn on "Allow insecure connections". Debug builds also accept launch
arguments, so a simulator can be driven without a remote:

```sh
xcrun simctl launch <udid> tv.netrics -NetricsDebugServer http://localhost:3000 \
  -NetricsDebugInsecure YES -NetricsDebugAutoConnect YES
```

`-NetricsDebugSettings YES` opens the settings screen after launch.
On iPad, `-NetricsDebugWindowSizes 1376x1032,375x1032` (with
`-NetricsDebugStepSeconds 6`) gives the screen view each size in turn, as a
Split View, Slide Over or Stage Manager window would, to check the re-layout
from a script; `simctl` cannot turn a simulator, a UI test can
(`XCUIDevice.shared.orientation`). On iPhone,
`-NetricsDebugOrientations landscape,portrait` (with the same step) turns
the window in turn (`requestGeometryUpdate`), to check the switch between
scroll and screen view from a script.
`-NetricsDebugDemo YES` opens "Try a demo" right after launch.
`-NetricsDebugPayload /path/payload.json` shows a payload file as if paired,
with no server and nothing in the Keychain (`-NetricsDebugImages /path`
adds image files named by their SHA-256), to compare renderings in the
simulator.

## Signing

The repository is public, so it holds no Apple team ID. Both app targets'
base configuration, `Config/Signing.xcconfig`, leaves `DEVELOPMENT_TEAM`
empty and includes `Config/Signing.local.xcconfig` if it exists. That file
is git-ignored. To sign for a device:

```sh
cp apps/netrics-tv/Config/Signing.local.xcconfig.example \
  apps/netrics-tv/Config/Signing.local.xcconfig
# set DEVELOPMENT_TEAM to your team ID
xcodebuild -project apps/netrics-tv/NetricsTV.xcodeproj -scheme NetricsTV \
  -destination 'generic/platform=tvOS' -allowProvisioningUpdates build
```

Signing is automatic. Xcode creates the development profile once the team
has at least one registered Apple TV: pair it in Xcode > Devices and
Simulators first. A fork signs with its own team and, because bundle
identifiers are unique across teams, also sets its own
`PRODUCT_BUNDLE_IDENTIFIER` in the local file (`tv.netrics` belongs to the
netrics team). Never set the team in `project.pbxproj`: Xcode's Signing &
Capabilities tab writes it there, so pick the team in the local file instead.
For the iPhone and iPad app use the scheme `NetricsTVTouch` and
`-destination 'generic/platform=iOS'`; its development profile needs a
registered iPhone or iPad the same way (connect it to the Mac and turn on
Developer Mode on the device). Both targets share the bundle identifier,
the App Group and the local file, so one `Signing.local.xcconfig` signs
both.

### Entitlements: App Group and Keychain access group

Both targets sign with `Config/NetricsTV.entitlements` (ADR 0021, section 4),
written in build settings only:

- **App Group** `$(NETRICS_APP_GROUP)`, which `Signing.xcconfig` sets to
  `group.$(PRODUCT_BUNDLE_IDENTIFIER)` (`group.tv.netrics`; a fork's own
  identifier brings its own group). `Info.plist` passes it to the app as
  `NetricsAppGroup`. The dashboard and image caches live in
  `Library/Caches/netrics` of the group's container (`CacheLocation`), so a
  later widget extension shares them. A build without the entitlement
  (`CODE_SIGNING_ALLOWED=NO`) keeps them in the app's own Caches directory.
  The group must exist in the team's developer account and be enabled on
  the App ID; automatic signing with `-allowProvisioningUpdates` registers
  it.
- **Keychain access group** `$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)`:
  the application identifier, which needs no registration. It was already
  the group of every Keychain item the tvOS app wrote before the
  entitlement existed, so paired Apple TVs keep their credentials. Being
  first in the list, it stays the default group for new items, which a
  widget extension with the same entry can read.

Apple TVs paired before #410 kept their cache in their own Caches
directory; the first launch moves it into the group container
(`CacheLocation.migrate`, tested in `CacheLocationTests`), so they still
start offline with their last dashboard.

## App icons and Top Shelf

The tvOS icon is two layers for the parallax effect: an opaque back layer
(dark background and chart grid) and a front layer with a rising sparkline
on transparency. The Top Shelf images carry the wordmark. The artwork is a
draft until netrics has a logo.

The iOS icon, `NetricsTVTouch/AppIcon.icon`, is in Icon Composer's layered
format, from which the system draws the shape, the Liquid Glass and the
dark, tinted and clear looks. Its `icon.json` fills the background with the
back layer's gradient; its two layers are the same SVGs cut square: the back
layer's glow and grid (without the opaque background) and the front layer's
sparkline, which is glass. Open it in Icon Composer (in Xcode's developer
tools) to preview every look.

Edit the SVGs in `Design/icon/`, then run `apps/netrics-tv/Design/icon/render.sh`.
It needs Google Chrome (headless, also for the system font of the wordmark)
and ImageMagick, renders every slot of the asset catalog and both layers of
the iOS icon at their exact size, drops the alpha channel of opaque images
and checks the sizes.

## Platforms

One codebase, three kinds of device. What differs, and where:

|                     | Apple TV (`NetricsTV`)                                | iPad (`NetricsTVTouch`)                                                                    | iPhone (`NetricsTVTouch`)                                                                                              |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Reports platform    | `tvos`                                                | `ipados`                                                                                   | `ios`                                                                                                                  |
| View                | Screen view only; the web shows the mode fixed        | Screen view by default; `display_mode = scroll` gives the scroll view                      | Portrait: scroll view; landscape: screen view (`21x9`); `display_mode = screen` keeps screen view in portrait (`9x16`) |
| Format and rotation | 16:9 screen, turned by the device's rotation setting  | From the window's size (4:3, 3:4, any window); rotation setting ignored                    | Follows the phone; rotation setting ignored                                                                            |
| Screen stays on     | While paired (`isIdleTimerDisabled`)                  | Screen view in the foreground only (`TouchScreen.keepsScreenOn`)                           | In screen view in the foreground (landscape, or the screen setting); scroll view follows Auto-Lock                     |
| Input               | Siri Remote: left/right, Play/Pause, press and hold   | Swipe, tap a widget for details, tap elsewhere for pause and settings (#414)               | Same as iPad in screen view; scroll view: tap a card, settings button                                                  |
| Pairing extras      | Code, URL, QR code                                    | Also "Open approval page", "Share link", "Copy code"                                       | Same as iPad                                                                                                           |
| Demo                | Back (Menu) or the press-and-hold menu leaves         | "Leave demo" button                                                                        | "Leave demo" button                                                                                                    |
| Lifecycle           | Scene phase passed to the session (`deviceLifecycle`) | Same: no polling in the background, refresh on return                                      | Same                                                                                                                   |
| Kiosk setup         | Nothing needed                                        | Guided Access or Single App Mode: [the guide](../../docs/guides/ipad-on-a-wall-or-desk.md) | A desk stand: `display_mode = screen` and the guide's iPhone section                                                   |

The details are in "How it works" below; the wall and desk setup of an iPad
(Guided Access, Single App Mode, Auto-Lock, power, mounting, OLED) is in
[docs/guides/ipad-on-a-wall-or-desk.md](../../docs/guides/ipad-on-a-wall-or-desk.md).

## How it works

- **Server.** A new TV checks netrics cloud (`NetricsCloud.baseURL` in
  `ServerConfig.swift`) at once and shows its pairing code, retrying every
  10 seconds while the cloud is unreachable. Until it is paired, "Use your
  own server" (and back) changes the server. `GET /v1/server` must answer
  `product: "netrics"` and a supported `deviceApiVersion`. The server is
  stored with the credentials; once paired it changes only by unpairing,
  which starts over with netrics cloud.
- **Pairing.** The TV shows the code, the pairing URL the server reports and
  a QR code of `approveUrl`. It polls at `pollIntervalSeconds` and starts a
  new pairing when the code expires or is gone.
- **Credentials.** Tokens and the server live in the Keychain (this device
  only, after first unlock). A new token pair is saved before it is used.
  One refresh runs at a time, 2 minutes before expiry and once after a 401.
  A 401 on refresh means the TV was revoked: it forgets its credentials and
  shows a new code.
- **Dashboard.** Polled with `If-None-Match` every `refreshAfterSec`. The
  last payload is cached in the App Group's Caches directory, so an offline start shows
  it at once. Failures back off 5, 10, 20, 40, then 60 seconds, and the
  header shows "Offline — last update HH:MM".
- **Slides (payload schema 2, ADR 0015).** Before the first poll, and every
  6 hours, the app reads `dashboardSchemas` from `GET /v1/server` and asks
  for `?schema=2` only when the server lists it; an older server keeps
  getting today's request and the tiles render as one auto-laid-out screen.
  A cached ETag is only sent with the schema it belongs to. Unknown widget
  types (a newer server) render as an empty themed cell. Slides rotate
  locally by their duration (`SlideRotation`), fade in 400 ms (none with
  Reduce Motion or the "none" transition), and a new payload keeps the slide
  on screen when it still exists. Positions and text sizes come from
  `StudioLayout` and `StudioRender` (ports of the web's studio layout), so
  web and TV place widgets alike; colours are the payload's theme tokens.
- **Screen formats (payload schema 3, ADR 0017).** When the server lists
  schema 3 the app asks for it (else 2, else 1); the payload carries the
  dashboard's primary format, its custom layouts per format and this TV's
  rotation setting. tvOS cannot tell that a TV hangs on its side, so
  everything after pairing (slides, "no dashboard", offline notices) turns
  by the setting: at 90° or 270° a 1080p TV lays out as 1080 × 1920 points.
  The format comes from that rotated size (`formatFor`), each slide shows
  its primary, custom or auto-reflowed layout (`ScreenView.pages`), and
  continuation pages rotate as extra entries for the slide's full duration
  with "1/2" in the header. In 3:4 and 9:16 the dashboard name wraps to two
  lines and the slide name is dropped first (`headerFit`). Apple TV is
  always screen view; the display mode setting is for browser kiosks. A
  schema 2 payload is the `16x9` layout, unrotated, as before.
- **Signal design (ADR 0018 sections 5 and 6, #313).** Widgets draw the
  web's TV design from the theme tokens, never new tokens:
  `SignalDesign.swift` ports `themeSurface` (layered or flat) and the
  colours the web derives with `color-mix` (gradient, inner highlight,
  shadow, 24 unit radius; stale, auth failed and empty borders), the
  freshness footer ("updated 5 min. ago", RelativeDateTimeFormatter in the
  screen language, the same slot and fallback rules as `footerLine`), the
  header's refresh countdown (`refreshAfterSec` after the last answer, left
  out before a name would be cut) and the slide footer ("2 / 3 · Sales ·
  next: Team" with a progress bar). Auth failed, no data and backfilling
  replace the numbers with their own surface. On every slide change values
  count up, lines draw, bars grow and areas fade in over 1.2 s (ease-out
  cubic), driven by one state change that SwiftUI interpolates; afterwards
  only the last point's pulse, the stale dot's blink and the skeleton's
  sweep move. Reduce Motion turns all of it off. Text is SF Pro, values and
  clocks in tabular figures.
- **Images.** The payload's images are downloaded once with the device
  token from their device URL (only `/v1/device/images/…` on the paired
  server), verified against their SHA-256 and stored by hash in
  `Caches/netrics/images` (in the App Group container). Beyond 50 MB, images the current payload does
  not reference are evicted, least recently used first. They are decoded
  with ImageIO at the widget's pixel size.
- **Heartbeat.** Every 5 minutes: app version ("tvos", "ios" or "ipados"
  and the version, shown as tvOS, iOS and iPadOS in the web's device list),
  uptime, the last error and the screen: on Apple TV the points after the
  rotation setting, scale, format and screen view; on iPhone and iPad the
  window, scale, its format and the mode in use (`TouchScreen.report`).
- **iPad (ADR 0021 section 3, #412).** Screen view by default, as on the
  TV: NetricsUI's `SlideshowPlayer`, which the tvOS slideshow uses too, over
  the whole window. The format comes from the window's size (`TouchScreen`):
  `4x3` in landscape and `3x4` in portrait on every current iPad, and any
  Split View, Slide Over or Stage Manager window gets the format of its
  aspect; every size change re-lays out at once, offline too, keeping the
  slide on screen. The device's rotation setting is ignored, since an iPad
  knows its orientation. `display_mode = scroll` shows the scroll view
  instead. The screen stays on (`isIdleTimerDisabled`) only in screen view
  while the app is in the foreground; scroll view follows Auto-Lock.
- **Foreground and background (ADR 0021, section 3, #415).** Both apps hand
  the scene phase to the session (`deviceLifecycle` in NetricsUI calls
  `DeviceSession.enterBackground()` and `enterForeground()`, which pass it
  on to `DeviceClient` in order and to a client started later). In the
  background the poll and the heartbeat stop and nothing is sent; inactive
  (Control Center, the app switcher) keeps them going. Back in the
  foreground the client goes at once: while pairing it polls the same
  code (or shows a new one when it expired); once paired the last dashboard
  stays on screen while it refreshes the tokens when due, polls with
  `If-None-Match`, then sends a heartbeat with the fresh token, and the
  5 minute heartbeat starts over. While netrics cloud does not answer, it is
  checked again at once.
  A request in flight when the app leaves is not cancelled, so a token pair
  the server already rotated is still saved. An app the system ended in the
  background starts from the cache like an offline start. A device not
  opened for 90 days finds its refresh token refused and shows a new code.
  There is no background refresh (`BGAppRefreshTask`).
- **iPhone (ADR 0021 section 3, #413).** Portrait shows the scroll view,
  landscape screen view full screen in the phone's format (`21x9`; `16x9`
  on an iPhone SE) with the slides rotating and the screen kept on.
  `display_mode = screen` keeps screen view in portrait (`9x16`). The mode
  comes from the window's size (`TouchScreen.displayMode`), so turning the
  phone switches at once, offline too, and the slideshow goes on where it
  was. Pull to refresh in scroll view asks the client for the dashboard now
  (`DeviceSession.refresh`).
- **Scroll view (ADR 0017 section 5).** `ScrollDashboardView` in NetricsUI
  is the scroll view of iPhone and iPad (Apple TV is always screen view),
  as the web's: the header, then each slide as a section with its heading
  over its background image under the slide's dim, the widgets in reading
  order over 1 to 3 columns by `scrollLayout` (`ScrollGeometry`, tested on
  the shared vectors). Its cards (`ScrollCards.swift`) port the web's
  `scroll-widgets.tsx`: text in Dynamic Type's size (1 rem = 32 units, the
  web's `SCROLL_TYPE`), labels and lists in full (the card grows), values
  shrinking and then compact, charts 16:9 between 200 and 360 points,
  images in their aspect at most half the screen high, clocks and
  countdowns ticking locally. At the largest accessibility sizes a table's
  rows stack (label, then value and Δ), where the web keeps its columns.
- **Remote.** On a slide dashboard, left and right change the slide (or page) and
  Play/Pause pauses the rotation ("Paused" in the header).
- **iPhone and iPad (#411).** The pairing screen also opens `approveUrl`
  in Safari ("Open approval page"; the web session approves, the app never
  sees a user credential), shares it, and copies the code. Back in the
  foreground the app polls the same pairing at once (#415, above), or
  shows a new code when it expired. iOS never tells an app that Local
  Network access was denied: when a server on the local network does not
  answer, the server screen and the pairing screen explain the setting and
  open Settings. The settings sheet shows the server, the transport
  setting, the device and the app version, and unpairs as on Apple TV.
- **Demo (#416, ADR 0021 section 5).** "Try a demo" on the pairing screen
  (and on the screen that waits for netrics cloud, so it works with the
  network off) shows a sample dashboard bundled in NetricsUI:
  `Resources/demo-dashboard.en.json` and `.de.json`, schema 3 payloads with
  invented numbers (an "Example Roastery" with sites under example.com), two
  slides, eight widget types, the Midnight theme and no images. The file in
  the device's language is chosen; before it is decoded, `DemoPayload.retime`
  moves its dates to today in the device's time zone (ages stay as old as
  they were, chart buckets move by whole days). The header says "Demo"
  (`\.demoMode`). While it shows, the pairing or the cloud check is stopped:
  nothing is sent, nothing is stored in the Keychain or the cache. Leaving
  returns to the same server and starts its pairing again (a new code). On
  touch the "Leave demo" button leaves; on Apple TV Back (Menu) does, and
  pressing and holding the clickpad opens a menu with "Leave demo". The
  payloads are generated by `packages/contracts/src/tv-demo-payload.test.ts`,
  which also parses them with the zod schema 3 contract; `pnpm demo:tv`
  rewrites them. `DemoDashboardTests` decodes them in Swift.
- **Settings.** Press and hold the clickpad on the dashboard, or press
  Play/Pause where there is nothing to rotate (one slide, or a schema 1
  dashboard). The pairing screen has a Settings button. Unpair revokes the
  device on the server (`POST /v1/device/me/revoke`, #407), then clears the
  Keychain and the cache and shows a new netrics cloud code; offline or on
  an older server (404) it unpairs locally only. Once paired,
  settings turn with the content by the rotation setting; the pairing
  screen and its settings stay upright (`ScreenView.settingsRotation`,
  #298). The tvOS focus engine reads presses along the panel, so on a
  turned screen only the focused button can take focus and the app moves
  focus itself by the press in the content's frame (`FocusGrid`): up on the
  remote is up as the viewer sees it. A turned screen asks to unpair in
  place, since the system's confirmation dialog cannot turn.

`DeviceClient` follows the browser kiosk (`apps/web/src/lib/kiosk-client.ts`)
rule for rule, and its tests cover the same cases. Number formatting, tile
notices and the grid follow `format-metric.ts`, `tile-status.ts` and
`tv-grid.ts`; the widget layout follows `studio-render.ts`, `studio-chart.ts`
and the text widget layout in `studio-widgets.ts`.

## Languages

English and German (ADR 0016). The app's own text lives in
`NetricsKit/Sources/NetricsUI/Resources/Localizable.xcstrings` (keyed by the
English text, looked up with `L10n.tr`; `Info.plist` lists both languages); NetricsKit's
formatting words (periods, comparisons, notices) are a typed table in
`Localization.swift`. Before pairing the app follows the Apple TV's
language; once paired, the payload's `locale` (the workspace's screen
language) decides the app's text and number and date formats. Labels in the
payload arrive finished. Tests check that every key has a German value.

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

- The iPad guide followed once on a real iPad, and the other device checks
  of milestone 10.1's exit gate (#420).

- Final app icon and Top Shelf artwork (the current ones are a draft).
- App Store Connect record and TestFlight.
- A run on a physical Apple TV, and the exit gate of milestone 06. Xcode
  pairs with an Apple TV on another subnet but drops the connection, because
  `remotepairingd` requires the TV to be on the Mac's own link (ARP); put the
  Mac on the TV's subnet first (#129).
- Check the Signal design's cost (shadows, the enter, the continuous cues)
  on a physical Apple TV HD; it is checked in the simulator only (#313).
- Check on a device that App Transport Security lets a pinned self-signed
  certificate through on a host outside the local network. Local hosts are
  exempt from ATS, so they work.
- The hosted domain in `NetricsCloud.baseURL` once it is live.
