# 0017 — Screen formats, adaptive layouts and display modes

Status: accepted (2026-10-04, owner decision; milestone 09.2, #273–#285)

## Context

ADR 0015 made every slide a 16:9 canvas with a 12 × 8 grid. Every client
derives pixel positions from `studioLayout` (`packages/domain`, ported to
Swift in `apps/tvos/NetricsKit`, shared JSON vectors), with
`u = canvas height / 1080` as the text unit. Today:

- The web player (`/tv`, Play, the kiosk) and tvOS letterbox the largest
  16:9 canvas on the screen (`width: min(100vw, calc(100vh * 16 / 9))`,
  `SlideCanvasView`). A portrait screen shows a small band in the middle; a
  phone shows a canvas a few centimetres high.
- The dashboard page in the web app shows the same canvas with slide tabs,
  scaled down to the page width.
- The device payload is schema 2 (`?schema=2`, ADR 0015 section 7) with a
  fixed `grid: { columns: 12, rows: 8 }`; the released tvOS code has 12
  columns as a constant. Devices send a heartbeat (app version, uptime, last
  error) but nothing about their screen.

The owner decided on 2026-10-04 (recorded here in substance):

1. **Dashboards must work on any screen**: landscape TVs (16:9), portrait
   TVs (9:16), other aspect ratios (21:9 ultra-wide, 4:3, 16:10), tablets in
   portrait and landscape, phones (native apps later), and a desktop browser
   used as a standby screen. **The Studio previews** how the same dashboard
   looks on each.
2. **Layout model "Auto + custom".** The user designs once, in one primary
   format (for example 16:9). netrics reflows the design automatically for
   every other format, preserving reading order, grouping and the
   readability rules (no silent truncation, minimum sizes). Per format the
   user can switch to **custom** and arrange widgets by hand; that format's
   placements are stored separately, and auto keeps working for the formats
   left on auto. Editing the primary layout must not silently break custom
   layouts: widgets added later are placed automatically into custom formats
   and flagged.
3. **Two display modes.**
   - **Scroll view** (German "Scroll-Ansicht") scrolls: on a phone one
     column, slides become sections; quick numbers on the go. It shows
     everything the dashboard has, clocks and slide backgrounds included.
   - **Screen view** (German "Bildschirm-Ansicht") fits the screen, rotates
     slides and never scrolls: a standby tablet or desktop, or a TV.

   TVs are always screen view. Phones and tablets default to scroll view
   and can switch to screen view. Desktop and the web kiosk are screen
   view. In the owner's words: "some would love to have this on their
   go… scrolling would be fine. Some will use it on desktop as standby
   mode device and don't want to scroll."

Follow-up answers of the same day: each continuation page shows for the
full slide duration; scroll view shows every widget and slide background;
the signed-in dashboard page on a desktop defaults to screen view; scroll
view is automatic only for now (order from the primary layout), custom
order or hiding in scroll view is possible future work; and the
user-facing names are "Scroll view" / "Screen view" (an earlier working
name, "Glance" / "Display", was not understood). Code uses the same words:
`displayMode: "scroll" | "screen"`.

Constraints from earlier decisions: TV readability first (ADR 0015
section 8: minimum text sizes, labels never cut silently, values scale then
go compact); web and tvOS place widgets identically from one pure module
with shared vectors; released tvOS builds keep working (schema negotiation
through `dashboardSchemas`, never a `DEVICE_API_VERSION` bump); tenant
isolation twice; one source, same commit; English and German for every new
string (ADR 0016).

## Decision

### 1. Format classes

A **format** is an aspect-ratio class with its own grid and reference
canvas. There are five, a closed list in `packages/domain`
(`SCREEN_FORMATS`), mirrored in Swift:

| Key    | Name (en)             | Aspect | Grid (cols × rows) | Reference canvas | Typical screens                                  |
| ------ | --------------------- | ------ | ------------------ | ---------------- | ------------------------------------------------ |
| `16x9` | TV (16:9)             | 1.78   | 12 × 8             | 1920 × 1080      | TVs, Apple TV, most monitors, 16:10 laptops      |
| `21x9` | Ultra-wide (21:9)     | 2.33   | 16 × 8             | 2520 × 1080      | ultra-wide monitors, phones in landscape         |
| `4x3`  | Classic (4:3)         | 1.33   | 9 × 8              | 1440 × 1080      | iPads and other tablets in landscape, 5:4 panels |
| `3x4`  | Tablet portrait (3:4) | 0.75   | 6 × 10             | 1080 × 1440      | tablets in portrait                              |
| `9x16` | Portrait (9:16)       | 0.56   | 6 × 14             | 1080 × 1920      | portrait TVs and signage, phones in portrait     |

**`16x9` stays the default primary format with exactly today's grid and
geometry.** Every existing dashboard is a `16x9` dashboard and renders on a
16:9 screen pixel for pixel as before.

**Why these grids.** The text unit is the short edge: `u = short edge of the
reference canvas / 1080`, so a unit is the same physical share of the
screen in every format, and the reference canvases all have a 1080-unit
short edge. The grids are chosen so a cell is about the same size in units
everywhere: 138–156 units wide and 103–116 high, against today's 140 × 104
at 16:9. Consequences:

- The minimum widget sizes of ADR 0015 section 2 (metric 3 × 2, line and
  bar 4 × 3, image 1 × 1, text and clock 2 × 1) mean the same thing in every
  format, and the minimum text sizes still fit. No format needs its own
  minimums.
- A grid row is the same height in units in every format, so heights carry
  over between formats unchanged; only widths are rescaled (section 3).
- The owner's suggestion of 16 × 6 for ultra-wide would make cells taller
  than wide and change the row height; 16 × 8 keeps the row and the type
  scale identical to 16:9.

**Mapping a real screen to a format.** A screen reports its size in CSS
pixels (web) or points (tvOS, later iOS), after any rotation (section 7).
`formatFor(width, height)` picks the format whose aspect ratio is closest
on a log scale. The boundaries are the geometric means of neighbours:

| Screen aspect `a = width / height` | Format |
| ---------------------------------- | ------ |
| `a ≥ 2.04`                         | `21x9` |
| `1.54 ≤ a < 2.04`                  | `16x9` |
| `1.00 ≤ a < 1.54`                  | `4x3`  |
| `0.65 ≤ a < 1.00`                  | `3x4`  |
| `a < 0.65`                         | `9x16` |

So 16:10 (1.6) and 3:2 (1.5, just below) fall on either side of the 16:9 /
4:3 boundary, a square screen is `4x3`, and a phone in portrait (about
0.46) is `9x16`.

**Size classes.** Size decides the default mode and the scroll view columns,
never the screen view layout: **compact** (short edge < 600 px/pt: phones),
**regular** (600–1099: tablets, small windows) and **large** (≥ 1100:
desktops, TVs). The unit already scales text with the screen, and handhelds
are viewed from much closer than TVs (a 30-unit title is about 0.4° of view
on a 55" TV at 3 m and about 0.5° on a phone at 35 cm), so screen view needs no
separate scale per size class.

### 2. Screen view on any aspect ratio: fill, then letterbox

A screen in screen view renders its format's grid over the **whole
screen**, not a fixed-aspect canvas:

- `u = min(width / refWidth, height / refHeight)` of its format's reference
  canvas, so text is never larger than the narrower dimension allows. On a
  16:9 screen this is exactly today's `height / 1080`.
- The grid fills the screen, inset by the padding, with the header band
  (`0.07 × 1080 × u`, unchanged at 16:9) above it. Cells therefore stretch
  in the screen's longer direction when its aspect differs from the
  format's: a 16:10 screen gets cells 11 % taller, never narrower. Label fit
  (section 6) is measured at the reference width, so a stretched cell only
  ever has more room.
- The stretch is capped at 4/3 in either direction. A screen beyond that
  (32:9 super-ultra-wide, a 1:3 signage strip) letterboxes the capped canvas
  in the centre; the bars are the theme's `background` colour, and a slide
  background image covers the whole screen including the bars. Inside the
  class boundaries the stretch is at most about 1.15 for 16:9 screens and
  reaches 4/3 only for a square screen, so letterboxing only occurs on
  extreme screens.

The geometry moves into `studioLayout` as `screenFrame(screen, format,
showHeader)` and `placementRect(placement, frame)`; the existing 16:9
functions (`studioFrame`, `widgetRect`) are exactly their `16x9` case and
keep their vectors.

### 3. Auto layout: the reflow algorithm

`reflowSlide(widgets, from, to)` is pure and deterministic, in
`packages/domain`, ported to Swift, with JSON vectors that both suites run
(`packages/domain/test-vectors/screen-formats.json`, generated like
`studio-layout.json`). The vectors are normative; the steps below describe
them. Input: a slide's widgets with type and placement in the primary
format `from`; output: one or more **pages**, each a list of placements in
`to`. When `to` is the primary format the result is the primary layout as
one page.

1. **Bands (grouping by rows).** Sort widgets by `(y, x)`. A band is a
   maximal run in which each next widget starts above the band's current
   bottom (`y < max(y + h)`). Widgets side by side in the design stay in one
   band.
2. **Stacks (grouping by columns within a band).** Sort a band's widgets by
   `(x, y)`. A stack is a maximal run in which each next widget starts left
   of the stack's current right edge. Two metrics stacked beside a chart
   form one stack; the chart another. Widgets in a stack are ordered by
   `(y, x)`.
3. **Reading order** is band by band, stack by stack, top to bottom within a
   stack (`studioReadingOrder`). Scroll view (section 5), the Studio's keyboard
   order in non-primary formats and screen readers use the same order.
   Schema 1's tile order (ADR 0015 section 7) is unchanged.
4. **Stack size.** With `s = to.columns / from.columns`, a stack spanning
   columns `left … right` in the primary gets width
   `round(right × s) − round(left × s)` (edges are rounded, so neighbours
   neither overlap nor leave gaps; `round(v) = floor(v + 0.5)`), at least
   the largest minimum width of its widgets, at most `to.columns`. Heights
   keep their rows (a row is the same size in every format). A stack taller
   than `to.rows` (only from a portrait primary) is split between widgets
   into consecutive stacks; a single widget taller than `to.rows` gets
   `h = to.rows`, which is never below a minimum height.
5. **Shelves.** Stacks are laid out in reading order on shelves (horizontal
   strips of the page, `to.columns` wide). Every band starts a new shelf, so
   rows of the design stay rows. When a band fits on one shelf, its stacks
   keep their scaled positions (`x` is the stack's rounded scaled left
   edge, moved right past the previous stack and left so that it and the
   stacks after it end inside the grid), so deliberate gaps survive. When it does not,
   the band wraps: the greedy count of shelves is kept, the stacks are
   spread over them as evenly as possible by count (earlier shelves take
   the extra one; greedy placement when the even split does not fit), and
   each wrapped shelf is justified: spare columns go one at a time to its
   stacks, left to right, repeating. Four 3 × 2 metrics in a row become a
   2 × 2 block on `9x16` and `4x3`, and four 4 × 2 metrics in one row
   on `21x9`.
6. **Heights within a shelf.** A shelf is as high as its highest stack;
   every stack is stretched to the shelf height, the extra rows going to
   its last widget. Widgets in a stack are placed top to bottom at the
   stack's x and width.
7. **Pages.** Shelves are placed top to bottom; a shelf that does not fit
   in the rows left starts a new page. Nothing is ever shrunk below its
   minimum size and nothing is dropped: overflow becomes **continuation
   pages** (no silent truncation). In the rotation, each page shows for the
   slide's full duration, and the header shows the slide name with "1/2",
   "2/2".
8. **Vertical fill.** Spare rows at the bottom of a page are given to its
   shelves one at a time, top to bottom, repeating, but a shelf grows by at
   most half its height (rounded down); rows still left over centre the
   content vertically (the offset rounded down). A landscape design on a
   portrait TV then fills the screen without turning a small metric into a
   column.

The algorithm runs per slide; slides with no widgets stay one empty page.
Complexity is trivial (at most 16 widgets per slide).

### 4. Custom layouts and how they stay in sync

Per slide and format, a layout is **auto** (computed by section 3, never
stored) or **custom** (stored placements). The primary format is always the
stored design. "Customize" in the Studio starts a custom layout from the
current auto result; "Reset to auto" deletes it.

A custom layout has one or more pages (at most 8), places every widget of
the slide exactly once **or marks it hidden in that format** (an explicit
choice the Studio lists under the canvas, never a silent drop), and obeys
the format's grid, the minimum sizes and no overlap per page. The server
validates this on every save.

Sync rules when the primary changes (`completeCustomLayout(custom,
primary, format)`, pure and shared, run by the server on every save):

| Change in the primary (or slide)                                                    | Effect on each custom layout                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Widget added                                                                        | Placed automatically: the first free spot of its minimum-or-reflowed size on the page of its reading-order neighbour, else a new last page. Flagged **placed automatically**. |
| Widget moved or resized                                                             | Nothing; the custom placement is the user's.                                                                                                                                  |
| Widget deleted                                                                      | Its placements go with it (foreign key cascade); the hole stays.                                                                                                              |
| Widget type changed so the custom placement is now below the minimum, or overlapped | Re-placed as if added, flagged.                                                                                                                                               |
| Widget moved to another slide                                                       | Treated as deleted on the old slide and added on the new.                                                                                                                     |

A flag clears when the user moves, resizes or confirms the widget in that
format ("Looks good"). Flags are shown on the format switcher ("4:3 · 2 to
review") and on the widget; they never block a save or a screen, because
an automatically placed widget is still valid and readable. Formats on auto
need none of this: they follow every primary edit.

**Changing the primary format** of a dashboard (for example designing for
portrait screens) re-bases it: the old primary layout becomes a custom
layout of its format, and the chosen format's current layout (auto or
custom) becomes the primary. This is lossless. A format whose layout has
continuation pages cannot become primary until it fits one page per slide;
the Studio says why and offers to move the overflow to new slides.

### 5. Display modes: screen view and scroll view

| Mode            | Behaviour                                                                                                                                                                                                                         | Used by                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Screen view** | The screen's format (section 1), its auto or custom layout, the whole screen (section 2), slides and continuation pages rotate, no scrolling, the TV type scale.                                                                  | Apple TV (always), browser kiosk devices (default), `/tv`, Play, the dashboard page on large screens, and on phones and tablets when the user switches. |
| **Scroll view** | One scrolling page: the dashboard header, then each enabled slide as a **section** (its name as a heading), its widgets in reading order in a responsive column layout, with the platform's type scale. No rotation, no canvases. | The dashboard page on phones and tablets (default), kiosk devices set to scroll view, later the native mobile apps.                                     |

**Default and switching.** `defaultDisplayMode(screen)` in the domain: an
Apple TV is screen view and cannot switch; a paired kiosk follows its device
setting (section 7, default screen view); a signed-in browser uses scroll view when
the size class is compact or regular **and** the primary pointer is coarse
(phones, tablets), else screen view (so a desktop defaults to screen view).
On the dashboard page a "Scroll view / Screen view" switch overrides the
default, remembered per browser (local storage). Screen view
on a phone or tablet offers full screen and keeps the screen awake (Wake
Lock API) where the browser allows it.

**Scroll view layout** (`scrollLayout(widgets, width)` in the domain, so the
future apps share it; vectors like section 3):

- Columns by width: 1 below 600 px, 2 below 1024, else 3 (content at most
  1200 px wide, centred).
- Line and bar charts, and text and image widgets at least 6 columns wide
  in the primary, span the full row; everything else one column. Items flow
  in reading order without reordering ("dense" packing would break the
  order), so a full-width item after a half-filled row leaves the gap.
- Heights by type: metric cards fit their content; charts are 16:9 of their
  width, at least 200 px; images keep their aspect, at most 50 % of the
  viewport height; text fits its content.
- **Everything is shown.** Clock widgets are compact cards (one column)
  ticking locally in the workspace time zone, as on screens. A slide's
  background image is the backdrop of its section (covering the section,
  scrolling with it, `cover`), under the slide's dim; widgets keep their
  theme `surface` cards and the section heading sits on a `surface` band,
  so text contrast never depends on the image. Disabled slides are
  skipped, as on screens.
- Type scale: the web app's own sizes in `rem` (they follow the browser's
  text size and zoom; Dynamic Type in the later apps), with the same rules
  as section 8 of ADR 0015: titles and resource lines wrap and are never
  truncated, values shrink to a minimum and then switch to the compact form.
- Scroll view is always automatic in this milestone: the order comes from
  the primary layout (`studioReadingOrder`). A custom scroll-view order or
  hiding a widget only in scroll view is possible future work, not part of
  this milestone.

### 6. Readability per format

The ADR 0015 section 8 rules apply per format:

- `labelFit(label, widget, { format })` measures at that format's reference
  canvas. Cells differ by a few units between formats and auto widths are
  rounded, so a label that fits at 16:9 can wrap to a third line elsewhere;
  the check runs for every format, auto and custom, and the Studio flags
  it.
- Minimum widget sizes are the same in cells everywhere (section 1); the
  server refuses custom placements below them, as for the primary.
- Overflow is never truncation: auto adds continuation pages (section 3,
  step 7); the Studio shows "continues on 2 pages" per format.
- The header in narrow formats (`3x4`, `9x16`): the dashboard name wraps to
  two lines before it shrinks; the slide name is dropped before the name is
  cut, and the Studio warns when the name does not fit in the narrowest
  format a screen of the workspace uses.
- `formatWarnings(slide, format)` returns these per slide and format, for
  the Studio's badges and the dashboard API (section 8). Templates (ADR 0015
  section 9) are tested to produce no warnings in any format.

