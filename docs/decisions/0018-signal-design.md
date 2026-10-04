# 0018 — Signal: the netrics visual identity

Status: accepted (2026-10-04, owner decision; milestone 09.3, #300–#313)

## Context

The web admin grew page by page from milestone 02 on. It is dark, set in the
system font, with about 235 hard-coded colours in one stylesheet and no
shared tokens; one workspace page carries dashboards, TVs, connections and
projects; the navigation is a top bar with two links. The TV renderer
(ADR 0015, ADR 0017) is correct and readable, but flat: one surface colour,
no sense of freshness beyond a notice when data is stale, and no motion
apart from a slide fade.

The people netrics is for are marketing and SEO users who are not
technical. They should find their way without a manual, and a screen on the
office wall should look finished.

The owner delivered a high-fidelity design handoff, "Signal", on 2026-10-04:
a light, warm admin with a full-sitemap sidebar, and a dark, layered,
animated TV widget set within ADR 0015. This ADR records its decisions in
substance; colours and sizes below are the design intent.

## Decision

### 1. Two surfaces, one identity

- **Admin** ("Signal"): light, warm paper, white surfaces, one teal accent.
  It is the place where people build and manage.
- **TV** ("netrics Dark, polished"): the dashboard theme decides the
  colours, as in ADR 0015; the built-in netrics Dark is the reference. TV
  surfaces stay dark inside the admin too (Studio canvas, previews,
  thumbnails), so what the user edits is what the wall shows.

### 2. Admin tokens

CSS custom properties on `:root` in `apps/web/src/app/globals.css`; no
component hard-codes a colour.

| Token                     | Value                                              | Use                               |
| ------------------------- | -------------------------------------------------- | --------------------------------- |
| paper                     | `#f6f4f0`                                          | page background, rails            |
| surface                   | `#ffffff`                                          | cards, panels, inputs             |
| raised                    | `#faf9f6`                                          | slide rail, secondary panels      |
| chip                      | `#f0ece4`                                          | neutral chips                     |
| border / border-strong    | `#e4e0d8` / `#dcd6ca`                              | hairlines, empty rings            |
| text / text-2             | `#1c1b19` / `#4b4740`                              | primary and body text             |
| muted / faint             | `#6f6a62` / `#9a948a`                              | meta text, disabled               |
| accent / accent-text      | `#0b8a85` / `#0b6f6b`                              | primary actions, links, selection |
| accent-tint / accent-wash | `#e6f4f3` / `#f0faf9`                              | active nav, chips, selected cards |
| success                   | `#22a06b`                                          | online, healthy                   |
| warning                   | `#d9a400`                                          | attention border and dots         |
| warning text / tints      | `#7a5a00` / `#fdf1c7`, `#fffbea`, border `#f1dc8a` | attention states                  |
| danger                    | `#b3261e`                                          | offline, destructive              |

- **Type**: Manrope 400–800. Sizes 11, 12, 13, 13.5, 14, 15, 20, 22, 24, 26;
  page titles 24/800 with −0.02em tracking; section labels 12/700 caps with
  0.06em tracking.
- **Radii**: 6 small chips, 8 nav rows, 10 buttons and inputs, 12–14 cards,
  999 pills.
- **Selection**: a 1.5 px accent border plus a 3 px accent ring at 15 %
  (screens, dashboards, slides, widgets, source cards).
- **Toggles**: 30 × 18 pills for boolean settings.
- Body text on paper and surface keeps a contrast of at least 4.5.

### 3. Fonts are self-hosted

The content security policy allows fonts from `'self'` only, and builds must
not depend on the network (ADR 0013: one source, same commit). Fonts are
vendored as woff2 subsets with their OFL licences and loaded with
`next/font/local`: **Manrope** (admin), **IBM Plex Sans** (web TV
rendering) and **JetBrains Mono** (pairing codes, keys). tvOS uses the
system font (SF Pro).

### 4. Navigation: full-sitemap sidebar

A 248 px sidebar with the whole product map, so non-technical users see
everything netrics does: Home; Dashboards; Sources; Screens; Team;
Settings, with the workspace switcher under the brand. A 56 px top bar
carries the source-health summary and the account. The Studio collapses
the sidebar into a 56 px icon rail; TV, kiosk and Play stay chrome-free.
Phones get the sidebar as a drawer.

The sidebar lists **only destinations that exist**. Playlists, schedules,
alerts, templates and image libraries join it with their features; there
are no "coming soon" links. Each area gets its own route instead of the
current all-in-one workspace page; old URLs keep working.

### 5. TV widgets: depth and freshness

Within ADR 0015 (12 × 8 grid, slides, themes, readability minimums):

- **Layered surfaces**: a vertical gradient, a 1 px inner highlight, a
  hairline border and a soft shadow. They are **derived in the renderer**
  from the theme's `surface`, `border` and `background` tokens
  (`color-mix`), not new theme tokens, so custom themes, the theme editor,
  contrast checks and released tvOS payloads stay unchanged. Flat themes
  (high contrast, paper) derive flat surfaces.
- **netrics Dark** changes `chartLine` and `chartFill` to `#7aa2f7`; the
  other built-in themes keep their values.
- **Freshness everywhere**: every data widget shows "updated N min ago ·
  Source"; the header shows the next refresh as a countdown with a thin
  progress bar; stale data shows a warning footer with a blinking dot; the
  slide footer shows progress and the next slide's name.
- **Figures**: values and clocks use tabular figures so counting and
  ticking do not shift the layout.
- **Readability wins**: every size stays at or above the ADR 0015 §8
  minimums at 1080p. Where the design's small meta text (footers, column
  heads) is below 24 u, it is set at 24 u.
