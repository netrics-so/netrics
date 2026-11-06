# 0021 — netrics TV on iPad and iPhone

Status: accepted (2026-10-30; milestone 10.1). Extends ADR 0010 (server
choice and pairing), ADR 0011 (device pairing and credentials) and ADR 0017
(screen formats and display modes).

## Context

The Apple TV app (milestone 06, ADR 0007) pairs with a netrics server by
code and shows one workspace dashboard full screen. Its protocol and
formatting logic live in the Swift package `NetricsKit` (no UI, tvOS 18 and
macOS 15); the SwiftUI app target `NetricsTV` renders what NetricsKit
reports. ADR 0017 already ported the reflow (`formatFor`, `reflowSlide`) and
the scroll view layout (`scrollLayout`) to Swift with shared vectors,
"so the future mobile apps reuse it".

This ADR brings the same viewer to iPad and iPhone.

### Owner decisions (2026-10-29), binding

1. **Two products.** "netrics TV" is the viewer. It always connects by
   pairing with a code, as on Apple TV: no personal sign-in, no passkeys, no
   workspace switching. A separate admin app called "netrics" comes later;
   until then administration happens on the web. The admin app is out of
   scope here.
2. **Platforms.** netrics TV runs on Apple TV (exists), iPad and iPhone.
   Apple Watch is out of scope; it waits for the admin app.
3. **Newest SDKs and APIs** (owner rule).

### What the repository has today (checked 2026-10-29)

- One Xcode project, `apps/tvos/NetricsTV.xcodeproj`, one app target
  (`SDKROOT appletvos`, `TVOS_DEPLOYMENT_TARGET 18.0`,
  `TARGETED_DEVICE_FAMILY 3`, Swift 6.0, display name "netrics", bundle
  identifier `tv.netrics` in `Config/Signing.xcconfig`, team only in the
  git-ignored local file). The app uses the SwiftUI `App` lifecycle.
- `NetricsKit`: `swift-tools-version 6.0`, platforms tvOS 18 and macOS 15.
  CI runs `swift test` on a `macos-15` runner; the app itself is not built
  in CI.
- The app's SwiftUI rendering (`WidgetViews`, `SignalViews`,
  `SlideshowView`, `SlideChromeViews`) sits in the app target, beside the
  tvOS-only parts (focus handling with `FocusGrid`, remote commands, the
  settings panel).
- Pairing (ADR 0011): `POST /v1/device/pairings` takes no body and returns a
  code, poll secret, `pairingUrl` and `approveUrl` (the QR code). Owners and
  admins approve (`devices:manage`; editors only view devices). The approve
  form prefills the name "Apple TV".
- The `devices` record has no platform or kind. It stores `rotation`
  (tvOS and kiosks), `display_mode` (kiosks; tvOS ignores it) and the last
  heartbeat's `screen`. The device list cannot tell an Apple TV from a
  browser kiosk except by the reported app version.
- **Unpair is local only.** `DeviceClient.unpair()` clears the Keychain and
  the caches. The server keeps the device, which shows as offline until
  someone revokes it on the web.
