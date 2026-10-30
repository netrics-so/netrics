# netrics TV on an iPad on a wall or a desk

netrics TV turns an iPad into a dashboard screen: on a wall in the office,
by the door or on a desk. This guide sets one up so that it shows the
dashboard all day, cannot be used for anything else, and lasts.

You need:

- an iPad with iPadOS 27 and netrics TV installed,
- a netrics workspace where you are an owner or admin (or someone who is,
  to approve the code),
- a power supply and a cable long enough to reach the mount, and Wi-Fi
  where the iPad hangs.

The steps follow the order you set it up in: pair, keep it on, lock it to
the app, power, mounting. Apple's pages are linked for each iPad setting;
the names below are those of iPadOS 27.

## 1. Pair the iPad

1. Open netrics TV on the iPad. It shows a pairing code, the address where
   the code is entered and a QR code. It uses netrics cloud; to use your
   own netrics server, tap "Use your own server" first and enter its
   address as you open it in a browser.
2. Approve the code on the web. Any of these works:
   - Tap **Open approval page**. Safari opens the approval page, you sign in
     there (the app never sees your password) and come back.
   - Scan the QR code with your phone ("Or scan with another device").
   - Tap **Share link** to send the link to an owner or admin, or **Copy
     code**, or go to the address shown and type the code.
3. On the approval page, choose the workspace and the dashboard. The name is
   filled in as "iPad", because the iPad reports its platform with the code;
   change it to where it hangs, for example "Office lobby". Click **Connect
   TV**.

Only workspace owners and admins can approve a code. The iPad shows the
dashboard a few seconds later; if the app was in the background meanwhile,
it checks again as soon as it is opened.

The iPad now appears under **Screens** in netrics, with the platform
"iPad". There you
rename it, choose another dashboard, set its **Mode** or revoke it:

- **Screen view** (the default on iPad) shows the dashboard full screen in
  its slides, as on a TV. This is the mode for a wall or a desk.
- **Scroll view** shows every slide as a section to scroll through, for an
  iPad used in the hand.

An iPad has no orientation setting there: it knows which way it is
turned and lays out the dashboard for landscape (4:3) or portrait (3:4) by
itself.

In screen view the dashboard has no buttons on it. By hand:

- **Swipe** left or right to go to the next or previous slide; it then
  shows for its full time again. Swipes that start at the edge of the
  screen stay with iPadOS (Control Centre, the Dock, Slide Over).
- **Tap a widget** for its details: value, period, change, previous
  period, source and when it was last updated. They come from the
  dashboard on the iPad, so they work offline too.
- **Tap anywhere else** to show the controls for a few seconds: pause or
  resume the slides, and the settings button (**Leave demo** in the demo).
- With **VoiceOver**, each widget has the actions "Next slide", "Previous
  slide" and "Pause rotation", and the controls stay on screen.

Scroll view keeps the settings button in the corner, and tapping a card
shows the same details.

To try netrics TV first without an account, tap **Try a demo** on the
pairing screen. The demo shows a sample dashboard, sends nothing and stores
nothing; **Leave demo** returns to the pairing screen with a new code.

## 2. Keep the screen on

In screen view, netrics TV keeps the screen on by itself while it is open
in the foreground, so you do not need to change Auto-Lock for it. Scroll
view follows Auto-Lock like any other app, and so do the pairing screen
and the "No dashboard assigned yet" notice.