### 7. Devices: orientation, mode and screen reporting

**tvOS cannot know that a TV is rotated.** An Apple TV always outputs a
landscape signal, tvOS has no display rotation setting, and UIKit reports a
landscape screen on tvOS with no orientation API to ask. A portrait TV on
an Apple TV is therefore a netrics setting:

- `devices.rotation`: `0`, `90`, `180` or `270` degrees (default 0), set per
  device in the web app's TV list. The client rotates its whole rendering
  by that angle, so a TV mounted on its side shows an upright `9x16`
  dashboard. The rotated screen size (1080 × 1920 points for a 1080p TV
  turned 90°) is what goes into `formatFor`. 180 covers screens mounted
  upside down.
- The pairing screen is shown unrotated (the setting is unknown before
  pairing); every screen after pairing, including "no dashboard assigned"
  and offline notices, follows the setting.

**Browser kiosk.** The kiosk always uses the real viewport
(`ResizeObserver` on the root, `100dvh`, safe-area insets), so a monitor
rotated by its operating system, a window of any size or a tablet that
turns simply changes the format, live and without a reload. The same
`rotation` setting applies too, for players that cannot rotate their own
output (some smart-TV browsers and signage sticks): the kiosk then rotates
its root with a CSS transform.

**Mode per device.** `devices.display_mode`: `screen` (default) or
`scroll`, for kiosk devices; tvOS ignores it (always screen view). A tablet on a
desk paired as a kiosk is a standby screen, hence the default.