- There is no demo mode and no privacy manifest. The App Store Connect
  record for the tvOS app does not exist yet (apps/tvos/README.md, "Not done
  yet").

### What Apple offers (checked 2026-10-29)

- **Current releases.** iOS 27, iPadOS 27 and tvOS 27 shipped on
  2026-09-14 with Xcode 27 (Swift 6.4). Xcode 27 needs macOS 26.6 on Apple
  silicon. From April 2027, App Store uploads must be built with the 27
  SDKs.
- **Device support.** iOS 27 runs on the same iPhones as iOS 26 (iPhone 11
  and later, iPhone SE 2nd generation and later). iPadOS 27 drops five older
  iPads. tvOS 27 drops Apple TV HD and Apple TV 4K (1st generation); tvOS 26
  is their last version.
- **Scene lifecycle.** Apps built with the 27 SDKs must use the scene-based
  life cycle or they fail to launch
  ([Transitioning to the scene-based life cycle](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle)).
  The SwiftUI `App` lifecycle already is. Apps built with the iOS 27 SDK
  need a launch screen, and `UIRequiresFullScreen` is deprecated: iPad apps
  must handle any window size
  ([TN3192](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key)).
- **Universal purchase.** One app record holds several platforms. "A macOS,
  tvOS, visionOS app … uses the same Apple ID (an app identifier), SKU, and
  bundle ID as the iOS app"; builds for the other platforms come "from a
  separate Xcode target" whose bundle ID matches the iOS app's, and each
  platform may have its own version and build numbers. Separate records
  cannot be merged later. Once two platform versions pass review the app
  stays a universal purchase, and a platform cannot be removed
  ([Universal purchase](https://developer.apple.com/support/universal-purchase/)).
  iPad and iPhone are one platform ("iOS") in App Store Connect.

## Decision

### 1. Packaging: one product, universal purchase

- **One App Store record, "netrics TV"**, with the tvOS and iOS platforms,
  bundle identifier `tv.netrics` on both. The record is created once with
  both platforms, before the first tvOS submission, so nothing has to be
  removed from sale or merged later.
- **Same Xcode project, a second app target.** `NetricsTV` (tvOS) stays;
  a new target `NetricsTVTouch` builds the universal iPhone and iPad app
  (`SDKROOT iphoneos`, `TARGETED_DEVICE_FAMILY 1,2`). Both targets take the
  bundle identifier and the team from `Config/Signing.xcconfig` and the
  git-ignored local file, as today; the team never enters the repository.
  The marketing version is the same on both platforms; build numbers count
  per platform.
- **Shared code.**
  - `NetricsKit` stays free of UI and gains iOS. Its tests keep running on
    a Mac.
  - The platform-neutral SwiftUI rendering (widgets, Signal design, slide
    canvas, slide chrome, the shared strings) moves from the tvOS target into
    a second library product of the same package, `NetricsUI` (tvOS and
    iOS). Each app target keeps only its platform's input and chrome: focus
    and remote on tvOS, touch and sheets on iOS. A tvOS build before and after
    the move must render identically.
  - The scroll view renderer is new and lives in `NetricsUI`, on the existing
    Swift `scrollLayout`.
- **Toolchain and deployment targets.** Built with Xcode 27 and the 27
  SDKs, Swift 6 language mode. The iOS target's minimum is **iOS and iPadOS
  27**: there is no installed base to keep, and iOS 27 supports every iPhone
  iOS 26 does. The tvOS minimum moves from 18 to **tvOS 26**, not 27, so
  Apple TV HD and Apple TV 4K (1st generation), the cheapest wall players,
  keep working; tvOS 27 APIs are used behind availability checks. CI moves to
  GitHub's `xcode-27` runner image (Xcode 27 on macOS 27) and builds both app targets
  (`CODE_SIGNING_ALLOWED=NO`) besides `swift test`.
- **Name.** The display name is **"netrics TV" on all three platforms**,
  and the tvOS target changes from "netrics" to "netrics TV". The name says
  what the app is, keeps "netrics" free for the later admin app, and fits
  under a home-screen icon (10 characters). The App Store name is the same;
  the owner checks that it is free when creating the record.
- **Not offered:** the iPad app on Apple silicon Macs and the compatible-app
  listing on Apple Vision Pro are turned off in App Store Connect until
  someone tests them.
- **Folder.** `apps/tvos/` becomes `apps/netrics-tv/`: it now holds the
  product, not one platform, and the later admin app gets its own folder.
  The move happens once, with the toolchain change, because CI paths and the
  tests that read `packages/domain/test-vectors` use it.
- **Icons.** The iOS icon is made from the same SVG layers as the tvOS
  icon, in Apple's current layered icon format (Icon Composer), rendered by
  `Design/icon/render.sh` like the tvOS assets.

### 2. Pairing on iPad and iPhone

The flow is the tvOS flow, unchanged in substance (ADR 0010, ADR 0011):
the device shows a code and a QR code, an owner or admin approves it on the
web, and the device receives device-scoped, rotating credentials. There is
no sign-in in the app.

- **Server choice** as on tvOS: netrics cloud at once, "Use your own server"
  until paired, the same `GET /v1/server` check, the same transport rules
  (HTTPS by default; the "Allow insecure connections" setting for local HTTP
  and pinned self-signed certificates). `Info.plist` keeps
  `NSAllowsLocalNetworking` only. iOS asks for local network access the first
  time the app reaches a local host, so the target has an
  `NSLocalNetworkUsageDescription` (English and German).
- **The approving person is often holding the device.** Besides the code
  and the QR code (which another phone can scan), the pairing screen offers:
  - **Share link**: the share sheet with `approveUrl`, to send it to an
    admin;
  - **Open approval page**: opens `approveUrl` in Safari, where the admin's
    own web session exists. After approving, the person returns to the app,
    which is still polling and shows the dashboard. This is the web sign-in,
    not a sign-in in the app: the app never sees a user credential;
  - **Copy code**.

  The app keeps polling while it is in the foreground and resumes with the
  same pairing when it returns, until the code expires.

- **No universal links in this milestone.** `netrics.tv/<CODE>` keeps
  opening the web approval page. The approval belongs to the admin side, so
  the later "netrics" admin app may claim these links to approve natively;
  netrics TV never does.
- **Unpair.** Settings → Unpair now also ends the device on the server: the
  app calls a new device endpoint (below) that revokes the device and its
  tokens, then clears the Keychain and caches as today. When the server is
  unreachable, or older and answers 404, unpair stays local as today and the
  device remains in the web list until revoked. tvOS adopts the same call.
  Revoking on the web works as today: the next request gets 401, the app
  forgets its credentials and shows a new code.
- **Credentials** stay in the Keychain, this device only, after first
  unlock. They are not in backups and do not move to a new phone: a new
  phone pairs anew. A device that is not opened for 90 days (the refresh
  token's lifetime) shows a new code.
- **Who approves.** Owners and admins, as today (`devices:manage`). A
  paired phone holds the workspace's dashboard without any user identity,
  so pairing stays an admin act.

**Server changes**, small and backward compatible; no `DEVICE_API_VERSION`
bump and no new payload schema (schema 3 is enough):

- **Platform.** `devices.platform` (`tvos`, `ipados`, `ios`, `web`, or null
  for "not reported"). The device reports it in an optional body of
  `POST /v1/device/pairings` (`{ platform }`; a missing body stays valid);
  the pairing keeps it and the approval copies it to the device. The
  heartbeat gains an optional `platform` too, so TVs paired before this
  change fill it in. It is self-reported and only steers defaults and
  labels, never access.
- **Defaults from the platform.** The approve form prefills the name
  ("Apple TV", "iPad", "iPhone", "Browser") and the server sets
  `display_mode` at approval: `scroll` for `ios`, `screen` otherwise. The
  form learns the platform from `POST /v1/device-pairings/lookup` (signed
  in, the code in the body); misses count as failed approvals, so the
  lookup is no cheaper a way to guess codes (#406).
- **Rotation** applies to `tvos` and `web` only. iPad and iPhone know their
  orientation, so the app ignores `rotation`, and the web hides the setting
  for them.
- **Device self-revoke.** `POST /v1/device/me/revoke` with the device access
  token revokes the calling device and all its tokens in one transaction,
  audited as `device.revoked` with the device as actor.
- **Device list.** Shows the platform. Phones and tablets are not expected
  to be on all the time, so for `ios` and `ipados` the list says "last
  opened …" instead of flagging them offline.

### 3. What each device shows

The payload, polling, caching and reflow are the tvOS client's
(`DeviceClient`, `ScreenView`, `formatFor`, `reflowSlide`). What differs is
the screen size source, the mode and the input.

**iPad: screen view, as on the TV.**

- The format comes from the **window's** size, not the screen's, and is
  recomputed live on every size change, like the browser kiosk (ADR 0017
  section 7): landscape iPads are `4x3`, portrait `3x4`. Rotation follows the
  device and its orientation lock.
- **Any window size.** Full screen, Split View, Slide Over and Stage
  Manager windows of any size get screen view in their format; ADR 0017
  section 2 (fill, stretch at most 4/3, then letterbox) covers odd sizes, and
  the size never changes the layout rules. One window only
  (`UIApplicationSupportsMultipleScenes` off): a device is one pairing, and a
  second window would show the same dashboard.
- The device setting `display_mode = scroll` gives the iPad scroll view in
  both orientations, for an iPad used in the hand.

**iPhone: scroll view in portrait, screen view in landscape.**

- **Portrait: scroll view** (ADR 0017 section 5), the default for phones:
  every enabled slide as a section, widgets in reading order on `scrollLayout`
  (one column), system type sizes with Dynamic Type, no rotation, pull to
  refresh.
- **Landscape: screen view**, full screen, in the phone's format (about
  2.16, so `21x9`), slides rotating as on the TV. Turning the phone switches
  between the two at once, offline too.
- The device setting `display_mode = screen` keeps screen view in portrait
  as well (`9x16`), for a phone on a desk stand.

Scroll view alone would waste the landscape phone, and screen view alone
would give a phone in the hand a canvas at `9x16` reading sizes. Both
renderers exist in the shared code, so the pair costs little.

**Touch instead of focus.**

- **Swipe** left and right in screen view changes the slide (or continuation
  page) and restarts its duration, as left and right on the remote do.
- **Tap a widget** for a detail sheet: label, value, period, comparison,
  source and "updated … ago", from the payload only (no new endpoint). In
  scroll view, tapping a card opens the same sheet.
- **Tap elsewhere** in screen view shows the chrome for a few seconds:
  pause or resume rotation, and settings. Long press is not used.
- **VoiceOver** gets the same actions as accessibility actions (next and
  previous slide, pause), and every widget reads its value, unit, period and
  freshness.

**Staying on: idle timer and kiosks.**

- While screen view is showing and the app is active, the app sets
  `isIdleTimerDisabled`, as tvOS does when paired. Scroll view follows the
  system's Auto-Lock: it is for a quick look.
- A **wall-mounted or desk iPad** is documented in a guide: Guided Access
  (triple-click, no supervision needed) or Single App Mode for supervised
  iPads (Apple Configurator or MDM), power, Auto-Lock, and mounting. The app
  needs no code for these: it never leaves screen view by itself, and its
  chrome hides again on its own. Autonomous Single App Mode and managed app
  configuration are not in this milestone.
- On OLED iPads the slide rotation and the Signal motion change the picture;
  the owner checks a long run for image retention at the exit gate.

**Background and offline.**

- No background polling. iOS suspends the app soon after it leaves the
  foreground, and a viewer has nothing to do there. On return
  (`scenePhase` active) the app shows the cached payload at once, refreshes
  the tokens when needed, polls with `If-None-Match` and sends a heartbeat.
- The offline cache is tvOS's: the last payload and images in Caches, the
  "Offline — last update HH:MM" header, the same back-off. iOS may purge
  Caches under storage pressure; the app then waits for the network, as a
  new TV does.
- `BGAppRefreshTask` is not used in this milestone; widgets are its first
  user (section 4).

### 4. Widgets: a follow-up, prepared now

Home Screen and Lock Screen widgets for a paired iPhone or iPad are **not
in this milestone**. They need their own design:

- **Budget.** WidgetKit decides when a timeline reloads, a few dozen times
  a day for a widget that is looked at often, never every minute. A widget
  must show its age ("updated 40 min ago", ADR 0018 freshness), not pretend
  to be live.
- **A small snapshot endpoint.** The device payload carries every slide,
  layouts and images. A widget needs a few headline numbers, so it would get
  its own read model (for example `GET /v1/device/snapshot`, a handful of
  metric values with sparkline and freshness, `ETag`), chosen per device on
  the web.
- **Token sharing.** The widget extension runs in its own process. If it and
  the app both rotate the same refresh token, ADR 0011's reuse detection can
  revoke the device. The follow-up must pick one rule: only the app
  refreshes and the widget uses a shared access token while it is valid, or
  the device gets a separate read-only token for its widgets.
- **Lock Screen privacy.** Workspace numbers on a locked phone need a
  redaction setting.

To avoid a re-pairing when widgets come, the iOS target ships from the
start with an App Group and a Keychain access group, and the credentials and
cache live there. Changing the access group later would strand the stored
credentials.

### 5. App Review, privacy and accessibility

- **Review path: a demo mode in the app.** The pairing screen gets "Try a
  demo" on all three platforms. It shows a sample dashboard bundled with the
  app (a schema 3 payload with demo-connector numbers and a theme), labelled
  "Demo" in the header, fully offline, until the person leaves it. A
  reviewer, or a curious first user, sees what the app does without an
  account; no real data is shown and nothing is sent. The review notes also
  give a reviewer workspace on netrics cloud with a web login, so the reviewer
  can pair for real. The tvOS app, which has neither today, gets both before
  its first submission.
- **Privacy manifest** (`PrivacyInfo.xcprivacy`) in both targets, and in the
  package for its own use: no tracking, no tracking domains; required-reason
  APIs declared (file timestamps for the image cache's eviction; user
  defaults for the debug launch arguments). App Privacy answers: the
  heartbeat sends diagnostics (app version, uptime, last error, screen) to
  the paired server, not linked to a person; on a self-hosted server netrics
  collects nothing.
- **Export compliance.** Only Apple's HTTPS and hashing (CryptoKit SHA-256
  for image checks and certificate pins): exempt.
  `ITSAppUsesNonExemptEncryption = NO` in both targets.
- **Accessibility** on touch devices: VoiceOver for every widget type and
  every screen (pairing, settings, demo); Dynamic Type in scroll view, in
  detail sheets and in the app's own screens (screen view keeps its fitted
  scale, which ADR 0017 sizes for reading at a distance); Reduce Motion as
  on tvOS; contrast from the theme tokens. The owner fills in Apple's
  accessibility labels on the product page from the exit gate's results.
- The pairing and settings screens use system controls, so they take the
  current system look. The dashboards keep the Signal theme tokens (ADR
  0018).

### 6. Self-hosted

Unchanged from ADR 0010: the same App Store app pairs with any netrics
server. The person chooses "Use your own server" and types the URL with the
device's keyboard; the server check, the reported pairing URL and the
transport rules are the same. A self-hosted server older than the server
changes above still pairs: it ignores the platform body, has no self-revoke
(unpair stays local) and shows no platform in its list.

## Alternatives considered

- **Separate App Store apps for Apple TV and iPhone/iPad.** Two records,
  two names, two listings, a second purchase if netrics TV ever costs
  money, and separate records can never be merged. One record with
  universal purchase is what Apple offers for exactly this case.
- **One multiplatform target** for tvOS and iOS. Xcode builds a separate
  binary per platform anyway, and Apple asks for a separate target for the
  tvOS build in a universal purchase. One target would mix focus and touch
  code behind `#if os` throughout, and the Info.plist, icons and Top Shelf
  differ. Two thin targets on shared packages keep each platform clear.
- **A web view wrapper around the kiosk** (`/kiosk` in `WKWebView`). Little
  code, but it renders unlike the TV, needs the network to start, has no
  Keychain credentials or certificate pinning of its own, and App Review
  rejects apps that are a wrapped website (guideline 4.2). The native
  renderers and reflow exist already.
- **Personal sign-in in the viewer.** Ruled out by the owner: sign-in,
  passkeys and workspaces belong to the later admin app.
- **Screen view only on iPhone.** A phone in the hand would show `9x16` TV
  layouts; ADR 0017 makes scroll view the phone default.
- **Scroll view only on iPhone.** Leaves the landscape phone without the
  slideshow, which the shared renderer gives for free.
- **Widgets in this milestone.** They need a new endpoint, a token-sharing
  rule and their own review, and would double the milestone; the App Group
  and Keychain access group keep them a pure addition.
- **tvOS 27 as the tvOS minimum.** Drops Apple TV HD and Apple TV 4K (1st
  generation), which tvOS 26 still serves; availability checks give the new
  APIs where they run.
- **Universal links for `netrics.tv/<CODE>` into netrics TV.** The link is
  for the approving admin, not the device being paired.

## Consequences

- One product, "netrics TV", on Apple TV, iPad and iPhone, and one App
  Store record that cannot be split later. The tvOS app's name changes
  before its first release.
- The tvOS rendering code moves into `NetricsUI`; the tvOS app must look and
  behave the same after the move. Each new widget type is drawn once for both
  platforms.
- CI needs GitHub's `xcode-27` runner image (Xcode 27 on macOS 27), and builds both app targets.
- The server gains `devices.platform`, an optional pairing body, an optional
  heartbeat field and the device self-revoke: one migration, no new payload
  schema. Released TVs and older servers keep working.
- The tvOS app gains the demo mode, the server-side unpair and a privacy
  manifest too.
- Widgets, background refresh, managed app configuration for MDM fleets,
  and native approval in the admin app are follow-ups.

## Owner answers (2026-10-30)

The owner accepted all eight recommendations:

1. **Display name** "netrics TV" on all three platforms, and the tvOS app
   renamed from "netrics".
2. **iPhone view:** scroll view in portrait, screen view in landscape, the
   device setting "Screen view" for both.
3. **Deployment targets:** iOS and iPadOS 27; tvOS 26 (keeps Apple TV HD and
   4K 1st generation).
4. **Widgets** in a follow-up milestone, with the App Group and Keychain
   access group set up now.
5. **Review path:** a bundled demo mode on all three platforms plus a
   reviewer workspace.
6. **Approval** stays with owners and admins, also for phones;
   editors pairing their own phone would need a new permission.
7. **Folder** `apps/tvos/` renamed to `apps/netrics-tv/`. Done once,
   with the toolchain change (T2).
8. **Mac and Vision Pro** availability off in App Store Connect for now.

## Open checks (exit gate)

- Window sizes on the current iPads, including Stage Manager's smallest
  window and Split View at one third, give a readable format with no
  truncation.
- The local network prompt appears once and a denial is explained.
- An OLED iPad Pro shows no image retention after a long run.
- App Review accepts the demo mode and the pairing-only flow on both
  platforms.
- The name "netrics TV" is free on the App Store.