Auto-Lock is in **Settings → Display & Brightness → Auto-Lock**
([Apple: Keep the iPad display on longer](https://support.apple.com/guide/ipad/keep-the-ipad-display-on-longer-ipad11dbabaf/ipados)).
Leave it at a short time: if netrics TV is ever closed, the screen then
turns off instead of showing the Home Screen all day.

During a Guided Access session (next step), Guided Access has its own
**Display Auto-Lock** setting. If the screen still goes dark in a session,
set that one longer.

Also turn on a Focus such as Do Not Disturb, so that notifications do not
cover the dashboard.

## 3. Lock the iPad to netrics TV

So that no one walks off with the iPad into Mail or Settings, lock it to
netrics TV. There are two ways.

### Guided Access: any iPad, set up by hand

Guided Access needs no management and is set up on the iPad itself
([Apple: Lock iPad to one app with Guided Access](https://support.apple.com/guide/ipad/lock-ipad-to-one-app-ipada16d1374/ipados)).

1. Go to **Settings → Accessibility → Guided Access** and turn on **Guided
   Access**.
2. Tap **Passcode Settings → Set Guided Access Passcode** and choose a
   passcode that is not the iPad's own. Leave Face ID or Touch ID off if
   other people stand in front of the screen.
3. Go to **Settings → Accessibility → Accessibility Shortcut** and select
   **Guided Access**, so that a triple-click of the top button (or the Home
   button on iPads that have one) starts and ends it
   ([Apple: Quickly turn accessibility features on or off](https://support.apple.com/guide/ipad/quickly-turn-accessibility-features-on-or-off-ipad9a245f9e/ipados)).
4. Open netrics TV with the dashboard showing and triple-click the top
   button (or the Home button).
5. Tap **Session Settings** and choose:
   - **Touch** off for a wall: nothing on the screen reacts, so no one can
     open settings or unpair. On a desk where people should swipe between
     slides or tap a widget for its details, leave it on; settings are
     then a tap away too.
   - **Motion** off, so the iPad stays in the orientation it is mounted in.
   - **Top Button** and **Volume Buttons** off.
   - **Time Limit** off.
6. Tap **Done**, then **Start**.

To end the session, triple-click the top button (or the Home button) and
enter the Guided Access passcode. Guided Access is started by hand, so check
after a restart or a software update that the session is on again.

### Single App Mode: supervised iPads, managed

For iPads your organisation manages, Single App Mode (App Lock in device
management) opens netrics TV, prevents the use of other apps and reopens it
right after a restart. It needs a **supervised** iPad
([Apple: About Apple device supervision](https://support.apple.com/guide/deployment/about-device-supervision-dep1d89f0bff/web)):

- **Apple Configurator** on a Mac: supervising an iPad there erases it, and
  you need it at hand. Then select the iPad, choose **Actions → Advanced →
  Start Single App Mode**, pick netrics TV, set the options and click
  **Apply**
  ([Apple: Set Single App Mode in Apple Configurator](https://support.apple.com/guide/apple-configurator-mac/set-single-app-mode-cadbf9c172/mac)).
- **Device management (MDM)** for iPads enrolled with Automated Device
  Enrollment: the App Lock payload with netrics TV as the app
  ([Apple: App Lock payload settings](https://support.apple.com/guide/deployment/app-lock-payload-settings-dep80a981/web)).

Both offer the same switches as Guided Access and more: turn off Touch (for
a wall), Motion, Auto-Lock, the Sleep/Wake button and the volume buttons.
App updates still install while the iPad is locked to the app.

**Autonomous Single App Mode**, where an app locks itself in when it
starts, needs the app to ask for it
([Apple: requestGuidedAccessSession](<https://developer.apple.com/documentation/uikit/uiaccessibility/requestguidedaccesssession(enabled:completionhandler:)>)).
netrics TV does not, so use Single App Mode for managed iPads.

### Unpairing a locked iPad

With Touch off, settings cannot be opened on the iPad. To take it out of
service, revoke it under **Screens** in netrics: at its next update the
iPad forgets its credentials and shows a new pairing code. Otherwise end Guided
Access or Single App Mode, open settings in netrics TV and tap **Unpair this
device**.

## 4. Power

A wall or desk iPad stays plugged in all the time: with the screen on all
day, the battery alone does not last.

- iPad stops charging when the battery is full and starts again below 95
  percent, so it is safe to keep it connected
  ([Apple: About charging and maintaining your iPad battery](https://support.apple.com/en-us/118418)).
- On iPad Pro (M4) and later, iPad Air (M2) and later, iPad mini (A17 Pro)
  and iPad (A16), turn on **Settings → Battery → Battery Health → 80%
  Limit**. The iPad then charges to about 80 percent and holds it there,
  which wears the battery less. It still charges to 100 percent now and
  then to keep the percentage accurate
  ([Apple: Set a charge limit on iPad](https://support.apple.com/guide/ipad/set-a-charge-limit-ipadb3190c30/ipados)).
- Use the power adapter that came with the iPad or one of at least its
  wattage.
- Heat ages the battery. Apple names 16 to 22 °C as ideal and advises
  against charging above 35 °C: keep the iPad out of direct sun and away
  from radiators, and leave air around it.

## 5. Mounting

- **Orientation.** Landscape and portrait both work; netrics TV lays the
  dashboard out for 4:3 or 3:4. Studio's device preview shows how a
  dashboard looks in each, so choose before you drill. Turn Motion off in
  Guided Access or Single App Mode (or use the orientation lock in Control
  Center), so the picture does not turn when someone bumps the mount.
- **The mount.** Use a wall or desk mount made for your iPad model, with
  an opening for the cable. A lockable enclosure keeps the iPad on the
  wall.
- **The cable.** Plan the cable route from the outlet to the port before
  the mount goes up, and leave a little slack so the plug is not strained.
- **Wi-Fi.** Check the signal where the iPad hangs. If the network drops,
  netrics TV keeps showing the last dashboard with "Offline — last update"
  and the time in the header, and picks up again when the network is back.
- **Full screen.** Show netrics TV full screen. In Split View, Slide Over
  or a Stage Manager window it lays the dashboard out for the window's
  shape, which is rarely what a wall needs.
- **Height and light.** Hang it at eye height for the people who read it,
  away from windows that reflect in the glass.

## 6. OLED iPads: image retention

iPad Pro (M4) and later have a tandem OLED display (Ultra Retina XDR).
Apple notes that OLED displays can show a faint remnant of an earlier image
("image persistence"), which disappears after a few minutes, and that
burn-in can occur in more extreme cases, when the same high-contrast image
is shown at high brightness for long periods
([Apple: About the Ultra Retina XDR display on your iPad Pro](https://support.apple.com/en-us/119963)).
A dashboard on a wall is that case, so:

- **Lower the brightness.** Indoors, a dashboard reads well at well below
  full brightness. Keep **Auto-Brightness** on (**Settings → Accessibility →
  Display & Text Size**), which Apple says further reduces image
  persistence and burn-in.
- **Use more than one slide.** netrics TV rotates a dashboard's slides by
  their duration, and the values count up and the charts draw in on every
  change, so the picture changes. A dashboard with a single slide does not
  rotate: its layout and header stay where they are all day.
- **Turn it off when no one looks.** netrics TV has no night schedule. If
  the room is empty at night, lock the iPad (end Guided Access first) or
  switch it off.

iPads with an LCD (every other current model) do not have this risk.

## iPhone

netrics TV also runs on iPhone, paired the same way (the approval page
fills in "iPhone"). Held upright, an iPhone shows the scroll view: a quick
look in the hand, which follows Auto-Lock. Turned on its side it shows
screen view full screen (the `21x9` layout, `16x9` on an iPhone SE) with
the slides rotating, and the screen stays on while the app is open. For a
phone upright on a desk stand, set the device's **Mode** to "Screen view"
in netrics: it then shows screen view in portrait too (`9x16`) and stays
on. Guided Access works on iPhone the same way as above. For a phone that
stays on the charger, **Settings →
Battery → Charging** on iPhone 15 and later sets a charge limit
([Apple: Set a charge limit on iPhone](https://support.apple.com/guide/iphone/set-a-charge-limit-iph0777c60aa/ios)).

## Checklist

- [ ] Paired, the right dashboard, Mode "Screen view", named by where it
      hangs.
- [ ] A Focus on, so that notifications do not cover the dashboard.
- [ ] Guided Access (with its own passcode) or Single App Mode, Touch and
      Motion off for a wall.
- [ ] Plugged in; 80% Limit on where the iPad has it.
- [ ] Mounted out of the sun, cable with slack, Wi-Fi checked.
- [ ] On OLED iPads: lower brightness, Auto-Brightness on, more than one
      slide.