**Screen reporting.** The heartbeat gains an optional `screen` object:
`width`, `height` (CSS px or points after rotation, integers 1–16384),
`scale` (device pixel ratio, 0.5–8), `format` and `mode`. The server stores
the latest report on the device (`devices.screen` jsonb, validated by zod)
and shows it in the TV list ("4K · 16:9 · Screen view", "1080 × 1920 · 9:16").
The Studio uses it to mark the formats that screens of the workspace
actually use. Older apps send no `screen`; nothing changes for them.

### 8. Data model and API

Migration (the next free number when it is written; 0037 is expected):

- `dashboards.primary_format text not null default '16x9'`, checked against
  the five keys. Every existing dashboard is `16x9`.
- `dashboard_widgets`: `x`, `y`, `w`, `h` stay the **primary** placement. The
  check constraint is relaxed from the 12 × 8 grid to the largest grid
  (`x + w ≤ 16`, `y + h ≤ 14`); the service validates the exact grid of the
  dashboard's primary format, as it already validates overlap. Existing
  rows satisfy the relaxed check.
- `dashboard_slide_layouts` (one row per custom slide × format): `slide_id`,
  `format`, `workspace_id`, `dashboard_id`, `pages` (1–8), timestamps;
  primary key `(slide_id, format)`; FK `(slide_id, workspace_id)` on delete
  cascade; a check that `format` is one of the keys.
