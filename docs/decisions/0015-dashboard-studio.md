# 0015 — Dashboard Studio: slides, widgets, themes and images

Status: accepted (2026-10-04, coordinator decision; milestone 09, #213–#227)

## Context

Dashboards today are an ordered list of tiles (#49). Every tile is the same
widget (big number, change, sparkline). The web TV layout, the browser kiosk
and the tvOS app lay the tiles out automatically (`tvGrid`): every tile on
one screen, cells close to 1.2:1 (ADR 0007). Devices read
`GET /v1/device/dashboard`, a JSON read model with an `ETag`, and render it
natively.

The owner asked for a "Dashboard Studio": dashboards with several slides,
different widgets on each, with style, data and name defined per widget;
create, order, adjust and assign slides, and set how they rotate. As a first
test there is one generic "Overview" and one dashboard per brand with its
logo, so an image widget is needed, and themes.

Product rules that apply:

- Hosted is a few clicks; self-hosted has the same features.
- One source, same commit (ADR 0013): nothing environment-specific at build
  time. Self-hosters run one database and the signed images.
- Tenant isolation twice: RLS under `netrics_app` and explicit
  `workspace_id` predicates.
- Secrets never appear in logs, errors or responses.
- **TV readability comes first.** Tile titles and app names must be fully
  readable on a TV at a distance (#194, #203, #208 were about exactly that).

This ADR fixes the model, the API and device contract, the migration of
existing dashboards, image handling, themes, rendering rules for TVs, and the
editor's technical choices. Milestone 09 implements it.

## Decision

### 1. Model

A dashboard is an ordered list of **slides**. Each slide holds **widgets**
placed on a fixed grid. A dashboard has one theme, a rotation and an
optional brand (accent colour and logo).

**Canvas and grid.** Every slide is a 16:9 canvas with a grid of
**12 columns × 8 rows**. A cell is then about 1.19:1, the aspect ratio
today's tiles are tuned for. A widget has `x`, `y` (0-based cell) and `w`,
`h` (cells). It lies inside the grid (`x + w ≤ 12`, `y + h ≤ 8`), and widgets
on one slide do not overlap. Every client derives pixel positions from the
same function (section 8), so web, kiosk and tvOS place widgets identically.
The optional dashboard header (name, slide name, clock, offline marker) takes
a fixed band of 7 % of the canvas height above the grid. Without the header
the grid fills the canvas.

**Tables** (all workspace tables under RLS with the usual policies;
composite foreign keys `(…_id, workspace_id)` keep every row in the
workspace of its parent, like `dashboard_tiles` today):

`dashboards`: existing columns, plus

| Column                  | Type       | Notes                                                  |
| ----------------------- | ---------- | ------------------------------------------------------ |
| `show_header`           | boolean    | default true                                           |
| `auto_advance`          | boolean    | default true; false shows only the first enabled slide |
| `default_slide_seconds` | integer    | default 20, 5–3600                                     |
| `transition`            | text       | `none` or `fade` (default `fade`)                      |
| `theme_builtin`         | text, null | a built-in theme key, e.g. `netrics_dark`              |
| `theme_id`              | uuid, null | a custom theme; exactly one of the two is set          |
| `accent_color`          | text, null | `#rrggbb`, overrides the theme accent (brand)          |
| `logo_image_id`         | uuid, null | shown in the header before the name                    |

`dashboard_slides`

| Column                | Type          | Notes                                                    |
| --------------------- | ------------- | -------------------------------------------------------- |
| `id`                  | uuid          |                                                          |
| `dashboard_id`        | uuid          | FK `(dashboard_id, workspace_id)`, on delete cascade     |
| `workspace_id`        | uuid          |                                                          |
| `position`            | integer       | ≥ 0, unique per dashboard (deferrable)                   |
| `name`                | text, null    | shown in the header and the editor; max 60               |
| `duration_seconds`    | integer, null | null: the dashboard default; 5–3600                      |
| `enabled`             | boolean       | default true; disabled slides are skipped by screens     |
| `background_image_id` | uuid, null    | full-slide image behind the widgets                      |
| `background_dim`      | smallint      | 0–80 (%), a theme-background overlay that keeps contrast |

`dashboard_widgets`

| Column             | Type       | Notes                                                     |
| ------------------ | ---------- | --------------------------------------------------------- |
| `id`               | uuid       | stable across saves (section 3)                           |
| `slide_id`         | uuid       | FK `(slide_id, workspace_id)`, on delete cascade          |
| `dashboard_id`     | uuid       | denormalised for queries and the FK below                 |
| `workspace_id`     | uuid       |                                                           |
| `type`             | text       | `metric`, `line`, `bar`, `image`, `text`, `clock`         |
| `x`, `y`, `w`, `h` | smallint   | checks: inside the 12 × 8 grid, `w`, `h` ≥ 1              |
| `title`            | text, null | overrides the default label; max 100                      |
| `connection_id`    | uuid, null | data widgets; FK `(connection_id, workspace_id)`, cascade |
| `metric_key`       | text, null | data widgets                                              |
| `aggregation`      | text, null | as `dashboard_tiles`                                      |
| `period`           | text, null | as `dashboard_tiles` (and whatever periods exist then)    |
| `dimensions`       | jsonb      | default `{}`; includes `resource` (#194)                  |
| `display_currency` | text, null | as #191                                                   |
| `image_id`         | uuid, null | image widgets; FK, on delete restrict                     |
| `text`             | text, null | text widgets (markdown-lite), max 500                     |
| `options`          | jsonb      | type-specific style, validated by zod per type (below)    |

A check ties columns to types: data widgets (`metric`, `line`, `bar`) have
`connection_id`, `metric_key`, `aggregation` and `period`; `image` has
`image_id`; the others have neither. A deleted connection deletes its
widgets, as it deletes tiles today.

`workspace_themes` (custom themes): `id`, `workspace_id`, `name` (unique per
workspace), `base` (the built-in it was copied from), `tokens` jsonb,
`version`, timestamps. A dashboard references it with a composite FK, on
delete restrict: deleting a theme in use answers 409 `theme_in_use` with the
dashboards that use it.

`workspace_images`: section 5.

`dashboard_tiles` stays until the migration has run in production and the
expand/contract window has closed (section 4), then a later migration drops
it.

**Limits** (server-validated, zod in `packages/contracts`): 12 slides per
dashboard, 16 widgets per slide, 48 data widgets per dashboard (today: 24
tiles), text 500 characters. They bound payload size and query cost.

**Per-slide themes: no.** One theme per dashboard keeps a rotation visually
consistent and the payload small. A slide can set a background image with
dim instead, which covers the brand-slide use. Can be added later as an
optional `theme_*` pair on slides.

### 2. Widget types (first release)

| Type     | Shows                                               | Options (`options` jsonb)                                              | Min size |
| -------- | --------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| `metric` | Today's tile: label, big value, change, sparkline   | `showSparkline` (true), `showChange` (true)                            | 3 × 2    |
| `line`   | One metric over the period, previous period dashed  | `showPrevious` (true), `showAxis` (true)                               | 4 × 3    |
| `bar`    | One metric by a dimension, top N, descending        | `groupBy` (dimension key, e.g. `resource`, `territory`), `limit` 3–10  | 4 × 3    |
| `image`  | An uploaded image or a resource icon                | `fit` (`contain`, `cover`), `align`                                    | 1 × 1    |
| `text`   | Static text, markdown-lite                          | `size` (`body`, `heading`, `display`), `align`                         | 2 × 1    |
| `clock`  | Time and optionally date in the workspace time zone | `showDate`, `hour12` (false), `timeZone` (IANA, defaults to workspace) | 2 × 1    |

Markdown-lite for `text`: paragraphs, line breaks, `#`/`##` headings,
`**bold**`, `*italic*`. No links, images or HTML; anything else is shown
literally. Both renderers implement the same small parser (shared test
vectors), and no renderer ever interprets HTML.

The bar chart needs a grouped metric query (one value per dimension value
over the period, bounded to 10 groups plus "Other"). The line chart uses the
existing `series` of the metric query plus the previous period's series.

Later, as separate issues and not in milestone 09: table, gauge,
status/health, multi-series compare (milestone 11 lists table, gauge and
health).

### 3. API

The dashboard stays a document saved as a whole with optimistic
concurrency (`version`, 409 `version_conflict`), as today.

- `GET /v1/workspaces/:w/dashboards/:id` returns the dashboard with its
  settings and `slides[]`, each with `widgets[]`. Read-only presentation
  fields stay (`resourceName`, `allResourcesName`).
- `PUT /v1/workspaces/:w/dashboards/:id` replaces settings, slides and
  widgets in one transaction. Slide and widget ids sent by the client are
  kept when they belong to this dashboard; unknown ids get new ones. Stable
  ids let screens keep their place in a rotation across saves. The service
  validates bounds, overlap, minimum sizes, type/column consistency,
  connection, metric, aggregation and resource exactly like tiles today.
- `POST /v1/workspaces/:w/dashboards` accepts the same shape. Without slides
  it creates one empty slide.
- `POST …/dashboards/:id/duplicate` copies slides and widgets.
- **Expand/contract for tiles.** For one release, responses also carry
  `tiles` (the metric widgets in reading order), and `PUT` still accepts a
  legacy `tiles` body: it replaces the widgets of a dashboard that has only
  metric widgets in the automatic layout (one slide, or two for more than
  16 tiles, as the migration lays them out). A studio
  dashboard answers 409 `studio_dashboard`, so a stale browser tab cannot
  flatten it. A later release removes `tiles`.
- Themes: `GET/POST /v1/workspaces/:w/themes` (built-ins and custom),
  `PUT/DELETE /v1/workspaces/:w/themes/:id` (version-checked).
- Images: section 5.
- Permissions reuse `dashboards:*`; themes and images need
  `dashboards:update` to change and `dashboards:view` to read. Audit events:
  `dashboard.updated` (as today), `theme.created/updated/deleted`,
  `image.uploaded/deleted`.
- Assignment stays `PATCH /v1/workspaces/:w/devices/:id` with `dashboardId`.

### 4. Migration of existing dashboards

The first studio migration takes the next free number when it is written
(0032 is expected to go to the longer-periods work, so probably 0033). It
moves data forward without user action:

1. Every dashboard gets one slide (position 0, no name, default duration),
   and the new dashboard columns get their defaults (`netrics_dark`, header
   on, auto-advance on, 20 s, fade).
2. Every tile becomes a `metric` widget with the same id, connection,
   metric, aggregation, period, dimensions, title and display currency.
3. Layout: the tiles are placed in reading order on the 12 × 8 grid with
   the column and row counts `tvGrid` picks today, restricted so every
   widget keeps the 3 × 2 metric minimum (at most 4 columns × 4 rows).
   A dashboard with more than 16 tiles gets a second slide for the rest.
   This is the one deviation from "one slide each": 17–24 tiles on one
   1080p screen fall below the readability floor of section 8. The column
   and row counts come from a lookup table for 1–24 tiles, generated from
   the domain function and checked against it in a test, because a
   migration cannot import TypeScript.
4. Devices keep their `dashboard_id`; nothing changes for assignments.

The migration is tried on a copy of data in the previous shape (dashboards
with 0, 1, 7, 16, 17 and 24 tiles, resources, display currencies), as
CLAUDE.md requires.

### 5. Images

**Stored in PostgreSQL** (`workspace_images`, bytea, RLS), not in object
storage. Self-hosting stays one database, backups include the images, RLS
and `workspace_id` predicates apply as everywhere, and a delete is
transactional. Object storage remains the deferred snapshot design
(architecture, "Apple TV and rendering"); the service goes through a small
`ImageStore` interface so a later S3 store needs no API change.

`workspace_images`: `id`, `workspace_id`, `name` (sanitised display name),
`content_type`, `bytes`, `width`, `height`, `sha256`, `content` (bytea,
`SET STORAGE EXTERNAL`: already compressed, so no TOAST compression),
`origin` (`upload` or `resource_icon`), `connection_id` and `resource_id`
for icons, `created_by_user_id`, `created_at`. Listing queries never select
`content`.

**Limits.** Raster only: PNG, JPEG and WebP. **No SVG** (script and XSS
surface) and no animation (APNG `acTL`, animated WebP). At most **1 MiB**
per image, which is also the API's body limit and the web proxy's cap
(`MAX_PROXY_BODY_BYTES`, ADR 0013), so one rule holds on every path. At most
4096 × 4096 px and 16.7 megapixels (decompression bombs on clients). At
most 100 images and 50 MiB per workspace; a runtime setting may change the
quota (runtime, not build time).

**Validation.** The upload is `POST /v1/workspaces/:w/images` with the raw
bytes and `Content-Type: image/png|jpeg|webp` (no multipart, so no new
dependency). The server:

1. checks the magic bytes match the declared type;
2. parses the header strictly (PNG `IHDR` and chunk CRCs, JPEG markers up
   to `SOF`, WebP `VP8`/`VP8L`/`VP8X`) for the dimensions;
3. **strips metadata without re-encoding**: it drops PNG `tEXt`, `zTXt`,
   `iTXt`, `eXIf` and `tIME` chunks, JPEG `APP1` (EXIF, XMP), `APP13` and
   `COM` segments, and WebP `EXIF` and `XMP ` chunks (clearing the `VP8X`
   flags), and keeps colour profiles (`iCCP`, `APP2`);
4. stores the result with its SHA-256.

Re-encoding was considered and rejected: it needs a native image library
(sharp/libvips) in the server image, a large new dependency whose decoders
would parse untrusted input on the server. The chunk filter removes the
privacy risk (GPS in EXIF); pixel data is decoded only by clients, in
browsers and tvOS ImageIO. Image bytes and names never reach logs.

**Serving.**

- Studio and web: `GET /v1/workspaces/:w/images/:id/content?v=<sha256>`.
- Devices: `GET /v1/device/images/:id?v=<sha256>` with the device's bearer
  token. It answers only for images referenced by the device's assigned
  dashboard (logo, slide backgrounds, image widgets); anything else is 404,
  so a device credential cannot enumerate the workspace's images.

Both answer with the stored `Content-Type`, `X-Content-Type-Options:
nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`,
`Content-Disposition: inline; filename="image.<ext>"`,
`Cross-Origin-Resource-Policy: same-origin`, `ETag: "<sha256>"` (304 on
`If-None-Match`) and `Cache-Control: private, max-age=31536000, immutable`.
The URL changes with the content, so caches never serve a stale image and
steady-state traffic for images is zero. The web CSP gains `img-src blob:`
for the kiosk (below).

A referenced image cannot be deleted: 409 `image_in_use` with the
dashboards that use it.
The references (`dashboards.logo_image_id`,
`dashboard_slides.background_image_id`, `dashboard_widgets.image_id`) are
composite foreign keys `(image, workspace)`, deferred to the end of the
transaction so that deleting a workspace (images and dashboards in one
statement) still works; deleting an image checks them immediately (#217).

**Resource icons ("use app icon").** An image widget, a slide background or
the dashboard logo can use a connection resource's icon instead of an
upload, for example a Wurfel app icon from App Store Connect. The connector
fetches it through `runtime.fetch` (allowlisted hosts), and it is stored as
a `resource_icon` image with the same validation and refreshed when the
connection syncs its resources. For App Store Connect the official source
is the build's `iconAssetToken` (`templateUrl` on Apple's image CDN). Which
key role may read builds is unverified: the Sales key may not. The fallback
is the iTunes Search API lookup (`artworkUrl512`, released apps only).
The implementing issue verifies both with a real key before choosing, and
pins the narrowest hosts (`is1-ssl.mzstatic.com` … `is5-ssl.mzstatic.com`).

### 6. Themes

A theme is a set of tokens. Built-ins live in `packages/domain` as data:

| Token        | Use                                         |
| ------------ | ------------------------------------------- |
| `background` | canvas                                      |
| `surface`    | widget background                           |
| `border`     | widget border                               |
| `text`       | values, headings                            |
| `label`      | widget titles                               |
| `muted`      | secondary lines, axes                       |
| `accent`     | highlights, last point, clock               |
| `up`, `down` | change in the good / bad direction          |
| `warning`    | stale and failure notices                   |
| `chartLine`  | sparklines and line charts                  |
| `chartFill`  | bars, area under lines                      |
| `fontScale`  | 1.0, 1.15 or 1.3; it never lowers a minimum |

Built-ins: **netrics Dark** (today's palette, the default and the migration
target), **Light**, **High contrast** (black, white, yellow accent),
**Midnight** (deep blue) and **Paper** (warm light). Custom themes start as
a copy of a built-in.

Contrast (WCAG 2.x relative luminance) is checked for `text`, `label` and
`muted` against `surface`, and `text` against `background`: below 4.5:1 the
editor warns; **below 3:1 the server refuses** (400 `contrast_too_low`).
That is stricter than "warn only", because a theme is used on TVs at a
distance, where low contrast makes a dashboard unreadable. The accent
override of a brand dashboard is checked the same way against `surface`
where it is used for text (the clock and highlights).

Devices receive the resolved tokens in the payload (section 7), not a theme
key, so a new built-in or an edited custom theme needs no app update.

### 7. Device payload v2

`GET /v1/device/dashboard?schema=2` returns schema 2. Without the parameter
the endpoint returns today's schema unchanged, so released tvOS builds keep
working. `DEVICE_API_VERSION` stays 1: raising it would make released apps
refuse the server. Instead the public server info gains
`dashboardSchemas: [1, 2]` (additive). A new app asks for schema 2 only
when the server lists it, so it also works against an older self-hosted
server.

```jsonc
{
  "version": "…",            // content hash, also the ETag (as today)
  "schema": 2,
  "refreshAfterSec": 60,
  "timeZone": "Europe/Berlin",
  "dashboard": { "id": "…", "name": "Wurfel", "showHeader": true,
                 "logo": { "imageId": "…" } } ,   // or null when none assigned
  "theme": { "name": "netrics Dark", "tokens": { "background": "#07090c", … } },
  "rotation": { "autoAdvance": true, "transition": "fade" },
  "grid": { "columns": 12, "rows": 8 },
  "slides": [{
    "id": "…", "name": "Sales", "durationSec": 20,
    "background": { "imageId": "…", "dim": 40 },   // or null
    "widgets": [
      { "id": "…", "type": "metric", "x": 0, "y": 0, "w": 4, "h": 3,
        "label": "Downloads · Wurfel", "options": { … },
        "data": { /* today's tile fields: value, unit, conversion, change,
                     spark, kind, granularity, better, status, updatedAt,
                     period, aggregation */ } },
      { "type": "line",  "data": { "points": [[t, v], …], "previous": [[t, v], …], "unit": "count", "status": "ok", … } },
      { "type": "bar",   "data": { "bars": [{ "label": "Wurfel", "value": 812 }, …], "unit": "count", … } },
      { "type": "image", "imageId": "…", "options": { "fit": "contain" } },
      { "type": "text",  "text": "## Wurfel\nDaily numbers", "options": { … } },
      { "type": "clock", "options": { "showDate": true } }
    ]
  }],
  "images": [{ "id": "…", "sha256": "…", "contentType": "image/png",
               "width": 512, "height": 512, "bytes": 48213,
               "url": "/v1/device/images/…?v=…" }]
}
```

Only enabled slides are sent. Labels are resolved on the server
(`tileLabel`, #194/#208), as today. A data widget that fails reports
`no_data` and never fails the dashboard.

**Schema 1 compatibility.** Old clients get `tiles`: the metric widgets of
all enabled slides in reading order (slide, then `y`, then `x`), at most 24.
For a migrated dashboard that is exactly today's tile list. Non-metric
widgets are left out.

**Rotation is client-side.** Screens advance through slides by their
`durationSec` and keep polling on `refreshAfterSec` with `If-None-Match`, as
today. A new payload keeps the current slide when its id still exists,
otherwise it starts at the first. Offline, a screen keeps rotating its
cached payload. The clock widget ticks locally; it does not change the
`ETag`.

**Performance.** Images are references, never inline; the payload stays
well below 256 KB (48 data widgets, a few hundred points each, are about
60 KB). Several screens showing the same dashboard should not multiply the
query work: the server memoises the computed payload per
`(workspace, dashboard, dashboard version, schema)` for up to 30 seconds
in-process. Data freshness is unchanged, because syncs run at most every
few minutes. Devices cache images by `sha256`: tvOS on disk next to the
cached payload (least recently used beyond 50 MB is evicted), the browser
kiosk in Cache Storage, fetched with the bearer token and shown through
`blob:` URLs. Only images whose hash is not cached are downloaded.

### 8. Rendering rules (TV readability)

One layout and type scale, written once in `packages/domain`
(`studioLayout`) and ported to Swift, with shared JSON test vectors that
both test suites run, so the web and tvOS place and size text identically.

- **Units.** Sizes are in canvas units: `u = canvas height / 1080`, so 1080p
  and 4K read the same. `fontScale` multiplies sizes and never lowers a
  minimum.
- **Minimum text sizes** (at `u = 1`): any text 24, widget title 30,
  resource line 30 (semibold), change line 28, chart axis labels 24, text
  widget body 32, heading 56, display 96, metric value at least 64 and as
  large as fits, clock at least 56. The minimum widget sizes in section 2
  are chosen so these fit.
- **Titles are never cut silently.** The title and the resource line wrap
  to at most two lines each. Renderers shrink to the minimum size and only
  then, as a last resort, truncate at the end with an ellipsis. The studio
  prevents that case: `studioLayout.fits(label, widget)` estimates each
  widget's effective label (title or metric name plus resource name) at
  1080p with conservative glyph widths and flags any widget that would
  truncate. Values are never truncated: they scale down to fit and switch
  to a compact form (`12.3k`) before that.
- **Images** keep their aspect ratio (`contain` or `cover`) and are
  downsampled to the widget's pixel size on decode (tvOS ImageIO
  thumbnails, web `<img>` with explicit size).
- **Status notices** (stale, auth failed, outage) keep today's wording and
  colours from the theme's `warning` token.
- **Motion.** Fade transitions last 400 ms. With Reduce Motion (tvOS) or
  `prefers-reduced-motion` (web) slides switch without animation. Nothing
  else animates.

### 9. Editor ("Studio")

- **Flow.** Dashboards list → studio: a slide rail (add, duplicate, reorder
  by drag and by keyboard, enable, delete, duration), a 16:9 canvas with the
  grid, and an inspector for the selected widget (type, data binding,
  style, title) or slide or dashboard (rotation, header, theme, accent,
  logo). Changes are saved with an explicit **Save** (the version is
  checked; a conflict offers reload or saving as a copy). There is no
  autosave: screens show a dashboard as soon as it is saved, so a
  half-edited state would reach the TVs. Drafts and publishing are a later
  option.
- **Preview and Play.** The canvas renders with the same web widget
  renderers as `/tv` and the kiosk, with live data. "Play" runs the rotation
  full-screen in the browser. "Show on TVs" assigns the dashboard to paired
  devices with the existing assignment.
- **Grid editing: own implementation, no library.** Pointer events with
  pointer capture move and resize widgets, snapping to cells; a move that
  would overlap is refused, with the target outline in the warning colour.
  The grid is small and fixed (12 × 8, at most 16 widgets), so collision
  checks are trivial and no general layout engine is needed. The web app
  has no UI dependency today; libraries considered (`react-grid-layout`,
  `@dnd-kit`, `gridstack`) bring general responsive layout or
  sortable-list machinery we would not use, and each new pinned dependency
  is upgrade and supply-chain work. Slide reordering uses the same pointer
  code plus keyboard moves.
- **Accessibility.** Every widget on the canvas and every slide in the rail
  is focusable. Arrow keys move the selected widget by one cell,
  Shift+Arrow resizes it, Alt+Arrow reorders slides. Changes are announced
  in a polite live region ("Downloads moved to column 5, row 2"). Inspector
  controls are labelled form controls. Focus outlines use the accent. The
  editor works without a pointer.
- **Templates (few clicks).** "New dashboard" offers **Overview** (built
  from the workspace's connections: downloads of all apps, proceeds in the
  display currency, Search Console clicks and impressions, Vercel visitors
  when connected, ratings and reviews) and **Brand** (pick a resource such
  as one app: its icon as the logo, its metrics filtered to it, an accent
  colour). Templates are generated server-side, like the onboarding
  dashboard (#51), and are ordinary dashboards afterwards.

## Alternatives considered

- **Keep tiles and add an ordered "pages" list without a grid.** It is
  simpler, but brand slides need a logo next to numbers, and charts need
  more space than a tile. Rejected.
- **Free positioning (pixels or percent).** Layouts would differ between
  1080p, 4K and browser sizes, and readability minimums could not be
  enforced. Rejected for a fixed grid.
- **Server-rendered slides** (snapshots, ADR 0007). It is still the
  heaviest path for self-hosters (Chromium, object storage). Native
  rendering stays.
- **Bumping `DEVICE_API_VERSION` to 2.** Released apps would refuse the
  server. Rejected for a schema parameter and `dashboardSchemas` in server
  info.
- **Schema 1 `tiles` from the first slide only.** It is more faithful to a
  designed first slide, but a dashboard that starts with a brand slide
  would show nothing. Rejected for all metric widgets, capped at 24.
- **Images in object storage (S3 or a volume).** It adds a service and a
  backup path for self-hosters for a few megabytes per workspace. Revisit
  when snapshots or exports need object storage anyway.
- **Accepting SVG** (for crisp logos). It is the main XSS vector for
  uploaded images, and sanitising SVG reliably is hard. Rejected; a
  1024 px PNG is sharp on a 4K TV at widget size.
- **Re-encoding uploads** (sharp/libvips). See section 5.
- **A 2 MB upload limit**, as first proposed. It would need a raised body
  limit on one API route and the web proxy. 1 MiB is enough for a logo and
  for a JPEG background at 4K, and keeps one limit everywhere.
- **Per-slide themes.** Possible later; not needed for the first
  dashboards.
- **Autosave in the studio.** Unfinished edits would appear on TVs.

## Consequences

- Widget types are implemented twice (web and SwiftUI), as with tiles. The
  shared layout module and test vectors keep the two in step; every new
  widget type needs both renderers and the vectors before it ships.
- The device contract gains a second schema. Schema 1 stays until no
  supported tvOS build needs it (tracked with the tvOS release notes).
- `dashboard_tiles`, the tile API fields and `tvGrid` (except for the
  schema 1 fallback in the apps) are removed in a later contract step.
- Workspace storage grows by up to 50 MiB of images per workspace in
  PostgreSQL; backups grow accordingly. The quota is documented for
  self-hosters.
- Milestone 11's widget list shrinks: bar ships here; table, gauge and
  health build on this widget model.
