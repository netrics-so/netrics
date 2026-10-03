# Milestone 09 — Dashboard Studio

## Outcome

A user builds dashboards in a web Studio: several slides per dashboard,
different widgets on each (metric, line chart, bar chart, image, text,
clock) with their own data, title and style, a theme, a brand logo and
accent, and a rotation. The same dashboards play on the Apple TV, the
browser kiosk and the web TV mode, readable from a distance. Existing
dashboards keep working without any user action.

Design: [ADR 0015](../decisions/0015-dashboard-studio.md).

## Dependencies

- Milestones 04 (dashboards), 06 (Apple TV and kiosk) and 08 (App Store
  Connect, for app icons and the brand dashboards)

## In scope

- Slides and widgets on a 12 × 8 grid per 16:9 slide; migration of every
  tile dashboard
- Widget types: metric, line, bar, image, text (markdown-lite), clock
- Built-in themes (netrics Dark, Light, High contrast, Midnight, Paper),
  workspace custom themes with a contrast check, brand accent and logo
- Workspace images in PostgreSQL: PNG, JPEG and WebP up to 1 MiB, metadata
  stripped, device-scoped access; app icons as an image source
- Device payload schema 2 with rotation on the client; schema 1 kept for
  released tvOS builds
- Web Studio: slide rail, canvas with move and resize, inspector, theme
  editor, Play, "Show on TVs"
- Templates: Overview and Brand
- TV readability rules shared by web and tvOS

## Out of scope

- Table, gauge, status/health and multi-series compare widgets (milestone 11
  and later issues)
- Per-slide themes, drafts and publishing, autosave
- SVG images, animated images, video
- Server-rendered snapshots (ADR 0007 stays)
- Public sharing of studio dashboards (milestone 15)

## Issues

Each issue is independently mergeable in this order. Every schema issue
takes the **next free migration number when it is implemented**; 0032 is
expected to go to the longer-periods work, so the first studio migration is
probably 0033. Issues #214, #216 and #217 each add a migration; whichever
merges later renumbers.

| #    | Issue                                                                    | Depends on              | Wave |
| ---- | ------------------------------------------------------------------------ | ----------------------- | ---- |
| #213 | Design: ADR 0015 and this plan                                           | –                       | 0    |
| #214 | Model: slides and widgets schema, tile migration, dashboard document API | #213                    | 1    |
| #215 | Shared layout and readability spec (`studioLayout`) with test vectors    | #213                    | 1    |
| #216 | Themes: built-ins, custom themes API, contrast check, theme editor       | #213 (#214 for columns) | 1    |
| #217 | Workspace images: upload, validation, metadata stripping, serving        | #213 (#214 for columns) | 1    |
| #218 | Metric queries for charts: line with previous period, bar breakdown      | #213                    | 1    |
| #219 | Device payload v2; schema 1 kept                                         | #214, #216, #217, #218  | 2    |
| #220 | Web widget renderers and themes                                          | #214, #215, #216, #218  | 2    |
| #221 | Kiosk and web TV mode on payload v2 with rotation                        | #219, #220              | 3    |
| #222 | tvOS: slides, rotation, widget renderers, themes, image cache            | #215, #219              | 3    |
| #223 | Studio shell: list, slide rail, settings, save, Play, assign to TVs      | #214, #220              | 3    |
| #224 | Studio canvas: move, resize, snap, keyboard, no overlap                  | #223, #215              | 4    |
| #225 | Studio inspector: widget types, data binding, style, image picker        | #223, #217, #218        | 4    |
| #226 | Templates (Overview, Brand) and app icons as images                      | #217, #214; UI #223     | 4    |
| #227 | Exit gate                                                                | all                     | 5    |

**Parallel work.** Wave 1 (#214–#218) runs in parallel; #216 and #217 add
their dashboard columns after #214 has merged. The App Store Connect icon
spike in #226 can start at any time. In wave 2, #219 and #220 run in
parallel. In wave 3, #221, #222 and #223 run in parallel (the tvOS work
needs only the payload). In wave 4, #224, #225 and #226 run in parallel.

## Security invariants

- Every new table is under RLS, and every query has explicit `workspace_id`
  predicates; cross-workspace tests for each table and route.
- Images: raster only, magic bytes and a strict header parse, no SVG or
  animation, metadata stripped, served with `nosniff`, a sandboxing CSP and
  a generic file name; bytes and names never logged.
- A device credential reads only the images its assigned dashboard
  references.
- Text widgets never interpret HTML on any client.
- Themes below 3:1 contrast for text are refused.

## Verification

- Every existing dashboard shows the same tiles on web, kiosk and tvOS
  after the migration, with no user action; released tvOS builds keep
  working on schema 1.
- A dashboard with every widget type renders identically (positions and
  text sizes) on web and tvOS at 1080p and 4K; long titles and app names
  are fully readable.
- Rotation follows the configured durations; a saved change reaches a TV
  within one poll; an offline restart shows the cached slides and images.
- Uploading a JPEG with GPS EXIF stores it without the GPS data; an SVG,
  an animated or an oversized image is refused.
- The Studio is usable with the keyboard alone.
- Self-hosted Compose has the same features with no extra service.

## Exit gate

In production, build the **Overview** dashboard and the **Wurfel**,
**voilà** and **Paperstand** brand dashboards (logo image, brand accent,
own metrics, several slides, rotation, one custom theme), and play them on
the **physical Apple TV** and a **web kiosk**. Every title and app name is
readable from viewing distance, rotation and remote changes work, and an
offline restart shows cached slides and images (#227).