- `dashboard_widget_layouts` (one row per widget × custom format):
  `widget_id`, `format`, `slide_id`, `workspace_id`, `page` (0–7), `x`, `y`,
  `w`, `h` (checked against the largest grid), `hidden` boolean,
  `auto_placed` boolean (the review flag); primary key `(widget_id, format)`;
  FK `(widget_id, workspace_id)` and `(slide_id, format, workspace_id)` on
  delete cascade.
- `devices.rotation smallint not null default 0` (check in 0, 90, 180,
  270), `devices.display_mode text not null default 'screen'`,
  `devices.screen jsonb null`.

All new tables are under RLS with the usual policies and every query has
explicit `workspace_id` predicates; cross-workspace tests for each. Existing
data needs no rewrite: every dashboard is `16x9` with no custom layouts, so
every other format is auto. The migration is tried on data in the previous
shape (studio dashboards with several slides, migrated tile dashboards,
paired devices with heartbeats).

**Dashboard document.** `GET/PUT …/dashboards/:id` gain `primaryFormat` and,
per slide, `layouts: [{ format, pages, placements: [{ widgetId, page, x, y,
w, h, hidden, autoPlaced }] }]` for custom formats only (formats not listed
are auto). `PUT` validates each custom layout (grid, minimums, overlap per
page, every widget placed or hidden), runs `completeCustomLayout` and
returns the completed document; the version check is unchanged. GET also
returns `formatWarnings` per slide and format (read-only). A client that
does not send `layouts` (a Studio tab from before this change) keeps the
stored custom layouts: absent means unchanged, an empty array means "all
auto". `primaryFormat` absent means unchanged. Duplicate copies layouts.
Templates create `16x9` dashboards.