- **Data states** get their own surfaces: stale (warning border, dimmed
  value), auth failed (danger surface, "Reconnect …"), no data and
  backfilling (dashed border, skeleton).
- Grid geometry (`STUDIO_SPACING`, header band) is **unchanged** in this
  milestone; it is shared with tvOS through test vectors, and the design
  fits the current spacing.

### 6. Motion (amends ADR 0015 §8)

ADR 0015 §8 said "nothing else animates" besides the 400 ms slide fade. It
now reads:

- **Slide enter**, on every slide change including the first paint:
  1200 ms, ease-out cubic (`1 − (1 − t)³`). Values count up from zero;
  sparklines, lines and gauge arcs draw (`pathLength`-based dash offset);
  bars grow; area fills fade in; table rows rise 14 u with a 90 ms stagger;
  end-point dots appear when the draw completes. After that the slide is
  still.
- **Continuous**, and only these: a pulse on a chart's last point (2.4 s),
  a blink on the stale indicator (1.8 s), the skeleton sweep (1.6 s).
- Slide fade 400 ms; progress bars move linearly.
- With **Reduce Motion** (tvOS) or `prefers-reduced-motion` (web), all of
  the above is skipped and the final state shows at once.
- Motion never changes layout, and the Studio canvas shows the final state
  while editing.

### 7. What the design does not change

- **Pairing** keeps the server's code format and lifetime (ADR 0011); the
  design's short code was illustrative. The pairing screen adopts the
  palette, the label and a real QR code of the approval URL.
- **Sign-in** stays email and password; Google and passkey sign-in are
  separate decisions with their own backend work.
- **New widget types** shown in the design (gauge and goal, status board,
  table, compare, review, countdown, clock with date) need data bindings,
  minimum sizes and shared vectors; they are a follow-up design pass (#312),
  not part of this milestone.
- Playlists, schedules, alerts, global search and a map view of screens
  arrive with their features.

## Alternatives considered

- **Keep the dark admin and restyle it.** Rejected: the owner chose a
  light, warm admin for non-technical users; dark stays for the TV.
- **A component library or utility CSS framework.** Rejected for now: the
  app has one stylesheet and server-rendered tests that assert class names;
  tokens plus the existing class names restyle everything with no new
  runtime dependency. `packages/ui` stays a placeholder.
- **New theme tokens for gradients and highlights.** Rejected: every token
  touches domain, contracts, contrast checks, stored custom themes and the
  Swift payload; deriving them keeps one source of truth.
- **Fonts from a CDN.** Rejected by the CSP and by build reproducibility.

## Consequences

- One stylesheet becomes token-based; every later screen uses the tokens.
- The workspace page splits into area pages; links and tests that point at
  it are updated.
- The TV renderer gains a clock-driven enter animation on web and tvOS; it
  must stay cheap on Apple TV HD and in kiosks.
- `fits` keeps conservative glyph widths; IBM Plex Sans is checked against
  them.
- Plan and issues: [milestone 09.3](../milestones/09.3-signal-design.md).