**Device settings.** `PATCH /v1/workspaces/:w/devices/:id` accepts
`rotation` and `displayMode`; the device read model returns them and the
latest `screen`. Permission and audit as for renaming (`devices:update`,
`device.updated`).

### 9. Device payload: schema 3, clients reflow

**Decision: the payload is format-independent and clients reflow locally.**
The server sends the primary layout and the custom layouts; each client
runs `formatFor` and `reflowSlide` for its own screen. Reasons:

- One payload per dashboard version, so the 30-second memo (ADR 0015
  section 7) and `ETag`s stay shared by every screen showing the dashboard.
- A screen that turns, a kiosk window that is resized or a TV whose
  rotation setting changes re-lays out instantly and offline, with no round
  trip.
- The web needs the TypeScript function anyway (Studio preview of unsaved
  edits), and the Swift port follows the established pattern of
  `StudioLayout.swift` with shared vectors. The future mobile apps reuse it.

`GET /v1/device/dashboard?schema=3` returns schema 2's content plus:

```jsonc
{
  "schema": 3,
  "primaryFormat": "16x9",
  "formats": {                       // every format's grid, so clients need no table
    "16x9": { "columns": 12, "rows": 8, "reference": [1920, 1080] }, …
  },
  "device": { "rotation": 90, "displayMode": "screen" },
  "slides": [{
    "id": "…", …,                    // widgets carry their primary x, y, w, h
    "layouts": [{ "format": "9x16", "pages": 2,
                  "placements": [{ "widgetId": "…", "page": 0, "x": 0, "y": 0,
                                   "w": 6, "h": 3, "hidden": false }] }]
  }]
}
```

(`grid` is dropped in schema 3; `formats` replaces it.) `autoPlaced` is not
sent to devices. Server info lists `dashboardSchemas: [1, 2, 3]`; a client
asks for the highest it supports, as today.

**Old clients keep working.**

- Schema 1 is unchanged (metric widgets as tiles in reading order).
- Schema 2 keeps its exact shape and always describes the **`16x9`
  layout**: the primary when the primary is `16x9` (every dashboard today),
  else the custom or auto `16x9` layout computed on the server with the same
  domain function. Continuation pages become extra slides with
  deterministic ids (a name-based UUID of slide id and page), so released
  tvOS builds rotate through them. Released apps keep letterboxing 16:9, as
  today.

The memo key gains nothing new (schema is already part of it); the device
settings are part of the payload hash, so a rotation change reaches the TV
within one poll.

### 10. Studio preview and custom editing

- **Format switcher** above the canvas: one chip per format plus "Phone
  (Scroll view)", in this order: the primary first, then 16:9, 9:16, 21:9, 4:3,
  3:4, Phone (Scroll view). Each chip shows its state: _Primary_, _Auto_,
  _Custom_, "_n_ to review" and a warning count; formats used by a paired
  screen (section 7) carry a screen marker.
- **Device frames.** The selected format renders inside a simple CSS frame
  (TV bezel, rotated TV, monitor, tablet, phone) with the real screen view or
  scroll view renderer and live data, so the preview is what the screen shows.
  Phone also has a screen view preview (the `9x16` layout in a phone frame).
  "All formats" shows every frame side by side as thumbnails.
- **Auto formats are read-only** with a "Customize" button; pages appear as
  tabs ("Page 1 of 2").
- **Custom editing** reuses the canvas editor of ADR 0015 section 9 on the
  format's grid (move, resize, snap, keyboard, no overlap) plus pages (add,
  move a widget to another page), "Hide in this format" and the hidden
  list, "Looks good" for flagged widgets and "Reset to auto". The live
  region announces format and page.
- **Primary format** is chosen when creating a dashboard (default 16:9) and
  changed in dashboard settings (section 4, re-basing).
- **Readability** badges per format from `formatWarnings`; the Save button
  is not blocked by warnings, as today.

### 11. Web surfaces

| Surface                           | Mode                                 | Format source                       |
| --------------------------------- | ------------------------------------ | ----------------------------------- |
| `/kiosk` (paired device)          | device setting, default screen view  | real viewport, plus device rotation |
| `/workspaces/…/dashboards/:id/tv` | Screen view                          | real viewport                       |
| Studio Play                       | Screen view                          | real viewport                       |
| Dashboard page                    | default by section 5, user switch    | real viewport (Screen view)         |
| Studio canvas and preview         | the chosen format, in a device frame | the switcher                        |

The dashboard page's current slide tabs become the screen view of the
page; the full-screen rotation stays `/tv`.

### 12. Performance and security

Nothing new in kind. The payload grows by the custom placements (at most
5 formats × 16 widgets × 12 slides, about 40 KB in the worst case, typically
none). Reflow is a few hundred integer operations per slide on the client.
Heartbeat `screen` values are bounded numbers and enum keys, stored per
device, never logged beyond the existing request log. Device settings use
the existing permission and audit. The new tables follow the tenant rules
above. No new dependency: device frames are CSS, rotation is a transform,
Wake Lock and `ResizeObserver` are platform APIs.

## Alternatives considered

- **One canvas, letterboxed everywhere (today).** Simple, but portrait TVs
  and phones show an unreadable band. Rejected by the owner's decision.
- **Free responsive layout everywhere (CSS grid breakpoints, no screen view
  grid).** Fine for scroll view, but screen view on TVs needs deterministic placement
  identical on web and tvOS and the readability floor at distance.
- **A continuous unit-based grid** (columns = screen width / cell pitch, so
  every aspect ratio gets its own column count). It would avoid stretch, but
  a custom layout would have no fixed grid to be stored against, the Studio
  could not preview a finite set, and vectors would need to cover a
  continuum. Five classes with bounded stretch keep layouts storable and
  testable.
- **More classes** (16:10, 3:2, 32:9 separately). The stretch inside a
  class stays small (about 1.15 around 16:9); more classes would multiply custom layouts
  and Studio chips without a visible gain. A class can be added later
  (a new key, grid and vectors; existing layouts are unaffected).
- **Merging 3:4 into 9:16.** Tablets in portrait would be stretched by
  1.33 or letterboxed; 3:4 is common enough (iPads) to have its own grid.
- **16 × 6 for ultra-wide** (the owner's example). It changes the row height
  and makes cells taller than wide; 16 × 8 keeps the type scale.
- **Proportional scaling plus "gravity" compaction** (as general grid
  libraries do for breakpoints). It staggers widgets when minimum widths
  force overlaps and loses the grouping of stacked widgets; bands and stacks
  keep design rows and columns together.
- **Shrinking widgets below their minimum to fit one page.** Violates the
  readability floor. Rejected for continuation pages.
- **Server-side reflow per device class** (the device reports its format,
  the server returns placements). It keeps tvOS simpler, but splits the
  memo per class, needs a round trip on every resize or rotation and does
  not help the Studio, which needs the function client-side anyway.
- **Custom layouts as jsonb on slides.** One column and an easy document
  save, but no foreign keys: deleted widgets would leave stale placements
  for the service to clean. Two small tables with cascades keep integrity
  in the database, like the rest of the Studio model.
- **Detecting rotation on tvOS.** There is no API for it; the HDMI signal
  is landscape. A per-device setting is the only reliable source.
- **Swipeable pages for scroll view.** Gesture conflicts in mobile browsers and
  worse accessibility than one scroll page with section headings; the native
  apps can add paging later on the same `scrollLayout`.
- **A new `DEVICE_API_VERSION`.** Released apps would refuse the server;
  schema negotiation already solves this (ADR 0015).

## Consequences

- `studioLayout` grows from one grid to five; every function that takes a
  canvas gets a format. The 16:9 vectors stay valid and a second vector
  file covers formats, reflow and scroll view. Each new widget type must state
  its behaviour in scroll view.
- The Swift port gains `formatFor`, `screenFrame`, `reflowSlide` and
  rotation; schema 3 support ships in a tvOS update. Released builds stay
  on schema 2 with the `16x9` layout.
- Custom layouts add work to every dashboard save (validation and
  completion), bounded by the Studio limits.
- The device contract gains schema 3; schema 2 is now a server-side
  projection to `16x9`. Removing schema 1 and 2 later is tracked with the
  tvOS release notes, as before.
- The web dashboard page becomes usable on phones (scroll view), which also
  prepares the native mobile apps (a later milestone): they need only
  renderers, not layout decisions.
- Device settings grow (rotation, mode) and the TV list shows each
  screen's size and format.
- New UI strings (format names, modes, review flags) are added in English
  and German (ADR 0016).
